'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRequestQueuePublisher } = require('../lib/request-queue-publisher');

const ENV = {
  REQUEST_QUEUE_URL: 'https://sqs.example/q.fifo',
  RESPONSE_QUEUE_URL: 'https://sqs.example/r.fifo',
  CONNECTION_TABLE_NAME: 'RAiM-WebSocketConnection-dev',
  WEBSOCKET_API_ENDPOINT: 'https://example.com/dev',
  AWS_REGION: 'ap-northeast-1',
};

function capture() {
  const sent = [];
  const publisher = createRequestQueuePublisher({
    client: { send: async (command) => sent.push(command.input) },
    env: ENV,
  });
  return { publisher, sent };
}

const base = { requestId: 'req-001', connectionId: 'conn-001', text: 'hi', images: [] };

test('the same requestId from different people is not treated as a duplicate', async () => {
  const { publisher, sent } = capture();

  await publisher.publishChatRequest({ ...base, sub: 'user-a' });
  await publisher.publishChatRequest({ ...base, sub: 'user-b' });

  assert.notEqual(sent[0].MessageDeduplicationId, sent[1].MessageDeduplicationId);
});

test('a resend from the same person keeps the same deduplication id', async () => {
  const { publisher, sent } = capture();

  await publisher.publishChatRequest({ ...base, sub: 'user-a' });
  await publisher.publishChatRequest({ ...base, sub: 'user-a' });

  assert.equal(sent[0].MessageDeduplicationId, sent[1].MessageDeduplicationId);
  assert.ok(sent[0].MessageDeduplicationId.length <= 128);
});
