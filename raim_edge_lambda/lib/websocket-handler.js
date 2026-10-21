'use strict';

// ==============================================================================
// API Gateway WebSocket Handler
// ==============================================================================
//
// API Gateway WebSocketから呼ばれるイベントを処理する。
//
// $connect:
//   Cognito Authorizerで認証済みのユーザーsubとconnectionIdをDynamoDBへ保存する。
//
// $disconnect:
//   connectionIdをDynamoDBから削除する。
//
// $default:
//   クライアントから送られたJSON本文をCore Lambda用Request Queueへ投入する。
//
// このLambdaではMantle/Titanは呼ばない。
// Edge Lambdaは入口として素早く受付応答を返し、重い処理はCore Lambdaへ任せる。

const { createConnectionStore } = require('./connection-store');
const { createRequestQueuePublisher } = require('./request-queue-publisher');
const { normalizeWebSocketEvent, WebSocketEventError } = require('./websocket-event');
const { createWebSocketPostback } = require('./websocket-postback');
const threadListStore = require('./thread-list-store');
const userSessionStore = require('./user-session-store');
const crypto = require('crypto');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const {
  createAcceptedResponse,
  createHttpResponse,
  createOkResponse,
} = require('./websocket-response');

function createWebSocketHandler({
  connectionStore,
  requestPublisher,
  postback,
  threadStore,
  sessionStore,
  sqsClient,
  memoryQueueUrl,
  now = () => Date.now(),
} = {}) {
  // 接続テーブルは $default のたびに読むので、作ったものを使い回す
  let cachedConnectionStore = null;
  const getConnectionStore = () =>
    connectionStore || (cachedConnectionStore ||= createConnectionStore());
  const getRequestPublisher = () => requestPublisher || createRequestQueuePublisher();

  // スレッド一覧・履歴は SQS を経由せず、Edge が DynamoDB を直接読んで
  // WebSocket へ書き戻す。そのため postback と thread store が必要。
  const getPostback = () => postback || createWebSocketPostback();
  const getThreadListStore = () => threadStore || threadListStore;
  const getUserSessionStore = () => sessionStore || userSessionStore;

  // スレッド削除後にユーザー記憶の再生成を依頼するために使う
  let cachedSqs = null;
  const getSqsClient = () => {
    if (sqsClient) return sqsClient;
    cachedSqs ||= new SQSClient({
      region: process.env.AWS_REGION || 'ap-northeast-1',
    });
    return cachedSqs;
  };

  async function handleConnect(normalized) {
    await getConnectionStore().putConnection({
      connectionId: normalized.connectionId,
      sub: normalized.sub,
      domainName: normalized.domainName,
      stage: normalized.stage,
      // 接続に使ったアクセストークンの期限（秒）。$default で毎回確かめる
      tokenExpiresAt: normalized.tokenExpiresAt,
    });

    return createOkResponse({
      type: 'connected',
      connectionId: normalized.connectionId,
    });
  }

  async function handleDisconnect(normalized) {
    await getConnectionStore().deleteConnection(normalized.connectionId);

    return createOkResponse({
      type: 'disconnected',
    });
  }

  /**
   * スレッド一覧を返す。
   *
   * SQS を経由しないため、そのまま WebSocket へ結果を書き戻す。
   * 一覧取得に失敗しても接続は維持し、エラーメッセージだけ返す。
   */
  async function handleThreadList(sub, normalized) {
    try {
      const threads = await getThreadListStore().listThreads(sub);

      // postJson(connectionId, payload) が公開API。
      // エンドポイントは createWebSocketPostback が env から解決するため、
      // domainName / stage をここで渡す必要はない。
      await getPostback().postJson(normalized.connectionId, {
        type: 'thread_list',
        requestId: normalized.requestId,
        threads,
      });

      return createAcceptedResponse({
        type: 'accepted',
        requestId: normalized.requestId,
      });
    } catch (error) {
      console.error(`[ThreadList] failed: ${error.message}`);

      return createHttpResponse(500, {
        code: 'THREAD_LIST_FAILED',
        message: 'Failed to list conversation threads',
      });
    }
  }

  /**
   * スレッドの会話履歴を返す。
   *
   * 過去スレッドを選び直したとき、画面にメッセージを復元するために使う。
   * 一覧と同じく読み取りのみなので Edge で直接処理する。
   *
   * 応答サイズは store 側で 32KB フレーム制限に収まるよう調整済み。
   * 打ち切られた場合は hasMore=true が返る。
   */
  async function handleThreadHistory(sub, normalized) {
    if (!normalized.threadId) {
      return createHttpResponse(400, {
        code: 'INVALID_INPUT',
        message: 'threadId is required for thread.history',
      });
    }

    try {
      const history = await getThreadListStore().getThreadHistory(
        sub,
        normalized.threadId,
        // 未指定なら最新側から。指定されるとその手前（より古い側）を返す
        normalized.beforeIndex === null
          ? {}
          : { beforeIndex: normalized.beforeIndex }
      );

      if (!history) {
        return createHttpResponse(404, {
          code: 'THREAD_NOT_FOUND',
          message: 'Conversation thread was not found',
        });
      }

      await getPostback().postJson(normalized.connectionId, {
        type: 'thread_history',
        requestId: normalized.requestId,
        ...history,
      });

      return createAcceptedResponse({
        type: 'accepted',
        requestId: normalized.requestId,
      });
    } catch (error) {
      console.error(`[ThreadHistory] failed: ${error.message}`);

      return createHttpResponse(500, {
        code: 'THREAD_HISTORY_FAILED',
        message: 'Failed to load conversation history',
      });
    }
  }

  /**
   * スレッドを削除する。
   *
   * 【ユーザー記憶も作り直す理由】
   *
   * 会話の内容は2箇所に残る。
   *
   *   ConversationThread … 本文とスレッド要約（削除で消える）
   *   UserSession.userMemory … スレッドを跨いだ記憶（削除しても残る）
   *
   * userMemory は各スレッドの要約を集約したものなので、スレッドだけ消すと
   * 「消したのにライムが覚えている」状態になる。
   * そのため、削除の完了を返す前に userMemory を空にする（世代番号も進める）。
   * 残っているスレッドからの記憶の作り直しは Summary Lambda へ依頼する。
   *
   * 順番は「スレッドを消す → 記憶を空にする → 作り直しを依頼」。
   * 記憶を先に空にすると、その直後に始まった作り直しが、まだ消えていない
   * スレッドを読んで、世代番号も新しいまま古い内容を書き込めてしまう。
   *
   * 記憶を空にできなくても、作り直しを依頼できれば消したスレッドの内容は
   * 記憶から抜ける（残っているスレッドだけから作り直すため）。どちらも
   * できなかったときだけ失敗を返す。スレッドは消えているので、やり直すと
   * 削除はそのまま通り、記憶だけ空にし直せる。
   */
  async function handleThreadDelete(sub, normalized) {
    if (!normalized.threadId) {
      return createHttpResponse(400, {
        code: 'INVALID_INPUT',
        message: 'threadId is required for thread.delete',
      });
    }

    try {
      await getThreadListStore().deleteThread(sub, normalized.threadId);

      // 消した会話の内容が記憶に残らないよう、完了を返す前に空にする
      let memoryCleared = false;
      try {
        await getUserSessionStore().clearMemoryForDeletion(sub);
        memoryCleared = true;
      } catch (error) {
        console.error(`[ThreadDelete] could not clear userMemory: ${error.message}`);
      }

      // 残っているスレッドから記憶を作り直してもらう
      let memoryRefreshRequested = false;
      try {
        memoryRefreshRequested = await requestMemoryRefresh(sub);
      } catch (error) {
        console.warn(`[ThreadDelete] memory refresh request failed: ${error.message}`);
      }

      if (!memoryCleared && !memoryRefreshRequested) {
        // 消した会話の内容が記憶に残ったままになるので、成功とは返さない
        return createHttpResponse(500, {
          code: 'THREAD_DELETE_FAILED',
          message: 'The thread was deleted but its memory could not be cleared',
        });
      }

      await getPostback().postJson(normalized.connectionId, {
        type: 'thread_deleted',
        requestId: normalized.requestId,
        threadId: normalized.threadId,
        // 記憶をもう空にしたか（false でも作り直しの依頼は出ている）
        memoryCleared,
        memoryRefreshRequested,
      });

      return createAcceptedResponse({
        type: 'accepted',
        requestId: normalized.requestId,
      });
    } catch (error) {
      console.error(`[ThreadDelete] failed: ${error.message}`);

      return createHttpResponse(500, {
        code: 'THREAD_DELETE_FAILED',
        message: 'Failed to delete conversation thread',
      });
    }
  }

  /**
   * Summary Lambda へユーザー記憶の再生成を依頼する。
   *
   * キューが未設定なら何もしない。
   * （週次バッチが作り直すのは、その週に要約されたスレッドがある人だけなので、
   *  キューは必ず設定しておくこと）
   */
  async function requestMemoryRefresh(sub) {
    const queueUrl = String(
      (memoryQueueUrl ?? process.env.SUMMARY_REQUEST_QUEUE_URL) || ''
    ).trim();

    if (!queueUrl) {
      console.warn('[ThreadDelete] SUMMARY_REQUEST_QUEUE_URL is not set; skipping refresh');
      return false;
    }

    await getSqsClient().send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({
          type: 'memory.refresh',
          sub,
          reason: 'thread_deleted',
          requestedAt: new Date().toISOString(),
        }),
        // ユーザー単位で順序を保つ
        MessageGroupId: sub,
        // 削除ごとに一意にする。
        // 以前は `memory-refresh:${sub}` 固定だったため、5分以内に
        // 2つ目のスレッドを削除すると2回目の依頼が重複排除で捨てられ、
        // 消したはずの内容が userMemory に残っていた。
        // 時刻だけだと同じミリ秒の削除が重なったときに同じ値になるので、乱数も足す。
        // （128文字の上限があるので sub はハッシュにする）
        MessageDeduplicationId: crypto
          .createHash('sha256')
          .update(`memory-refresh:${sub}:${crypto.randomUUID()}`)
          .digest('hex'),
      })
    );

    return true;
  }


  async function handleDefault(normalized) {
    let sub = normalized.sub;

    // WebSocket APIでは、認証情報が `$connect` には存在しても、
    // 後続の `$default` イベントに毎回含まれるとは限らない。
    // そのため `$connect` 時に保存した接続テーブルからsubを補完する。
    // トークンの期限も、Authorizer の context に無ければ接続テーブルから読む。
    let tokenExpiresAt = Number(normalized.tokenExpiresAt || 0);
    if (!sub || !tokenExpiresAt) {
      let connection = null;
      try {
        connection = await getConnectionStore().getConnection?.(normalized.connectionId);
      } catch (error) {
        console.error(`[Connection] lookup failed: ${error.message}`);
        if (!sub) {
          return createHttpResponse(500, {
            code: 'CONNECTION_LOOKUP_FAILED',
            message: 'Failed to look up the connection',
          });
        }
      }
      if (!sub) {
        sub = String(connection?.sub || '').trim();
      }
      if (!tokenExpiresAt) {
        tokenExpiresAt = Number(connection?.tokenExpiresAt || 0);
      }
    }

    if (!sub) {
      return createHttpResponse(401, {
        code: 'UNAUTHORIZED',
        message: 'Cognito sub is required',
      });
    }

    // 接続したときのトークンの期限が切れていたら受け付けない。
    //
    // API Gateway の認証は接続するとき（$connect）にしか走らない。
    // 以前は一度つながると、トークンが切れても接続が続く限り（最大2時間）使えた。
    // クライアントには理由を送ってから切断する。クライアントは新しいトークンでつなぎ直す。
    // 期限を持っていない古い接続は、これまでどおり通す。
    if (tokenExpiresAt > 0 && now() / 1000 >= tokenExpiresAt) {
      return rejectExpiredToken(normalized);
    }

    // ─────────────────────────────────────────────
    // スレッド一覧（読み取りのみ）は Edge で直接処理する
    // ─────────────────────────────────────────────
    //
    // DynamoDB の Query 1回で終わるため、SQS 経由にすると
    // Lambda 起動が3回必要になり不釣り合いに遅い。
    // LLM 処理を伴う重い要求だけを非同期（SQS）にする方針。
    if (normalized.action === 'thread.list') {
      return handleThreadList(sub, normalized);
    }

    // 過去スレッドを開き直したときの履歴復元。これも読み取りのみ。
    if (normalized.action === 'thread.delete') {
      return handleThreadDelete(sub, normalized);
    }

    if (normalized.action === 'thread.history') {
      return handleThreadHistory(sub, normalized);
    }

    // Core Lambdaが必要とする最小イベント形式に変換してRequest Queueへ送る。
    // Core側のcore-event.jsは、このpayloadを `source: websocket` として受け取る。
    const request = await getRequestPublisher().publishChatRequest({
      requestId: normalized.requestId,
      connectionId: normalized.connectionId,
      sub,
      text: normalized.text,
      images: normalized.images,
      // クライアントが会話スレッドを指定した場合のみ入る。
      // 未指定なら Core が activeThreadId を使うか新規作成する。
      threadId: normalized.threadId,
      // クライアントが使える機能（駅アラームなど）。Core がツールの出し分けに使う
      features: normalized.features,
      // 現在地（約10kmに丸めたもの）。天気の場所が指定されないときだけ使う
      location: normalized.location,
      // アプリで声を消しているときは false（Core が読み上げを作らない）
      speech: normalized.speech,
    });

    // WebSocketの入口では「受付完了」だけを返す。
    // 実際の生成結果は、Core Lambda -> Response Queue -> Edge Lambda -> WebSocketで後続送信される。
    return createAcceptedResponse({
      type: 'accepted',
      requestId: request.requestId,
    });
  }

  /**
   * トークンの期限切れを伝えて、接続を切る。
   */
  async function rejectExpiredToken(normalized) {
    const postback = getPostback();

    try {
      await postback.postJson(normalized.connectionId, {
        type: 'error',
        code: 'TOKEN_EXPIRED',
        requestId: normalized.requestId,
        message: 'Access token has expired. Please reconnect.',
      });
    } catch (error) {
      console.warn(`[Auth] could not notify token expiry: ${error.message}`);
    }

    try {
      await postback.disconnect?.(normalized.connectionId);
    } catch (error) {
      console.warn(`[Auth] could not close expired connection: ${error.message}`);
    }

    return createHttpResponse(401, {
      code: 'TOKEN_EXPIRED',
      message: 'Access token has expired',
    });
  }

  return async function handleWebSocketEvent(event, context = {}) {
    let normalized;

    try {
      normalized = normalizeWebSocketEvent(event, context);
    } catch (error) {
      if (error instanceof WebSocketEventError) {
        return createHttpResponse(400, {
          code: error.code,
          message: error.message,
          details: error.details,
        });
      }

      throw error;
    }

    switch (normalized.routeKey) {
      case '$connect':
        return handleConnect(normalized);

      case '$disconnect':
        return handleDisconnect(normalized);

      case '$default':
      default:
        return handleDefault(normalized);
    }
  };
}

function handleWebSocketEvent(event, context = {}) {
  return createWebSocketHandler()(event, context);
}

module.exports = {
  createWebSocketHandler,
  handleWebSocketEvent,
};
