'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCoreChatService } = require('../lib/core-chat-service');

function createDependencies(calls) {
  return {
    clearMantleResponseState: async (sub) => {
      calls.push(['clear', sub]);
    },
    getOrCreateUserSession: async (sub) => {
      calls.push(['session', sub]);
      return { sessionSummary: 'summary', lastResponseId: 'previous-1' };
    },
    getMantleSessionState: () => ({
      usePreviousResponseId: true,
      previousResponseId: 'previous-1',
    }),
    isMantleResponseExpiredError: () => false,
    listSceneCandidates: async () => [{ id: 'default', textCentroid: [1, 0] }],
    selectScene: ({ userText }) => ({ sceneId: 'default', userText }),
    getSceneById: async (sceneId) => ({ id: sceneId, few_shots: [] }),
    buildMantleInput: (input) => input,
    createMantleResponse: async (input) => {
      calls.push(['model', input]);
      return {
        responseId: 'response-1',
        createdAt: '2026-06-24T00:00:00.000Z',
        rawText: '{}',
      };
    },
    normalizeMantleOutput: () => ({
      type: 'chat',
      text: 'やあ',
      emotion: 'happy',
      intensity: 0.6,
    }),
    // 案A: 会話履歴の自前保存。テストでは AWS を叩かないようスタブ化する。
    resolveThread: async () => ({
      threadId: 'thread-test',
      thread: null,
      isNew: false,
    }),
    ensureThreadTitle: async () => {},
    appendTurn: async () => ({}),
    shouldSummarize: () => ({ shouldSummarize: false, reason: null }),
    dispatchSummarization: async () => true,
    updateMantleResponseState: async (sub, state) => {
      calls.push(['save', sub, state]);
    },
  };
}

test('Core chat service runs the existing conversation flow and returns a Core response', async () => {
  const calls = [];
  const handleCoreChat = createCoreChatService(createDependencies(calls));
  const result = await handleCoreChat({
    sub: 'user-1',
    requestId: 'req-1',
    text: 'こんにちは',
    images: [],
  });

  assert.deepEqual(result, {
    ok: true,
    type: 'chat',
    text: 'やあ',
    threadId: 'thread-test',
    // v13: emotions Map + overall_intensity が付与される。
    // 後方互換の emotion / intensity も引き続き返る。
    emotions: { happy: 1 },
    overall_intensity: 0.6,
    emotion: 'happy',
    intensity: 0.6,
    requestId: 'req-1',
  });
  assert.deepEqual(calls[0], ['session', 'user-1']);
  assert.equal(calls[1][1].previousResponseId, 'previous-1');
  assert.deepEqual(calls[2], [
    'save',
    'user-1',
    {
      responseId: 'response-1',
      createdAt: '2026-06-24T00:00:00.000Z',
    },
  ]);
});

test('Core chat service resolves S3 images before the existing response flow', async () => {
  const calls = [];
  const dependencies = createDependencies(calls);
  dependencies.resolveImages = async ({ images, sub, requestId }) => {
    calls.push(['s3', sub, requestId, images]);
    return [{
      key: images[0].key,
      contentType: images[0].contentType,
      sizeBytes: 8,
      s3Uri: 's3://bucket/temporary/users/user-1/request-1/image.png',
    }];
  };
  dependencies.buildMantleInput = (input) => {
    calls.push(['build', input]);
    return input;
  };

  await createCoreChatService(dependencies)({
    sub: 'user-1',
    requestId: 'request-1',
    text: '画像を見て',
    images: [{
      key: 'temporary/users/user-1/request-1/image.png',
      contentType: 'image/png',
      sizeBytes: 8,
    }],
  });

  const s3Index = calls.findIndex(([name]) => name === 's3');
  const sessionIndex = calls.findIndex(([name]) => name === 'session');
  const buildIndex = calls.findIndex(([name]) => name === 'build');
  const modelIndex = calls.findIndex(([name]) => name === 'model');

  assert.ok(s3Index >= 0);
  assert.ok(s3Index < sessionIndex);
  assert.ok(s3Index < buildIndex);
  assert.ok(s3Index < modelIndex);
  assert.equal(calls[buildIndex][1].images[0].s3Uri,
    's3://bucket/temporary/users/user-1/request-1/image.png');
});

