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
    listScenes: async () => [{ id: 'default' }],
    selectScene: ({ userText }) => ({ scene: { id: 'default' }, userText }),
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
