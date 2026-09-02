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

test('starts TTS per sentence and publishes audio in chunk order', async () => {
  const commands = [];
  const ttsCalls = [];
  const client = {
    send: async (command) => commands.push(command.input),
  };
  const publisher = createResponseQueuePublisher({
    requestId: 'req-tts',
    connectionId: 'connection-1',
    sub: 'user-1',
    source: 'websocket',
  }, {
    client,
    env: {
      RESPONSE_QUEUE_URL: 'https://sqs.example/response.fifo',
      STREAM_CHUNK_MIN_CHARACTERS: '1',
      STREAM_CHUNK_MAX_CHARACTERS: '30',
      TTS_AUDIO_FRAGMENT_BASE64_CHARACTERS: '8',
    },
    ttsClient: {
      synthesize: async (request) => {
        ttsCalls.push(request);
        return {
          ok: true,
          format: 'wav',
          contentType: 'audio/wav',
          audio: request.chunkId === 'req-tts_chunk_0' ? 'AAAAAAAAAA' : 'BBBB',
          audioByteLength: 8,
        };
      },
    },
    getVoiceParams: () => ({ speaker_id: 8 }),
  });

  await publisher.start();
  await publisher.appendText('こんにちは。');
  await publisher.appendText('元気です！');
  await publisher.completed({ text: 'こんにちは。元気です！' });

  const messages = commands.map((command) => JSON.parse(command.MessageBody));
  const textMessages = messages.filter((message) => message.type === 'stream.delta');
  const audioMessages = messages.filter((message) => message.type === 'stream.audio');

  assert.deepEqual(textMessages.map((message) => [message.textDelta, message.chunkId]), [
    ['こんにちは。', 'req-tts_chunk_0'],
    ['元気です！', 'req-tts_chunk_1'],
  ]);
  assert.deepEqual(ttsCalls.map((call) => call.chunkId), [
    'req-tts_chunk_0',
    'req-tts_chunk_1',
  ]);
  assert.deepEqual(audioMessages.map((message) => [
    message.chunkId,
    message.partIndex,
    message.partCount,
    message.isLast,
  ]), [
    ['req-tts_chunk_0', 0, 2, false],
    ['req-tts_chunk_0', 1, 2, true],
    ['req-tts_chunk_1', 0, 1, true],
  ]);
  assert.equal(messages.at(-1).type, 'stream.completed');
});
