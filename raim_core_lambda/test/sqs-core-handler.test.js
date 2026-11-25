'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  USER_FACING_ERROR_MESSAGE,
  computeDeadlines,
  createSqsCoreHandler,
} = require('../lib/sqs-core-handler');

function createRecord(messageId = 'message-1') {
  return {
    messageId,
    eventSource: 'aws:sqs',
    attributes: { ApproximateReceiveCount: '1' },
    body: '{}',
  };
}

test('streams extracted chat text and completes the request state', async () => {
  const events = [];
  const completedStates = [];
  const publisher = {
    start: async () => events.push(['start']),
    appendText: async (text) => events.push(['delta', text]),
    completed: async (result) => events.push(['completed', result.text]),
    error: async (result) => events.push(['error', result.code]),
  };
  const handler = createSqsCoreHandler({
    normalizeCoreEvent: () => ({
      sub: 'user-1',
      requestId: 'req-1',
      connectionId: 'connection-1',
      source: 'websocket',
      text: 'hello',
      images: [],
    }),
    claimRequest: async () => ({
      claimed: true,
      requestKey: 'user-1#req-1',
    }),
    createResponseQueuePublisher: () => publisher,
    handleCoreChat: async (input, options) => {
      await options.onMantleTextDelta('{"text":"こん');
      await options.onMantleTextDelta('にちは","emotion":"happy"}');
      return {
        ok: true,
        type: 'chat',
        requestId: input.requestId,
        text: 'こんにちは',
        emotion: 'happy',
        intensity: 0.6,
      };
    },
    markRequestCompleted: async (state) => completedStates.push(state),
    markRequestFailed: async () => {},
  });

  const result = await handler({ Records: [createRecord()] }, {
    awsRequestId: 'invocation-1',
  });

  assert.deepEqual(result, { batchItemFailures: [] });
  assert.deepEqual(events, [
    ['start'],
    ['delta', 'こん'],
    ['delta', 'にちは'],
    ['completed', 'こんにちは'],
  ]);
  assert.equal(completedStates.length, 1);
});