test('Core chat service returns INVALID_INPUT without calling dependencies', async () => {
  const calls = [];
  const handleCoreChat = createCoreChatService(createDependencies(calls));
  const result = await handleCoreChat({
    sub: 'user-1',
    requestId: 'req-invalid',
    text: '',
    images: [],
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_INPUT');
  assert.equal(result.requestId, 'req-invalid');
  assert.deepEqual(calls, []);
});

test('Core chat service maps a model validation error without saving response state', async () => {
  const calls = [];
  const dependencies = createDependencies(calls);
  dependencies.normalizeMantleOutput = () => ({
    type: 'error',
    code: 'LLM_ERROR',
    message: 'invalid model output',
    retriable: true,
  });
  const handleCoreChat = createCoreChatService(dependencies);
  const result = await handleCoreChat({
    sub: 'user-1',
    requestId: 'req-1',
    text: 'hello',
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'LLM_ERROR');
  assert.equal(result.requestId, 'req-1');
  assert.equal(calls.some(([name]) => name === 'save'), false);
});

test('Core chat service clears an expired response_id and retries once', async () => {
  const calls = [];
  const dependencies = createDependencies(calls);
  let attempt = 0;
  dependencies.isMantleResponseExpiredError = (error) => error.statusCode === 404;
  dependencies.createMantleResponse = async ({ previousResponseId }) => {
    attempt += 1;
    calls.push(['model-attempt', previousResponseId]);

    if (attempt === 1) {
      const error = new Error('previous_response_id was not found');
      error.statusCode = 404;
      throw error;
    }

    return {
      responseId: 'response-recovered',
      createdAt: '2026-06-24T00:00:00.000Z',
      rawText: '{}',
    };
  };
  const handleCoreChat = createCoreChatService(dependencies);
  const result = await handleCoreChat({
    sub: 'user-1',
    requestId: 'req-recovery',
    text: 'hello',
  });

  assert.equal(result.ok, true);
  assert.equal(attempt, 2);
  assert.equal(calls.some(([name]) => name === 'clear'), true);
  assert.deepEqual(
    calls.filter(([name]) => name === 'model-attempt'),
    [['model-attempt', 'previous-1'], ['model-attempt', '']]
  );
});

test('Core chat service forwards Mantle text deltas to the caller in order', async () => {
  const calls = [];
  const receivedDeltas = [];
  const dependencies = createDependencies(calls);
  dependencies.createMantleResponse = async ({ onTextDelta }) => {
    await onTextDelta('こん');
    await onTextDelta('にちは');
    return {
      responseId: 'response-streamed',
      createdAt: '2026-06-24T00:00:00.000Z',
      rawText: '{}',
    };
  };
  const handleCoreChat = createCoreChatService(dependencies);

  await handleCoreChat({
    sub: 'user-1',
    requestId: 'req-stream',
    text: 'hello',
  }, {
    onMantleTextDelta: async (delta) => receivedDeltas.push(delta),
  });

  assert.deepEqual(receivedDeltas, ['こん', 'にちは']);
});

test('Core chat service records the turn into the conversation thread', async () => {
  const appended = [];

  const service = createCoreChatService({
    getOrCreateUserSession: async () => ({ sub: 'user-1' }),
    getMantleSessionState: () => ({ canUsePreviousResponse: false, previousResponseId: '' }),
    listSceneCandidates: async () => [],
    selectScene: async () => ({ sceneId: 'default', similarity: 1 }),
    getSceneById: async () => ({ id: 'default', few_shots: [] }),
    buildMantleInput: () => ({ mode: 'initial', messages: [] }),
    createMantleResponse: async () => ({
      responseId: 'resp-1',
      rawText: '{"text":"あ、こんにちは","emotions":{"happy":1}}',
      createdAt: '2026-07-30T00:00:00.000Z',
      toolCalls: [],
      usage: { input_tokens: 1800 },
    }),
    normalizeMantleOutput: () => ({
      ok: true,
      text: 'あ、こんにちは',
      emotions: { happy: 1 },
      overall_intensity: 0.6,
      emotion: 'happy',
      intensity: 0.6,
    }),
    updateMantleResponseState: async () => {},
    resolveThread: async () => ({ threadId: 'thread-x', thread: { title: '新しい会話' }, isNew: true }),
    ensureThreadTitle: async () => {},
    appendTurn: async (params) => { appended.push(params); },
  });

  await service({
    schemaVersion: 1,
    type: 'chat.request',
    sub: 'user-1',
    requestId: 'req-1',
    source: 'websocket',
    text: 'こんにちは',
    images: [],
  });

  assert.equal(appended.length, 1);
  assert.equal(appended[0].threadId, 'thread-x');
  assert.equal(appended[0].userMessage.text, 'こんにちは');
  assert.equal(appended[0].assistantMessage.text, 'あ、こんにちは');
  // 要約トリガー用のトークン累積も渡っている
  assert.equal(appended[0].inputTokens, 1800);
  assert.equal(appended[0].responseId, 'resp-1');
});

test('Core chat service still answers when thread persistence fails', async () => {
  const service = createCoreChatService({
    getOrCreateUserSession: async () => ({ sub: 'user-1' }),
    getMantleSessionState: () => ({ canUsePreviousResponse: false, previousResponseId: '' }),
    listSceneCandidates: async () => [],
    selectScene: async () => ({ sceneId: 'default', similarity: 1 }),
    getSceneById: async () => ({ id: 'default', few_shots: [] }),
    buildMantleInput: () => ({ mode: 'initial', messages: [] }),
    createMantleResponse: async () => ({
      responseId: 'resp-1',
      rawText: '{"text":"ok","emotions":{"happy":1}}',
      createdAt: '2026-07-30T00:00:00.000Z',
      toolCalls: [],
    }),
    normalizeMantleOutput: () => ({
      ok: true, text: 'ok', emotions: { happy: 1 },
      overall_intensity: 1, emotion: 'happy', intensity: 1,
    }),
    updateMantleResponseState: async () => {},
    resolveThread: async () => ({ threadId: 't', thread: null, isNew: false }),
    ensureThreadTitle: async () => {},
    // 保存が落ちても応答は返す
    appendTurn: async () => { throw new Error('DynamoDB down'); },
  });

  const result = await service({
    schemaVersion: 1,
    type: 'chat.request',
    sub: 'user-1',
    requestId: 'req-1',
    source: 'websocket',
    text: 'こんにちは',
    images: [],
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, 'ok');
});

test('Core chat service dispatches a summary request when the thread grows', async () => {
  const dispatched = [];

  const service = createCoreChatService({
    getOrCreateUserSession: async () => ({ sub: 'user-1' }),
    getMantleSessionState: () => ({ canUsePreviousResponse: false, previousResponseId: '' }),
    listSceneCandidates: async () => [],
    selectScene: async () => ({ sceneId: 'default', similarity: 1 }),
    getSceneById: async () => ({ id: 'default', few_shots: [] }),
    buildMantleInput: () => ({ mode: 'initial', messages: [] }),
    createMantleResponse: async () => ({
      responseId: 'resp-1',
      rawText: '{"text":"ok","emotions":{"happy":1}}',
      createdAt: '2026-07-30T00:00:00.000Z',
      toolCalls: [],
      usage: { input_tokens: 1800 },
    }),
    normalizeMantleOutput: () => ({
      ok: true, text: 'ok', emotions: { happy: 1 },
      overall_intensity: 1, emotion: 'happy', intensity: 1,
    }),
    updateMantleResponseState: async () => {},
    resolveThread: async () => ({ threadId: 'thread-x', thread: null, isNew: false }),
    ensureThreadTitle: async () => {},
    // 更新後のスレッドが閾値を超えている状態を返す
    appendTurn: async () => ({ cumulativeInputTokens: 9000, turnCount: 5 }),
    shouldSummarize: (thread) => ({
      shouldSummarize: thread.cumulativeInputTokens >= 8000,
      reason: 'token_threshold',
    }),
    dispatchSummarization: async (params) => { dispatched.push(params); return true; },
  });

  await service({
    schemaVersion: 1,
    type: 'chat.request',
    sub: 'user-1',
    requestId: 'req-1',
    source: 'websocket',
    text: 'こんにちは',
    images: [],
  });

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].threadId, 'thread-x');
  assert.equal(dispatched[0].reason, 'token_threshold');
});

test('Core chat service does not dispatch below the threshold', async () => {
  const dispatched = [];

  const service = createCoreChatService({
    getOrCreateUserSession: async () => ({ sub: 'user-1' }),
    getMantleSessionState: () => ({ canUsePreviousResponse: false, previousResponseId: '' }),
    listSceneCandidates: async () => [],
    selectScene: async () => ({ sceneId: 'default', similarity: 1 }),
    getSceneById: async () => ({ id: 'default', few_shots: [] }),
    buildMantleInput: () => ({ mode: 'initial', messages: [] }),
    createMantleResponse: async () => ({
      responseId: 'resp-1',
      rawText: '{"text":"ok","emotions":{"happy":1}}',
      createdAt: '2026-07-30T00:00:00.000Z',
      toolCalls: [],
      usage: { input_tokens: 500 },
    }),
    normalizeMantleOutput: () => ({
      ok: true, text: 'ok', emotions: { happy: 1 },
      overall_intensity: 1, emotion: 'happy', intensity: 1,
    }),
    updateMantleResponseState: async () => {},
    resolveThread: async () => ({ threadId: 't', thread: null, isNew: false }),
    ensureThreadTitle: async () => {},
    appendTurn: async () => ({ cumulativeInputTokens: 500, turnCount: 1 }),
    shouldSummarize: () => ({ shouldSummarize: false, reason: null }),
    dispatchSummarization: async (params) => { dispatched.push(params); return true; },
  });

  await service({
    schemaVersion: 1,
    type: 'chat.request',
    sub: 'user-1',
    requestId: 'req-1',
    source: 'websocket',
    text: 'こんにちは',
    images: [],
  });

  assert.equal(dispatched.length, 0);
});

test('Core chat service feeds the thread summary into the prompt, not the user session', async () => {
  // 要約はスレッド単位に保存される。UserSession 側を見ていると常に空になり、
  // 圧縮でセッションをリセットした直後に文脈が丸ごと失われる
  let captured;

  const service = createCoreChatService({
    getOrCreateUserSession: async () => ({
      sub: 'user-1',
      sessionSummary: '',              // UserSession 側は空
      userMemory: '【事実】\n- タピオカが好き',
    }),
    getMantleSessionState: () => ({
      // 圧縮でリセットされた直後を想定（初回モードへ落ちる）
      canUsePreviousResponse: false,
      usePreviousResponseId: false,
      previousResponseId: '',
    }),
    listSceneCandidates: async () => [],
    selectScene: async () => ({ sceneId: 'default', similarity: 1 }),
    getSceneById: async () => ({ id: 'default', few_shots: [] }),
    buildMantleInput: (params) => {
      captured = params;
      return { mode: 'initial', messages: [] };
    },
    createMantleResponse: async () => ({
      responseId: 'resp-1',
      rawText: '{"text":"ok","emotions":{"happy":1}}',
      createdAt: '2026-08-04T00:00:00.000Z',
      toolCalls: [],
    }),
    normalizeMantleOutput: () => ({
      ok: true, text: 'ok', emotions: { happy: 1 },
      overall_intensity: 1, emotion: 'happy', intensity: 1,
    }),
    updateMantleResponseState: async () => {},
    resolveThread: async () => ({
      threadId: 'thread-x',
      thread: { sessionSummary: '【事実】\n- ユーザーは東京にいる' },
      isNew: false,
    }),
    ensureThreadTitle: async () => {},
    appendTurn: async () => ({}),
    shouldSummarize: () => ({ shouldSummarize: false, reason: null }),
    dispatchSummarization: async () => true,
  });

  await service({
    schemaVersion: 1,
    type: 'chat.request',
    sub: 'user-1',
    requestId: 'req-1',
    source: 'websocket',
    text: '気温ってどんなもん？',
    images: [],
  });

  // スレッドの要約が渡る
  assert.match(captured.sessionSummary, /東京にいる/);
  // スレッドを跨いだ記憶も渡る
  assert.match(captured.userMemory, /タピオカ/);
});
