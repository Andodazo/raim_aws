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
// 3. DynamoDBからScene/Few-shot一覧を取得する
// 4. Titan Text Embeddings V2で発話に近いSceneを選ぶ
// 5. Scene、Few-shot、会話要約を使ってMantle inputを作る
// 6. Mantle Responses APIを呼び出す
// 7. Mantle出力をRAiM chat形式へ正規化する
// 8. 新しいresponse_idをDynamoDBへ保存する
// 9. Edge Lambda向けCoreレスポンスを返す
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
const { listScenes } = require('./scene-repository');
const { selectScene } = require('./scene-selector');
const { buildMantleInput } = require('./prompt-builder');
const { createMantleResponse } = require('./mantle-client');
const { normalizeMantleOutput } = require('./response-validator');
const { MESSAGE_TYPES } = require('./types');
const {
  CoreEventError,
  getCoreRequestId,
  normalizeCoreEvent,
} = require('./core-event');
const { createCoreChat, createCoreError } = require('./core-response');

const defaultDependencies = Object.freeze({
  clearMantleResponseState,
  getOrCreateUserSession,
  updateMantleResponseState,
  getMantleSessionState,
  isMantleResponseExpiredError,
  listScenes,
  selectScene,
  buildMantleInput,
  createMantleResponse,
  normalizeMantleOutput,
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
  } = {}) {
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

    // 2. Scene/Few-shot定義を取得し、Titan Embeddingで今回のSceneを選ぶ。
    // selectSceneは非同期でBedrock Runtimeを呼び出す。
    const scenes = await dependencies.listScenes();
    const sceneSelection = await dependencies.selectScene({
      userText: input.text,
      scenes,
    });

    // 3. 初回ならsystem prompt・要約・Few-shotを含める。
    // 継続時はprevious_response_idを使うため、今回の発話を中心に組み立てる。
    let mantleInput = dependencies.buildMantleInput({
      userText: input.text,
      images: input.images,
      sessionSummary: session.sessionSummary || '',
      scene: sceneSelection.scene,
      usePreviousResponseId: sessionState.usePreviousResponseId,
    });
    // policyが期限・存在状態を確認済みの時だけprevious_response_idを送る。
    let previousResponseId = sessionState.usePreviousResponseId
      ? sessionState.previousResponseId
      : '';
    let mantleResponse;

    // 4. Mantle Responses APIを実際に呼び出す。
    // 保存済みresponse_idがMantle側で期限切れだった場合だけ状態をクリアし、
    // 初回用promptを再構築して1回だけ再試行する。
    try {
      mantleResponse = await dependencies.createMantleResponse({
        mantleInput,
        previousResponseId,
        store: true,
        onStreamEvent: onMantleStreamEvent,
        onTextDelta: onMantleTextDelta,
      });
    } catch (error) {
      // 404等すべてを再試行するのではなく、response_id失効と判定できた時だけ復旧する。
      const canRecover = Boolean(previousResponseId) &&
        dependencies.isMantleResponseExpiredError(error);

      if (!canRecover) {
        throw error;
      }

      // 次回Invocationでも同じ失効IDを使わないよう、再試行より先にDynamoDBをクリアする。
      await dependencies.clearMantleResponseState(input.sub);
      previousResponseId = '';
      mantleInput = dependencies.buildMantleInput({
        userText: input.text,
        images: input.images,
        sessionSummary: session.sessionSummary || '',
        scene: sceneSelection.scene,
        usePreviousResponseId: false,
      });
      mantleResponse = await dependencies.createMantleResponse({
        mantleInput,
        previousResponseId,
        store: true,
        onStreamEvent: onMantleStreamEvent,
        onTextDelta: onMantleTextDelta,
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