test('returns only failed SQS records in batchItemFailures', async () => {
  const handler = createSqsCoreHandler({
    normalizeCoreEvent: () => {
      throw new Error('invalid record');
    },
  });

  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const result = await handler({ Records: [createRecord('failed-1')] }, {});
    assert.deepEqual(result, {
      batchItemFailures: [{ itemIdentifier: 'failed-1' }],
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test('does not retry non-retriable invalid request messages', async () => {
  const handler = createSqsCoreHandler({
    normalizeCoreEvent: () => {
      const error = new Error('invalid request');
      error.retriable = false;
      throw error;
    },
  });

  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const result = await handler({ Records: [createRecord('invalid-1')] }, {});
    assert.deepEqual(result, {
      batchItemFailures: [],
    });
  } finally {
    console.error = originalConsoleError;
  }
});

test('passes client actions from the tool loop to the publisher', async () => {
  const events = [];
  const publisher = {
    start: async () => events.push(['start']),
    appendText: async () => {},
    toolCall: async ({ toolName }) => events.push(['tool', toolName]),
    clientAction: async ({ action, params }) => events.push(['action', action, params]),
    completed: async () => events.push(['completed']),
    error: async () => events.push(['error']),
  };
  const handler = createSqsCoreHandler({
    normalizeCoreEvent: () => ({
      sub: 'user-1',
      requestId: 'req-1',
      connectionId: 'connection-1',
      source: 'websocket',
      text: '新宿で起こして',
      images: [],
      features: ['station_alarm'],
    }),
    claimRequest: async () => ({ claimed: true, requestKey: 'user-1#req-1' }),
    createResponseQueuePublisher: () => publisher,
    handleCoreChat: async (input, options) => {
      await options.onToolCallStart({ toolName: 'start_station_alarm', introText: '' });
      await options.onClientAction({
        action: 'station_alarm.start',
        params: { station: '新宿' },
      });
      return { ok: true, type: 'chat', requestId: input.requestId, text: '新宿ね' };
    },
    markRequestCompleted: async () => {},
    markRequestFailed: async () => {},
  });

  await handler({ Records: [createRecord()] }, { awsRequestId: 'invocation-1' });

  assert.deepEqual(events, [
    ['start'],
    ['tool', 'start_station_alarm'],
    ['action', 'station_alarm.start', { station: '新宿' }],
    ['completed'],
  ]);
});

test('アプリで声を消しているときは TTS を使わない', async () => {
  let ttsCreated = 0;
  let publisherTts = 'unset';
  const handler = createSqsCoreHandler({
    normalizeCoreEvent: () => ({
      sub: 'user-1',
      requestId: 'req-mute',
      connectionId: 'connection-1',
      source: 'websocket',
      text: 'hello',
      images: [],
      speech: false,
    }),
    claimRequest: async () => ({ claimed: true, requestKey: 'user-1#req-mute' }),
    createTtsClient: () => {
      ttsCreated += 1;
      return { synthesize: async () => ({ ok: true }) };
    },
    createResponseQueuePublisher: (_meta, options) => {
      publisherTts = options.ttsClient;
      return {
        start: async () => {},
        appendText: async () => {},
        emotion: async () => {},
        completed: async () => {},
        error: async () => {},
      };
    },
    handleCoreChat: async (input) => ({ ok: true, type: 'chat', requestId: input.requestId, text: 'ok' }),
    markRequestCompleted: async () => {},
    markRequestFailed: async () => {},
  });

  await handler({ Records: [createRecord('mute-1')] }, { awsRequestId: 'invocation-mute' });

  assert.equal(ttsCreated, 0);
  assert.equal(publisherTts, null);
});

// 2026-11-13: 予定の知らせる文・「予定に入れる？」を待ってから返事の終わりを送っていたので、
// 予定を入れた回は入力欄が最大8秒「考えているよ」のままだった
test('after-reply tasks run after stream.completed and the request is marked completed', async () => {
  const events = [];
  const publisher = {
    start: async () => events.push(['start']),
    appendText: async () => {},
    toolCall: async () => {},
    clientAction: async ({ action }) => events.push(['action', action]),
    completed: async () => events.push(['completed']),
    error: async () => events.push(['error']),
  };
  const handler = createSqsCoreHandler({
    normalizeCoreEvent: () => ({
      sub: 'user-1', requestId: 'req-1', connectionId: 'connection-1', source: 'websocket',
      text: '土曜に映画なんだ', images: [], features: ['planner'],
    }),
    claimRequest: async () => ({ claimed: true, requestKey: 'user-1#req-1' }),
    createResponseQueuePublisher: () => publisher,
    handleCoreChat: async (input, options) => {
      options.deferAfterReply(async () => {
        await options.onClientAction({ action: 'planner.suggest', params: {} });
      });
      // 失敗しても会話には響かない
      options.deferAfterReply(async () => { throw new Error('boom'); });
      return { ok: true, type: 'chat', requestId: input.requestId, text: 'いいね' };
    },
    markRequestCompleted: async () => events.push(['marked']),
    markRequestFailed: async () => events.push(['failed']),
  });

  const result = await handler({ Records: [createRecord()] }, { awsRequestId: 'invocation-1' });

  assert.deepEqual(result, { batchItemFailures: [] });
  assert.deepEqual(events, [['start'], ['completed'], ['marked'], ['action', 'planner.suggest']]);
});

test('tts.warmup は TTS を温めるだけで、会話の処理はしない', async () => {
  const warmups = [];
  let chatCalled = false;
  const handler = createSqsCoreHandler({
    createTtsClient: () => ({ warmup: async (job) => warmups.push(job) }),
    normalizeCoreEvent: () => { chatCalled = true; throw new Error('should not be called'); },
    claimRequest: async () => { chatCalled = true; return { claimed: false }; },
  });

  const result = await handler({
    Records: [{ ...createRecord('warm-1'), body: JSON.stringify({ type: 'tts.warmup', reason: 'connect' }) }],
  }, {});

  assert.deepEqual(warmups, [{ reason: 'connect' }]);
  assert.equal(chatCalled, false);
  assert.deepEqual(result.batchItemFailures, []);
});

test('tts.warmup が失敗しても、メッセージは失敗にしない', async () => {
  const handler = createSqsCoreHandler({
    createTtsClient: () => ({ warmup: async () => { throw new Error('boom'); } }),
  });

  const result = await handler({
    Records: [{ ...createRecord('warm-2'), body: JSON.stringify({ type: 'tts.warmup' }) }],
  }, {});

  assert.deepEqual(result.batchItemFailures, []);
});

test('TTS が未設定なら tts.warmup は何もしない', async () => {
  const handler = createSqsCoreHandler({ createTtsClient: () => null });

  const result = await handler({
    Records: [{ ...createRecord('warm-3'), body: JSON.stringify({ type: 'tts.warmup' }) }],
  }, {});

  assert.deepEqual(result.batchItemFailures, []);
});

// ── Mantle 失敗のあと（2026-11-25: SQS のやり直しで接続が約3分止まっていた） ─────────

function chatInput() {
  return {
    sub: 'user-1',
    requestId: 'req-1',
    connectionId: 'connection-1',
    source: 'websocket',
    text: 'hello',
    images: [],
  };
}

function quietly(fn) {
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  return Promise.resolve().then(fn).finally(() => {
    console.error = originalError;
    console.warn = originalWarn;
  });
}

test('stream.start を送ったあとの失敗は、日本語のエラーを送って SQS にやり直させない', async () => {
  const events = [];
  const handler = createSqsCoreHandler({
    normalizeCoreEvent: chatInput,
    claimRequest: async () => ({ claimed: true, requestKey: 'user-1#req-1' }),
    createResponseQueuePublisher: () => ({
      start: async () => events.push(['start']),
      appendText: async () => {},
      completed: async () => events.push(['completed']),
      error: async (result) => events.push(['error', result.code, result.message]),
    }),
    handleCoreChat: async () => {
      const error = new Error('Mantle request timed out');
      error.coreErrorCode = 'LLM_TIMEOUT';
      error.retriable = true;
      throw error;
    },
    markRequestCompleted: async () => events.push(['marked']),
    markRequestFailed: async () => events.push(['failed']),
  });

  const result = await quietly(() => handler({ Records: [createRecord('m-1')] }, { awsRequestId: 'inv-1' }));

  assert.deepEqual(result, { batchItemFailures: [] });
  assert.deepEqual(events, [
    ['start'],
    ['error', 'LLM_TIMEOUT', USER_FACING_ERROR_MESSAGE],
    ['failed'],
  ]);
});

test('stream.start を送る前の失敗は、これまでどおり SQS にやり直させる', async () => {
  const handler = createSqsCoreHandler({
    normalizeCoreEvent: chatInput,
    claimRequest: async () => ({ claimed: true, requestKey: 'user-1#req-1' }),
    createResponseQueuePublisher: () => ({
      start: async () => { throw new Error('SQS unavailable'); },
      error: async () => {},
    }),
    handleCoreChat: async () => { throw new Error('should not be called'); },
    markRequestCompleted: async () => {},
    markRequestFailed: async () => {},
  });

  const result = await quietly(() => handler({ Records: [createRecord('m-2')] }, {}));
  assert.deepEqual(result, { batchItemFailures: [{ itemIdentifier: 'm-2' }] });
});

test('ok:false の返事も、アプリに出す文は日本語にする（消した会話はそのまま）', async () => {
  const sent = [];
  const makeHandler = (coreResult) => createSqsCoreHandler({
    normalizeCoreEvent: chatInput,
    claimRequest: async () => ({ claimed: true, requestKey: 'user-1#req-1' }),
    createResponseQueuePublisher: () => ({
      start: async () => {},
      appendText: async () => {},
      completed: async () => {},
      error: async (result) => sent.push([result.code, result.message]),
    }),
    handleCoreChat: async () => coreResult,
    markRequestCompleted: async () => {},
    markRequestFailed: async () => {},
  });

  await makeHandler({ ok: false, code: 'INVALID_RESPONSE', message: 'Model response was invalid' })({ Records: [createRecord()] }, {});
  await makeHandler({ ok: false, code: 'THREAD_DELETED', message: 'Conversation thread was deleted' })({ Records: [createRecord()] }, {});

  assert.deepEqual(sent, [
    ['INVALID_RESPONSE', USER_FACING_ERROR_MESSAGE],
    ['THREAD_DELETED', 'Conversation thread was deleted'],
  ]);
});

test('Lambda の残り時間から締め切りを決め、handleCoreChat と publisher に渡す', async () => {
  let chatDeadline = null;
  let publisherOptions = null;
  const handler = createSqsCoreHandler({
    normalizeCoreEvent: chatInput,
    claimRequest: async () => ({ claimed: true, requestKey: 'user-1#req-1' }),
    createResponseQueuePublisher: (request, options) => {
      publisherOptions = options;
      return { start: async () => {}, appendText: async () => {}, completed: async () => {}, error: async () => {} };
    },
    handleCoreChat: async (input, options) => {
      chatDeadline = options.deadlineAt;
      return { ok: true, type: 'chat', requestId: input.requestId, text: 'やあ' };
    },
    markRequestCompleted: async () => {},
    markRequestFailed: async () => {},
  });

  const before = Date.now();
  await handler({ Records: [createRecord()] }, { getRemainingTimeInMillis: () => 60000 });

  assert.ok(chatDeadline >= before + 52000 - 50 && chatDeadline <= Date.now() + 52000);
  assert.ok(publisherOptions.audioDeadlineAt >= before + 58000 - 50 && publisherOptions.audioDeadlineAt <= Date.now() + 58000);
});

test('computeDeadlines: 残り時間がわからなければ締め切りなし、環境変数で取り置きを変えられる', () => {
  assert.deepEqual(computeDeadlines({}), { deadlineAt: 0, audioDeadlineAt: 0 });
  assert.deepEqual(
    computeDeadlines({ getRemainingTimeInMillis: () => 30000 }, { CORE_DEADLINE_RESERVE_MS: '5000', CORE_AUDIO_RESERVE_MS: '1000' }, 1000),
    { deadlineAt: 26000, audioDeadlineAt: 30000 }
  );
});
