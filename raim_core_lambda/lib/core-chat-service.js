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
} = require('./tools');
const { getToolSecrets } = require('./tool-secret-provider');
const {
  CoreEventError,
  getCoreRequestId,
  normalizeCoreEvent,
} = require('./core-event');
const { createCoreChat, createCoreError } = require('./core-response');

// ─────────────────────────────────────────────
// ツールループの設定
// ─────────────────────────────────────────────
//
// MAX_TOOL_TURNS:
//   ツール呼出の上限。ローカル実装と同じく2。
//   3にすると「もう一度調べる」を繰り返してレイテンシとコストが跳ねるため、
//   実測の結果2に落としている。

const MAX_TOOL_TURNS = Number(process.env.MAX_TOOL_TURNS || 2);

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
  isToolUseEnabled,
  getToolDefinitions: () => TOOL_DEFINITIONS,
  executeTool: executeToolWithSecrets,
  pickToolIntro,
  getToolDescription,
  parseToolArguments,
  makeToolCallKey,
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
    const sessionState = dependencies.getMantleSessionState(session);

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

    // ツールを使えるか先に判定する。
    // systemプロンプトにツールの説明を入れるかどうかがここで決まる。
    const toolsEnabled = await dependencies.isToolUseEnabled();

    // 4. 初回ならsystem prompt・要約・Few-shotを含める。
    // 継続時はprevious_response_idを使うため、今回の発話を中心に組み立てる。
    let mantleInput = dependencies.buildMantleInput({
      userText: input.text,
      images: input.images,
      sessionSummary: session.sessionSummary || '',
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
          sessionSummary: session.sessionSummary || '',
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

      mantleResponse = await callMantle({
        input: toolResultInput,
        previousId: previousResponseId,
        tools: toolDefinitions,
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
      (!mantleResponse.rawText || exitedDueToDuplicate);

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

    return createCoreChat({
      requestId: input.requestId,
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
