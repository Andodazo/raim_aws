'use strict';

// ==============================================================================
// RAiM Core Chat Service
// ==============================================================================
//
// 【このファイルの役割】
// Core Lambdaの会話生成フロー全体を順番に実行するサービス層。
// Lambda固有の入口処理やHTTP形式から切り離し、会話処理だけを担当する。
//
// 【処理フロー】
// 1. eventをCore標準入力へ正規化する
// 2. DynamoDBからユーザーの会話状態を取得する
// 3. DynamoDBからScene選択用の軽量候補(id/textCentroid)を取得する
// 4. Titan Text Embeddings V2で発話に近いsceneIdを選ぶ
// 5. 選ばれたsceneIdの詳細Scene/Few-shotをDynamoDBから1件取得する
// 6. Scene、Few-shot、会話要約を使ってMantle inputを作る
// 7. Mantle Responses APIを呼び出す
// 8. Mantle出力をRAiM chat形式へ正規化する
// 9. 新しいresponse_idをDynamoDBへ保存する
// 10. Edge Lambda向けCoreレスポンスを返す
//
// 【response_idの復旧】
// 保存済みprevious_response_idがMantle側で失効していた時は、DynamoDBの古い状態を
// クリアし、sessionSummaryを含む初回用inputへ作り直して1回だけ再試行する。
// 無制限に再試行せず、同じ障害を繰り返さないようにしている。
//
// 【依存注入】
// createCoreChatService()へ依存関数を渡せるため、単体テストではAWSやMantleへ
// 接続せず、処理順序・引数・保存内容を確認できる。本番ではdefaultDependenciesを使う。
// ==============================================================================

const {
  clearMantleResponseState,
  getOrCreateUserSession,
  updateMantleResponseState,
} = require('./user-session-store');
const {
  getMantleSessionState,
  isMantleResponseExpiredError,
} = require('./mantle-session-policy');
const {
  getSceneById,
  listSceneCandidates,
} = require('./scene-repository');
const { selectScene } = require('./scene-selector');
const { buildMantleInput } = require('./prompt-builder');
const { createMantleResponse } = require('./mantle-client');
const { normalizeMantleOutput } = require('./response-validator');
const { MESSAGE_TYPES } = require('./types');
const {
  TOOL_DEFINITIONS,
  executeTool,
  pickToolIntro,
  getToolDescription,
  parseToolArguments,
  makeToolCallKey,
  isKnownTool,
} = require('./tools');
const { getToolSecrets } = require('./tool-secret-provider');
const {
  CoreEventError,
  getCoreRequestId,
  normalizeCoreEvent,
} = require('./core-event');
const { createCoreChat, createCoreError } = require('./core-response');
const { resolveThread, ensureThreadTitle } = require('./thread-resolver');
const { appendTurn } = require('./conversation-thread-store');
const { shouldSummarize } = require('./summary-trigger');
const { dispatchSummarization } = require('./summary-dispatcher');

// ─────────────────────────────────────────────
// ツールループの設定
// ─────────────────────────────────────────────
//
// MAX_TOOL_TURNS:
//   ツール呼出の上限。ローカル実装と同じく2。
//   3にすると「もう一度調べる」を繰り返してレイテンシとコストが跳ねるため、
//   実測の結果2に落としている。

const MAX_TOOL_TURNS = Number(process.env.MAX_TOOL_TURNS || 2);

// MULTI_TURN_TOOLS:
// ツール結果を返す呼出でも tools を渡すかどうか。
// 既定 false（＝渡さない）。詳細はツールループ内のコメントを参照。
const MULTI_TURN_TOOLS =
  String(process.env.MULTI_TURN_TOOLS || 'false').trim().toLowerCase() === 'true';

/**
 * ツールが利用可能かを判定する。
 *
 * Secrets Managerに外部APIキーが登録されていない場合はツールを無効化し、
 * ツールなしの通常会話として動作する。
 * これにより、ツール用Secretを作る前でもCore Lambdaをデプロイできる。
 */
