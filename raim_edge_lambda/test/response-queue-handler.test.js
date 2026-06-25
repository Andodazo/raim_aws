'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createResponseQueueHandler } = require('../lib/response-queue-handler');

test('response queue handler posts stream events to WebSocket', async () => {
  const posted = [];
  const handler = createResponseQueueHandler({
    postback: {
      postJson: async (connectionId, payload) => {
        posted.push({ connectionId, payload });
        return { ok: true };
      },
    },
    connectionStore: {
      deleteConnection: async () => {},
    },
  });

  const result = await handler({
    Records: [
      {
        messageId: 'msg-001',
        body: JSON.stringify({
          type: 'stream.delta',
          requestId: 'req-001',
          connectionId: 'conn-001',
          sequence: 1,
          textDelta: 'こんにちは',
        }),
      },
    ],
  });

  assert.deepEqual(result, { batchItemFailures: [] });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].connectionId, 'conn-001');
  assert.deepEqual(posted[0].payload, {
    type: 'stream.delta',
    requestId: 'req-001',
    sequence: 1,
    textDelta: 'こんにちは',
  });
});

test('response queue handler deletes gone connections without retrying', async () => {
  const deleted = [];
  const handler = createResponseQueueHandler({
    postback: {
      postJson: async () => ({ ok: false, gone: true }),
    },
    connectionStore: {
      deleteConnection: async (connectionId) => deleted.push(connectionId),
    },
  });

  const result = await handler({
    Records: [
      {
        messageId: 'msg-001',
        body: JSON.stringify({
          type: 'stream.completed',
          requestId: 'req-001',
          connectionId: 'conn-001',
          sequence: 2,
          text: 'やあ',
          emotion: 'happy',
          intensity: 0.6,
        }),
      },
    ],
  });

  assert.deepEqual(result, { batchItemFailures: [] });
  assert.deepEqual(deleted, ['conn-001']);
});

test('response queue handler returns partial batch failures for retriable errors', async () => {
  const handler = createResponseQueueHandler({
    postback: {
      postJson: async () => {
        throw new Error('temporary failure');
      },
    },
    connectionStore: {
      deleteConnection: async () => {},
    },
    logger: {
      error: () => {},
    },
  });

  const result = await handler({
    Records: [
      {
        messageId: 'msg-001',
        body: JSON.stringify({
          type: 'stream.delta',
          requestId: 'req-001',
          connectionId: 'conn-001',
          sequence: 1,
          textDelta: 'こんにちは',
        }),
      },
    ],
  });

  assert.deepEqual(result, {
    batchItemFailures: [
      { itemIdentifier: 'msg-001' },
    ],
  });
});
