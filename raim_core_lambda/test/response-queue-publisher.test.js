'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createResponseQueuePublisher,
} = require('../lib/response-queue-publisher');

test('publishes ordered FIFO stream events and buffers small deltas', async () => {
  const commands = [];
  const client = {
    send: async (command) => commands.push(command.input),
  };
  const publisher = createResponseQueuePublisher({
    requestId: 'req-1',
    connectionId: 'connection-1',
    sub: 'user-1',
    source: 'websocket',
  }, {
    client,
    env: {
      RESPONSE_QUEUE_URL: 'https://sqs.example/response.fifo',
      STREAM_CHUNK_MIN_CHARACTERS: '5',
    },
  });

  await publisher.start();
  await publisher.appendText('こん');
  await publisher.appendText('にちは');
  await publisher.completed({
    text: 'こんにちは',
    emotion: 'happy',
    intensity: 0.6,
  });

  const messages = commands.map((command) => JSON.parse(command.MessageBody));
  assert.deepEqual(messages.map((message) => message.type), [
    'stream.start',
    'stream.delta',
    'stream.completed',
  ]);
  assert.deepEqual(messages.map((message) => message.sequence), [0, 1, 2]);
  assert.equal(messages[1].textDelta, 'こんにちは');
  assert.equal(commands.every((command) => command.MessageGroupId === 'req-1'), true);
});