async function isToolUseEnabled() {
  if (String(process.env.TOOLS_ENABLED || 'true').toLowerCase() === 'false') {
    return false;
  }

  try {
    const secrets = await getToolSecrets();
    return Boolean(secrets && (secrets.tavilyApiKey || secrets.openWeatherMapApiKey));
  } catch (error) {
    // Secret取得に失敗しても会話自体は継続させる。
    console.warn(`[Tool] disabled (secret unavailable): ${error.message}`);
    return false;
  }
}

/**
 * Secrets Managerのキーを渡してツールを実行する。
 */
async function executeToolWithSecrets(toolName, toolArgs) {
  const secrets = await getToolSecrets();
  return executeTool(toolName, toolArgs, secrets || {});
}

/**
 * ツール結果を踏まえた最終応答を強制生成させるプロンプト。
 *
 * ツール上限や重複検知でループを抜けたとき、本文が無い状態になる。
 * 「これ以上ツールを使うな」「結果を使って答えろ」を明示しないと、
 * Gemmaは再びツールを呼ぼうとしたり、ツール結果を無視して挨拶を始める。
 */
function buildForcedFinalPrompt({ toolFailed = false } = {}) {
  const base = toolFailed
    ? '上記でいくつかツールを実行しました。一部失敗もありますが、得られた情報を踏まえて、ユーザーへの最終応答を生成してください。'
    : '上記のツール実行結果を踏まえて、ユーザーへの最終応答を生成してください。ツール結果の情報を活用して、ユーザーの質問に具体的に答えてください。';

  return `${base}ツールはこれ以上使わないでください。応答はライムのまま、JSON形式 {"text":"...","emotions":{"感情名":強さ,...}} で返してください。`;
}

/**
 * ツール呼出開始をクライアントへ通知する既定実装。
 *
 * SQS経路ではsqs-core-handlerが上書きし、Response Queueへ
 * 前置きセリフとtool_callイベントを流す。
 * Lambdaコンソールからの直接実行では何もしない。
 */
async function onToolCallStart() {
  // 既定では何もしない
}

const defaultDependencies = Object.freeze({
  clearMantleResponseState,
  getOrCreateUserSession,
  updateMantleResponseState,

  // 会話履歴の自前保存（案A）
  resolveThread,
  ensureThreadTitle,
  appendTurn,
  shouldSummarize,
  dispatchSummarization,
  getMantleSessionState,
  isMantleResponseExpiredError,
  getSceneById,
  listSceneCandidates,
  selectScene,
  buildMantleInput,
  createMantleResponse,
  normalizeMantleOutput,

  // ツールループ
  maxToolTurns: MAX_TOOL_TURNS,
  multiTurnTools: MULTI_TURN_TOOLS,
  isToolUseEnabled,
  getToolDefinitions: () => TOOL_DEFINITIONS,
  executeTool: executeToolWithSecrets,
  pickToolIntro,
  getToolDescription,
  parseToolArguments,
  makeToolCallKey,
  isKnownTool,
  buildForcedFinalPrompt,
  onToolCallStart,
});

/**
 * Core Chat Serviceを生成する。
 *
 * @param {object} dependencyOverrides - テスト時に差し替える外部依存。
 * @returns {Function} eventを受け取ってCore responseを返すhandleCoreChat関数。
 *
 * handleCoreChatのonMantleTextDeltaへ関数を渡すと、Mantleから届いた文字列chunkを
 * 受信順に処理できる。将来Response Queueへchunkを送るPublisherはここへ接続する。
 */
