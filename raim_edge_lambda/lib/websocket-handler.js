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
  sqsClient,
  memoryQueueUrl,
} = {}) {
  const getConnectionStore = () => connectionStore || createConnectionStore();
  const getRequestPublisher = () => requestPublisher || createRequestQueuePublisher();

  // スレッド一覧・履歴は SQS を経由せず、Edge が DynamoDB を直接読んで
  // WebSocket へ書き戻す。そのため postback と thread store が必要。
  const getPostback = () => postback || createWebSocketPostback();
  const getThreadListStore = () => threadStore || threadListStore;

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
        normalized.threadId
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
   * そのため削除後に Summary Lambda へ再生成を依頼する。
   * 再生成は残っているスレッドの要約だけから作り直すので、
   * 消したスレッドの内容は記憶からも消える。
   *
   * 再生成の依頼に失敗しても削除自体は成功扱いにする。
   * 週次バッチでも userMemory は作り直されるため、最悪そこで回収される。
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

      // 記憶の作り直しを依頼する（失敗しても削除は成立させる）
      let memoryRefreshRequested = false;
      try {
        memoryRefreshRequested = await requestMemoryRefresh(sub);
      } catch (error) {
        console.warn(`[ThreadDelete] memory refresh request failed: ${error.message}`);
      }

      await getPostback().postJson(normalized.connectionId, {
        type: 'thread_deleted',
        requestId: normalized.requestId,
        threadId: normalized.threadId,
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
   * キューが未設定なら何もしない（週次バッチに任せる）。
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
        // 短時間に複数削除しても再生成は1回で足りる（5分の重複排除）
        MessageDeduplicationId: `memory-refresh:${sub}`,
      })
    );

    return true;
  }


  async function handleDefault(normalized) {
    let sub = normalized.sub;

    // WebSocket APIでは、認証情報が `$connect` には存在しても、
    // 後続の `$default` イベントに毎回含まれるとは限らない。
    // そのため `$connect` 時に保存した接続テーブルからsubを補完する。
    if (!sub) {
      const connection = await getConnectionStore().getConnection?.(normalized.connectionId);
      sub = String(connection?.sub || '').trim();
    }

    if (!sub) {
      return createHttpResponse(401, {
        code: 'UNAUTHORIZED',
        message: 'Cognito sub is required',
      });
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
    });

    // WebSocketの入口では「受付完了」だけを返す。
    // 実際の生成結果は、Core Lambda -> Response Queue -> Edge Lambda -> WebSocketで後続送信される。
    return createAcceptedResponse({
      type: 'accepted',
      requestId: request.requestId,
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
