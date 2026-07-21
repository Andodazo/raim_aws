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

// ─────────────────────────────────────────────
// v14: bubble_break
// ─────────────────────────────────────────────

function makeCapturingPublisher() {
  const commands = [];
  const client = { send: async (command) => commands.push(command.input) };
  const publisher = createResponseQueuePublisher({
    requestId: 'req-1',
    connectionId: 'connection-1',
    sub: 'user-1',
    source: 'websocket',
  }, {
    client,
    env: {
      RESPONSE_QUEUE_URL: 'https://sqs.example/response.fifo',
      STREAM_CHUNK_MIN_CHARACTERS: '1',
    },
  });
  const types = () => commands.map((c) => JSON.parse(c.MessageBody).type);
  const bodies = () => commands.map((c) => JSON.parse(c.MessageBody));
  return { publisher, types, bodies };
}

test('v14: tool intro の後、本文deltaの直前に bubble_break が入る', async () => {
  const { publisher, types, bodies } = makeCapturingPublisher();

  await publisher.start();
  await publisher.toolCall({
    toolName: 'get_weather',
    description: '東京の天気を調べています',
    introText: '天気見てくる、ちょっと待って',
  });
  await publisher.appendText('東京は晴れだよ');
  await publisher.completed({
    text: '東京は晴れだよ',
    emotions: { happy: 1 },
    overall_intensity: 0.6,
    emotion: 'happy',
    intensity: 0.6,
  });

  assert.deepEqual(types(), [
    'stream.start',
    'stream.delta',        // intro
    'stream.tool',
    'stream.bubble_break',
    'stream.delta',        // 本文
    'stream.completed',
  ]);

  // introのdeltaには isFiller が付く
  const introDelta = bodies()[1];
  assert.equal(introDelta.isFiller, true);
});

test('v14: ツールを使わない通常会話では bubble_break を送らない', async () => {
  const { publisher, types } = makeCapturingPublisher();

  await publisher.start();
  await publisher.appendText('こんにちは！');
  await publisher.completed({
    text: 'こんにちは！',
    emotions: { happy: 1 },
    overall_intensity: 0.5,
    emotion: 'happy',
    intensity: 0.5,
  });

  assert.ok(!types().includes('stream.bubble_break'));
});

test('v14: bubble_break は1ターンにつき1回だけ', async () => {
  const { publisher, types } = makeCapturingPublisher();

  await publisher.start();
  await publisher.toolCall({
    toolName: 'web_search',
    description: '検索中',
    introText: 'ちょっと調べてみるね',
  });
  await publisher.appendText('調べた');
  await publisher.appendText('結果はこう');
  await publisher.completed({
    text: '調べた結果はこう',
    emotions: { curious: 1 },
    overall_intensity: 0.7,
    emotion: 'curious',
    intensity: 0.7,
  });

  const count = types().filter((t) => t === 'stream.bubble_break').length;
  assert.equal(count, 1);
});