function createCoreChatService(dependencyOverrides = {}) {
  const dependencies = {
    ...defaultDependencies,
    ...dependencyOverrides,
  };

  return async function handleCoreChat(event, {
    fallbackRequestId,
    onMantleStreamEvent,
    onMantleTextDelta,
    onSceneSelected,
    // SQS経路ではsqs-core-handlerが渡す。
    // Lambdaコンソールからの直接実行では未指定となり、既定の何もしない実装が使われる。
    onToolCallStart,
  } = {}) {
    const notifyToolCall = typeof onToolCallStart === 'function'
      ? onToolCallStart
      : dependencies.onToolCallStart;
    let input;

    // 入力不正は外部サービスを呼ぶ前に確定させ、再試行不要のerrorとして返す。
    try {
      input = normalizeCoreEvent(event, { fallbackRequestId });
    } catch (error) {
      if (!(error instanceof CoreEventError)) {
        throw error;
      }

      return createCoreError({
        requestId: getCoreRequestId(event, fallbackRequestId),
        code: error.code,
        message: error.message,
        retriable: error.retriable,
        details: error.details,
      });
    }

    // 1. ユーザー単位の会話状態をDynamoDBから取得する。
    // lastResponseIdが有効ならMantle側の会話コンテキストを継続できる。
    const session = await dependencies.getOrCreateUserSession(input.sub);

    // 1-b. 今回の往復が属する会話スレッドを決める（案A: 履歴を自前保存）。
    // クライアント指定 > UserSession の activeThreadId > 新規作成、の優先順位。
    // スレッド側にも lastResponseId を持たせるため、Mantle の継続判定は
    // スレッドの状態を優先する。
    const threadContext = await dependencies.resolveThread({
      sub: input.sub,
      requestedThreadId: input.threadId,
      userText: input.text,
    });

    // 継続判定はスレッド単位で行う。
    // 別スレッドへ切り替えたときに前スレッドの response_id を使い回さないため。
    const sessionState = dependencies.getMantleSessionState(
      threadContext.thread || session
    );

    // 2. Scene選択用の軽量候補を取得し、Titan Embeddingで今回のsceneIdを選ぶ。
    // ここではDynamoDBから `id` と `textCentroid` だけをScanする。
    // few_shotsなどの詳細を全Scene分読むと、Scene数が増えたときに無駄が大きいため。
    const sceneCandidates = await dependencies.listSceneCandidates();
    const sceneSelection = await dependencies.selectScene({
      userText: input.text,
      scenes: sceneCandidates,
    });

    // 3. 類似度計算で選ばれたsceneIdの詳細Sceneを1件だけ取得する。
    // prompt-builderが必要とする description / default_emotions / few_shots は、
    // 選ばれたSceneだけに絞ってGetItemする。
    const selectedScene = await dependencies.getSceneById(sceneSelection.sceneId);
    // ストリーミングTTSは最終的なemotionが確定する前に開始するため、
    // raim_serversideと同じく選択Sceneのdefault_emotionsを呼び出し側へ渡す。
    if (typeof onSceneSelected === 'function') {
      await onSceneSelected(selectedScene);
    }
    // ツールを使えるか先に判定する。
    // systemプロンプトにツールの説明を入れるかどうかがここで決まる。
    const toolsEnabled = await dependencies.isToolUseEnabled();

    // 4. 初回ならsystem prompt・要約・Few-shotを含める。
    // 継続時はprevious_response_idを使うため、今回の発話を中心に組み立てる。
    let mantleInput = dependencies.buildMantleInput({
      userText: input.text,
      images: input.images,
      // 要約はスレッド単位（ConversationThread.sessionSummary）に保存される。
      // UserSession 側の sessionSummary は使われないため、ここで参照すると
      // 常に空になり、圧縮でセッションをリセットした直後に文脈が失われる。
      sessionSummary: threadContext.thread?.sessionSummary || '',
      // スレッドを跨いだ記憶。別スレッドで話した内容をライムが覚えている状態にする。
      userMemory: session.userMemory || '',
      scene: selectedScene,
      usePreviousResponseId: sessionState.usePreviousResponseId,
      withTools: toolsEnabled,
    });
    // policyが期限・存在状態を確認済みの時だけprevious_response_idを送る。
    let previousResponseId = sessionState.usePreviousResponseId
      ? sessionState.previousResponseId
      : '';
    let mantleResponse;

    // ─────────────────────────────────────────────
    // 4. Mantle呼び出し（ツールループ）
    // ─────────────────────────────────────────────
    //
    // 【なぜループするか】
    // Gemmaはツールを使うと判断した場合、本文を返さずツール呼出だけを返す。
    // ツールを実行し、その結果をMantleへ戻して、もう一度生成させる必要がある。
    //
    // 【Gemma固有の制約】
    // - ツール呼出時、content が空になる
    //   → 「調べるね」に相当する発話をLLMに作らせられない。
    //     サーバー側の固定セリフ（pickToolIntro）をライムの発話として先に送る。
    // - 1ターンに複数ツールを呼べない
    //   → 呼出は1件ずつ処理する。
    //
    // 【ループ制御】
    // - MAX_TOOL_TURNS で上限を設ける（無限ループとコスト暴走の防止）
    // - 同じツールを同じ引数で呼んだら打ち切る（重複検知）
    // - 上限や重複で抜けた場合は、ツール結果を踏まえた最終応答を強制生成する
    //
    // 【previous_response_idとの関係】
    // ツール結果を返す2回目以降の呼出では、直前のresponse_idを使って会話を継続する。
    // これによりツール呼出のコンテキストがMantle側に保持される。
    // ツールを使わない構成では、従来どおり1回だけ呼んで終わる。
    const callMantle = async ({ input: currentInput, previousId, tools }) => {
      return dependencies.createMantleResponse({
        mantleInput: currentInput,
        previousResponseId: previousId,
        store: true,
        onStreamEvent: onMantleStreamEvent,
        onTextDelta: onMantleTextDelta,
        tools,
      });
    };

    // Mantle側のresponse_idが失効していた場合だけ、初回promptで1回再試行する。
    const callMantleWithRecovery = async ({ input: currentInput, previousId, tools }) => {
      try {
        return await callMantle({ input: currentInput, previousId, tools });
      } catch (error) {
        const canRecover = Boolean(previousId) &&
          dependencies.isMantleResponseExpiredError(error);

        if (!canRecover) {
          throw error;
        }

        // 次回Invocationでも同じ失効IDを使わないよう、再試行より先にDynamoDBをクリアする。
        await dependencies.clearMantleResponseState(input.sub);
        previousResponseId = '';

        const rebuiltInput = dependencies.buildMantleInput({
          userText: input.text,
          images: input.images,
          // 要約はスレッド単位に保存される（§ 上のコメント参照）
          sessionSummary: threadContext.thread?.sessionSummary || '',
          userMemory: session.userMemory || '',
          scene: selectedScene,
          usePreviousResponseId: false,
          withTools: toolsEnabled,
        });

        mantleInput = rebuiltInput;

        return callMantle({ input: rebuiltInput, previousId: '', tools });
      }
    };

    const toolDefinitions = toolsEnabled ? dependencies.getToolDefinitions() : null;
    const seenToolCalls = new Set();

    let toolTurn = 0;
    let toolExecuted = false;
    let toolFailed = false;
    let exitedDueToDuplicate = false;
    let exitedDueToUnknownTool = false;

    mantleResponse = await callMantleWithRecovery({
      input: mantleInput,
      previousId: previousResponseId,
      tools: toolDefinitions,
    });

    while (
      toolsEnabled &&
      Array.isArray(mantleResponse.toolCalls) &&
      mantleResponse.toolCalls.length > 0 &&
      toolTurn < dependencies.maxToolTurns
    ) {
      toolTurn += 1;

      // Gemmaは並列ツール呼出に非対応なので、先頭の1件だけを処理する。
      const toolCall = mantleResponse.toolCalls[0];
      const toolName = toolCall.name;
      const toolArgs = dependencies.parseToolArguments(toolCall.arguments);
      const callKey = dependencies.makeToolCallKey(toolName, toolArgs);

      // 同じツールを同じ引数で呼び直すループを検知して打ち切る。
      if (seenToolCalls.has(callKey)) {
        exitedDueToDuplicate = true;
        break;
      }

      seenToolCalls.add(callKey);

      // ─────────────────────────────────────────────
      // 未知ツール名のフィルタ（intro送信より前に行う）
      // ─────────────────────────────────────────────
      //
      // Gemma 4は "tool_result" や "search" のような存在しないツール名を
      // 捏造して呼ぶことがある。これをそのまま流すと、
      // ライムが「調べてくるね」と喋った直後に実行が失敗し、
      // ユーザーから見ると「調べると言ったのに何も起きない」状態になる。
      //
      // そのため、intro を送る前に実在するツールかを判定し、
      // 捏造ツールなら発話せずにループを抜けて最終応答を生成させる。
      if (!dependencies.isKnownTool(toolName)) {
        console.warn(`[Tool] 未知のツール名を無視しました: ${toolName}`);
        exitedDueToUnknownTool = true;
        break;
      }

      // ツール呼出中であることをクライアントへ知らせる。
      // Gemmaは本文を返せないため、ここはサーバー側の固定セリフ。
      await notifyToolCall({
        toolName,
        toolArgs,
        turn: toolTurn,
        introText: dependencies.pickToolIntro(toolName, toolTurn),
        description: dependencies.getToolDescription(toolName, toolArgs),
      });

      const toolResult = await dependencies.executeTool(toolName, toolArgs);

      toolExecuted = true;

      if (toolResult && toolResult.error) {
        toolFailed = true;
      }

      // ツール結果をResponses APIの形式でMantleへ戻す。
      // previous_response_idで会話を継続するため、直前の呼出のcall_idと対応させる。
      previousResponseId = mantleResponse.responseId;

      const toolResultInput = {
        ...mantleInput,
        messages: [
          {
            type: 'function_call_output',
            call_id: toolCall.callId,
            output: JSON.stringify(toolResult),
          },
        ],
      };

      // ─────────────────────────────────────────────
      // v16: ツール結果を返す呼出では tools を渡さない
      // ─────────────────────────────────────────────
      //
      // ツール結果をmessagesへ入れた状態でtoolsも一緒に渡すと、
      // Gemma 4が次のいずれかをやりがちで、1ターン無駄になる。
      //
      //   - 同じツールをもう一度呼ぶ
      //   - "tool_result" のような存在しないツール名を捏造して呼ぶ
      //
      // ローカル実装（raim_serverside v16）では、この状態でLLM呼出が
      // 3回・合計36秒かかっていた。toolsを外すと2回で済む。
      //
      // toolsを渡さなければ、モデルは構造的にツールを呼べないため、
      // 「結果を読んで本文を返す」しか選べなくなる。
      // プロンプトでの禁止指示より確実。
      //
      // 天気を見てから検索する等の多段ツール連鎖が必要になったら、
      // MULTI_TURN_TOOLS=true で従来の挙動へ戻せる。
      mantleResponse = await callMantle({
        input: toolResultInput,
        previousId: previousResponseId,
        tools: dependencies.multiTurnTools ? toolDefinitions : null,
      });
    }

    // ─────────────────────────────────────────────
    // ツール後の最終応答を強制生成する
    // ─────────────────────────────────────────────
    //
    // 次のどちらかに該当すると、本文のない状態でループを抜ける。
    //
    //   - 重複ツール呼出を検知して打ち切った
    //   - MAX_TOOL_TURNS に到達した
    //
    // このままだと返す本文が無いので、「ツールはもう使わず、
    // 得られた結果で最終応答を作れ」と明示して1回だけ生成させる。
    const needsForcedFinalResponse =
      toolExecuted &&
      (!mantleResponse.rawText || exitedDueToDuplicate || exitedDueToUnknownTool);

    if (needsForcedFinalResponse) {
      previousResponseId = mantleResponse.responseId;

      const forcedInput = {
        ...mantleInput,
        messages: [
          {
            role: 'user',
            content: dependencies.buildForcedFinalPrompt({ toolFailed }),
          },
        ],
      };

      // toolsを渡さないことで、これ以上のツール呼出を構造的に不可能にする。
      mantleResponse = await callMantle({
        input: forcedInput,
        previousId: previousResponseId,
        tools: null,
      });
    }

    // 5. Mantleの出力文字列をRAiMのchat形式へ正規化する。
    const output = dependencies.normalizeMantleOutput(mantleResponse.rawText);

    // JSONの崩れ等をresponse-validatorがerrorにした場合、response_idは保存しない。
    // 不正な応答を次回会話の起点にしないため。
    if (output.type === MESSAGE_TYPES.ERROR) {
      return createCoreError({
        requestId: input.requestId,
        code: output.code,
        message: output.message,
        retriable: output.retriable,
        details: output.details,
      });
    }

    // 6. Mantleが発行したresponse_idを次回会話用に保存する。
    await dependencies.updateMantleResponseState(input.sub, {
      responseId: mantleResponse.responseId,
      createdAt: mantleResponse.createdAt,
    });

    // 7. 会話履歴をスレッドへ追記する（案A）。
    //
    // Mantle 側の履歴は30日で消え、Core からは中身も読めないため、
    // スレッド再開・要約の材料・画像の記憶のために自前で持つ。
    //
    // 画像はバイナリではなく image_description（マルチモーダルで生成済みの
    // 説明文）を保存する。容量が軽く、過去に見せた画像を覚えていられる。
    //
    // 保存に失敗しても会話体験は壊さない。応答は既に生成できているため、
    // ここで throw するとユーザーには「失敗」に見えてしまう。
    try {
      const updatedThread = await dependencies.appendTurn({
        sub: input.sub,
        threadId: threadContext.threadId,
        userMessage: {
          text: input.text,
          imageDescription: output.image_description || '',
        },
        assistantMessage: {
          text: output.text,
          emotions: output.emotions,
        },
        inputTokens: mantleResponse.usage
          ? Number(mantleResponse.usage.input_tokens) || 0
          : 0,
        responseId: mantleResponse.responseId,
        responseCreatedAt: mantleResponse.createdAt,
      });

      // 「新しい会話」が並ばないよう、最初の発話からタイトルを付ける。
      if (threadContext.isNew) {
        await dependencies.ensureThreadTitle({
          sub: input.sub,
          threadId: threadContext.threadId,
          thread: threadContext.thread,
          userText: input.text,
        });
      }

      // 8. 履歴が溜まっていれば要約を依頼する。
      //
      // appendTurn は更新後のスレッド（ALL_NEW）を返すので、
      // 累積トークンと往復数はここで最新値を見られる。
      //
      // 実際の要約は Summary Lambda が別プロセスで行う。ここで待つと
      // その往復だけ Mantle 呼び出しが2回になりレイテンシが倍近くなるため、
      // 依頼を投げるだけにする。
      const trigger = dependencies.shouldSummarize(updatedThread);

      if (trigger.shouldSummarize) {
        await dependencies.dispatchSummarization({
          sub: input.sub,
          threadId: threadContext.threadId,
          reason: trigger.reason,
        });
      }
    } catch (error) {
      console.error(`[Thread] append failed (non-fatal): ${error.message}`);
    }

    return createCoreChat({
      requestId: input.requestId,
      threadId: threadContext.threadId,
      text: output.text,
      // v13: 比率Map + 全体強度。emotion / intensity は後方互換で保持する。
      emotions: output.emotions,
      overallIntensity: output.overall_intensity,
      emotion: output.emotion,
      intensity: output.intensity,
    });
  };
}

const handleCoreChat = createCoreChatService();

module.exports = {
  createCoreChatService,
  handleCoreChat,
};
