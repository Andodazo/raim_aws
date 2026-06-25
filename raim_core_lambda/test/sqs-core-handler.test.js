'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSqsCoreHandler } = require('../lib/sqs-core-handler');

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
