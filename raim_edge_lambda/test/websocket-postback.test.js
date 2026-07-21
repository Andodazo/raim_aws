'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createWebSocketPostback,
} = require('../lib/websocket-postback');

function createTestEnv(overrides = {}) {
  return {
    AWS_REGION: 'ap-northeast-1',
    REQUEST_QUEUE_URL: 'https://sqs.ap-northeast-1.amazonaws.com/123456789012/RAiM-CoreRequest-dev.fifo',
    CONNECTION_TABLE_NAME: 'RAiM-WebSocketConnection-dev',
    WEBSOCKET_API_ENDPOINT: 'https://example.execute-api.ap-northeast-1.amazonaws.com/dev',
    CONNECTION_TTL_SECONDS: '86400',
    ...overrides,
  };
}

test('postJson sends payloads below the WebSocket size limit', async () => {
  const sent = [];
  const postback = createWebSocketPostback({
    env: createTestEnv({
      MAX_WEBSOCKET_MESSAGE_BYTES: '30720',
    }),
    client: {
      send: async (command) => {
        sent.push(command.input);
        return {};
      },
    },
  });

  const result = await postback.postJson('conn-001', {
    type: 'audio_chunk',
    requestId: 'req-001',
    chunk_id: 'req-001_chunk_0',
    part_index: 0,
    audio: 'A'.repeat(100),
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].ConnectionId, 'conn-001');
  assert.ok(Buffer.isBuffer(sent[0].Data));
});

test('postJson rejects oversized payloads as non-retriable', async () => {
  let sendCalled = false;
  const postback = createWebSocketPostback({
    env: createTestEnv({
      MAX_WEBSOCKET_MESSAGE_BYTES: '128',
    }),
    client: {
      send: async () => {
        sendCalled = true;
        return {};
      },
    },
  });

  await assert.rejects(
    () => postback.postJson('conn-001', {
      type: 'audio_chunk',
      requestId: 'req-001',
      chunk_id: 'req-001_chunk_0',
      part_index: 0,
      audio: 'A'.repeat(512),
    }),
    (error) => {
      assert.equal(error.code, 'WEBSOCKET_PAYLOAD_TOO_LARGE');
      assert.equal(error.retriable, false);
      assert.equal(error.details.maximumBytes, 128);
      assert.equal(error.details.type, 'audio_chunk');
      assert.equal(error.details.requestId, 'req-001');
      assert.equal(error.details.chunkId, 'req-001_chunk_0');
      assert.equal(error.details.partIndex, 0);
      assert.equal(Object.hasOwn(error.details, 'audio'), false);
      return true;
    }
  );

  assert.equal(sendCalled, false);
});
