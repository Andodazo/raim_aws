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
    getThread: async () => null,
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
      dataUrl: 'data:image/png;base64,AAAA',
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
    appendTurn: async () => ({ sessionInputTokens: 9000, summarizedAtInputTokens: 0, turnCount: 5 }),
    shouldSummarize: (thread) => ({
      shouldSummarize: thread.sessionInputTokens >= 8000,
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
    appendTurn: async () => ({ sessionInputTokens: 500, summarizedAtInputTokens: 0, turnCount: 1 }),
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

test('消したスレッドへの発言は、Mantle を呼ばずに THREAD_DELETED で返す', async () => {
  let mantleCalled = false;
  const service = createCoreChatService({
    getOrCreateUserSession: async () => ({ sub: 'user-1' }),
    resolveThread: async () => {
      const error = new Error('Conversation thread was deleted');
      error.code = 'THREAD_DELETED';
      error.retriable = false;
      throw error;
    },
    createMantleResponse: async () => {
      mantleCalled = true;
      return {};
    },
  });

  const result = await service({
    schemaVersion: 1,
    type: 'chat.request',
    sub: 'user-1',
    requestId: 'req-1',
    source: 'websocket',
    threadId: 'thread-gone',
    text: 'まだいる？',
    images: [],
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'THREAD_DELETED');
  assert.equal(result.retriable, false);
  assert.equal(mantleCalled, false);
});

test('アプリを開いたときの話しかけは、合図の文を残さずライムの返事だけを残す', async () => {
  const calls = [];
  const dependencies = createDependencies(calls);
  let toolCheck = 0;
  dependencies.isToolUseEnabled = async () => {
    toolCheck += 1;
    return true;
  };
  dependencies.selectScene = ({ userText }) => {
    calls.push(['scene', userText]);
    return { sceneId: 'default' };
  };
  dependencies.buildMantleInput = (input) => {
    calls.push(['build', input]);
    return input;
  };
  dependencies.appendTurn = async (turn) => {
    calls.push(['append', turn]);
    return {};
  };

  const result = await createCoreChatService(dependencies)({
    schemaVersion: 1,
    type: 'chat.request',
    sub: 'user-1',
    requestId: 'req-greet',
    text: '',
    images: [],
    greeting: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, 'やあ');
  // 本文が無いので、挨拶の Scene が選ばれる文で選ぶ
  const scene = calls.find(([name]) => name === 'scene');
  assert.notEqual(scene[1], '');
  // ツールは見せない（一言話しかけるだけ）
  assert.equal(toolCheck, 0);
  const build = calls.find(([name]) => name === 'build');
  assert.equal(build[1].greeting, true);
  assert.equal(build[1].withTools, false);
  // 毎回同じ文にならないよう、切り口つきの指示を渡す
  assert.match(build[1].greetingInstruction, /今回の切り口|久しぶり/);
  const append = calls.find(([name]) => name === 'append');
  assert.equal(append[1].userMessage, null);
  assert.equal(append[1].assistantMessage.text, 'やあ');
  assert.equal(append[1].assistantMessage.meta.greeting, true);
});

// 2026-11-06: 「もう消えたい」の3分後に、同じ会話で季節の話しかけをしていた
test('greeting right after a hard talk gently checks in instead of using an angle', async () => {
  const calls = [];
  const dependencies = createDependencies(calls);
  dependencies.now = () => new Date('2026-11-06T05:18:42.000Z');
  dependencies.resolveThread = async () => ({
    threadId: 'thread-hard',
    isNew: false,
    thread: {
      messages: [
        { role: 'user', text: 'もう消えたい', createdAt: '2026-11-06T05:15:32.000Z' },
        { role: 'assistant', text: '話してくれてありがとう', createdAt: '2026-11-06T05:15:32.000Z' },
      ],
    },
  });
  dependencies.buildMantleInput = (input) => {
    calls.push(['build', input]);
    return input;
  };

  await createCoreChatService(dependencies)({
    sub: 'user-1',
    requestId: 'req-greet-care',
    text: '',
    images: [],
    greeting: true,
  });

  const build = calls.find(([name]) => name === 'build');
  assert.match(build[1].greetingInstruction, /そっと様子を聞く/);
  assert.doesNotMatch(build[1].greetingInstruction, /今回の切り口/);
});

// 2026-11-13: 話しかけの16回中13回が「やっほー」で始まっていた
test('greeting decides the opening in code and passes the last opening to avoid', async () => {
  const run = async (randomValue) => {
    const calls = [];
    const dependencies = createDependencies(calls);
    dependencies.random = () => randomValue;
    dependencies.resolveThread = async () => ({
      threadId: 'thread-open',
      isNew: false,
      thread: {
        messages: [
          { role: 'assistant', text: 'やっほー！また来てくれたね', meta: { greeting: true }, createdAt: '2026-11-13T01:00:00.000Z' },
          { role: 'user', text: 'うん', createdAt: '2026-11-13T01:00:10.000Z' },
        ],
      },
    });
    dependencies.buildMantleInput = (input) => {
      calls.push(['build', input]);
      return input;
    };
    await createCoreChatService(dependencies)({
      sub: 'user-1', requestId: `req-open-${randomValue}`, text: '', images: [], greeting: true,
    });
    return calls.find(([name]) => name === 'build')[1].greetingInstruction;
  };
  assert.match(await run(0.1), /挨拶の言葉は付けずに/);
  assert.match(await run(0.9), /出だし「やっほー」とは違う/);
});

// 2026-11-13: 新しい会話の1回目は前の出だしが無く、ほぼ毎回「やっほー」だった。
// 「私のこと待ってた？」「ゲームの攻略法」を会話をまたいで繰り返していた
test('greeting remembers recent greetings per user and passes them to a new conversation', async () => {
  const run = async ({ recent }) => {
    const calls = [];
    const saved = [];
    const dependencies = createDependencies(calls);
    dependencies.random = () => 0.9;
    dependencies.getOrCreateUserSession = async () => ({ lastResponseId: '', recentGreetings: recent });
    dependencies.updateRecentGreetings = async (sub, list) => saved.push([sub, list]);
    dependencies.resolveThread = async () => ({ threadId: 'thread-new', isNew: true, thread: { messages: [] } });
    dependencies.buildMantleInput = (input) => {
      calls.push(['build', input]);
      return input;
    };
    await createCoreChatService(dependencies)({
      sub: 'user-1', requestId: 'req-recent', text: '', images: [], greeting: true,
    });
    return { instruction: calls.find(([name]) => name === 'build')[1].greetingInstruction, saved };
  };

  // 一度も話しかけていない人は「やっほー」を前回の出だしとして渡す
  const first = await run({ recent: [] });
  assert.match(first.instruction, /出だし「やっほー」とは違う/);
  assert.doesNotMatch(first.instruction, /最近の話しかけ/);
  assert.deepEqual(first.saved, [['user-1', ['やあ']]]);

  // 前の会話の話しかけを渡す（出だしも、話題も）
  const next = await run({ recent: ['お、また来た！ゲームの攻略法考えてた', 'やっほー！今日どうだった？'] });
  assert.match(next.instruction, /出だし「お」とは違う/);
  assert.match(next.instruction, /最近の話しかけ：「お、また来た！ゲームの攻略法考えてた」「やっほー！今日どうだった？」/);
  assert.deepEqual(next.saved[0][1], ['やあ', 'お、また来た！ゲームの攻略法考えてた', 'やっほー！今日どうだった？']);
});

// ── 会話の切り替えと記憶 ─────────────────────────

function runChat(overrides = {}, event = {}) {
  const calls = [];
  const dependencies = { ...createDependencies(calls), ...overrides };
  return createCoreChatService(dependencies)({
    sub: 'user-1',
    requestId: 'req-1',
    text: 'こんにちは',
    images: [],
    ...event,
  });
}

test('switching threads asks for a summary of the previous thread', async () => {
  // 以前は短い会話は週次バッチまで要約されず、記憶にも入らなかった
  const dispatched = [];
  await runChat({
    getOrCreateUserSession: async () => ({ activeThreadId: 'thread-old', lastResponseId: '' }),
    getThread: async (sub, threadId) => ({
      sub,
      threadId,
      messages: [
        { role: 'user', text: '猫を飼ってるんだ', createdAt: '2026-11-06T01:00:00.000Z' },
        { role: 'assistant', text: 'へえ', createdAt: '2026-11-06T01:00:00.000Z' },
      ],
    }),
    dispatchSummarization: async (params) => { dispatched.push(params); return true; },
  });

  assert.deepEqual(dispatched, [
    { sub: 'user-1', threadId: 'thread-old', reason: 'thread_switch' },
  ]);
});

test('staying in the same thread does not ask for a summary', async () => {
  const dispatched = [];
  await runChat({
    getOrCreateUserSession: async () => ({ activeThreadId: 'thread-test' }),
    getThread: async () => { throw new Error('should not read'); },
    dispatchSummarization: async (params) => { dispatched.push(params); return true; },
  });

  assert.deepEqual(dispatched, []);
});

test('a previous thread with nothing new since its summary is not summarized again', async () => {
  const dispatched = [];
  await runChat({
    getOrCreateUserSession: async () => ({ activeThreadId: 'thread-old' }),
    getThread: async () => ({
      summarizedAt: '2026-11-06T02:00:00.000Z',
      messages: [
        { role: 'user', text: '猫を飼ってるんだ', createdAt: '2026-11-06T01:00:00.000Z' },
        // 要約のあとに増えたのは話しかけ（assistant だけ）
        { role: 'assistant', text: 'おかえり', createdAt: '2026-11-06T03:00:00.000Z' },
      ],
    }),
    dispatchSummarization: async (params) => { dispatched.push(params); return true; },
  });

  assert.deepEqual(dispatched, []);
});

test('a failed summary request for the previous thread does not break the reply', async () => {
  const result = await runChat({
    getOrCreateUserSession: async () => ({ activeThreadId: 'thread-old' }),
    getThread: async () => { throw new Error('DynamoDB down'); },
  });

  assert.equal(result.ok, true);
  assert.equal(result.text, 'やあ');
});

test('a newer memory is sent again in a continued conversation', async () => {
  // 以前は記憶をスレッドの最初の1回しか渡さず、切り替えのあと作り直した記憶が届かなかった
  const built = [];
  const appended = [];
  await runChat({
    getOrCreateUserSession: async () => ({
      userMemory: '【事実】\n- 猫を飼っている',
      userMemoryUpdatedAt: '2026-11-06T03:00:00.000Z',
    }),
    resolveThread: async () => ({
      threadId: 'thread-test',
      thread: { memoryInjectedAt: '2026-11-01T00:00:00.000Z' },
      isNew: false,
    }),
    buildMantleInput: (input) => { built.push(input); return input; },
    appendTurn: async (params) => { appended.push(params); return {}; },
  });

  assert.equal(built[0].resendUserMemory, true);
  assert.equal(appended[0].memoryInjectedAt, '2026-11-06T03:00:00.000Z');
});

test('the same memory is not sent twice in a continued conversation', async () => {
  const built = [];
  const appended = [];
  await runChat({
    getOrCreateUserSession: async () => ({
      userMemory: '【事実】\n- 猫を飼っている',
      userMemoryUpdatedAt: '2026-11-06T03:00:00.000Z',
    }),
    resolveThread: async () => ({
      threadId: 'thread-test',
      thread: { memoryInjectedAt: '2026-11-06T03:00:00.000Z' },
      isNew: false,
    }),
    buildMantleInput: (input) => { built.push(input); return input; },
    appendTurn: async (params) => { appended.push(params); return {}; },
  });

  assert.equal(built[0].resendUserMemory, false);
  assert.equal(appended[0].memoryInjectedAt, '');
});

test('the first turn of a thread records the memory version it sent', async () => {
  const appended = [];
  await runChat({
    getOrCreateUserSession: async () => ({
      userMemory: '【事実】\n- 猫を飼っている',
      userMemoryUpdatedAt: '2026-11-06T03:00:00.000Z',
    }),
    getMantleSessionState: () => ({ usePreviousResponseId: false, previousResponseId: '' }),
    appendTurn: async (params) => { appended.push(params); return {}; },
  });

  assert.equal(appended[0].memoryInjectedAt, '2026-11-06T03:00:00.000Z');
});

// 2026-11-13: Mantle が黙っている間、アプリは「考えているよ」のままだった
test('a slow Mantle makes ライム say a waiting line once per stage, but not for greetings', async () => {
  const run = async (event) => {
    const calls = [];
    const lines = [];
    const dependencies = createDependencies(calls);
    dependencies.random = () => 0;
    const original = dependencies.createMantleResponse;
    dependencies.createMantleResponse = async (params) => {
      if (typeof params.onWaiting === 'function') {
        await params.onWaiting({ stage: 'slow' });
        await params.onWaiting({ stage: 'slow' });
        await params.onWaiting({ stage: 'retry' });
      }
      return original(params);
    };
    await createCoreChatService(dependencies)(
      { sub: 'user-1', requestId: 'req-wait', text: 'こんにちは', images: [], ...event },
      { onWaitingLine: async (text) => lines.push(text) }
    );
    return lines;
  };

  assert.deepEqual(await run({}), [
    'ちょっと待ってね、いま考えてる',
    'ごめん、頭が固まってた。もうちょっとだけ待って',
  ]);
  assert.deepEqual(await run({ text: '', greeting: true }), []);
});
