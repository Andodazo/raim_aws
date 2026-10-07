'use strict';

// 本文より先に感情を送る（立ち絵の表情を早く変える）

const test = require('node:test');
const assert = require('node:assert/strict');

const { StreamingChatJsonExtractor } = require('../lib/streaming-chat-json-extractor');
const { createResponseQueuePublisher } = require('../lib/response-queue-publisher');
const { createSqsCoreHandler } = require('../lib/sqs-core-handler');
const { buildFewShotMessages } = require('../lib/prompt-builder');
const { buildSystemPrompt, getPersonaDigest } = require('../lib/prompts/raim-system-prompt');

async function feed(raw, size = 3) {
  const log = [];
  const extractor = new StreamingChatJsonExtractor({
    onText: (text) => log.push(['text', text]),
    onEmotions: (value) => log.push(['emotions', value]),
  });
  for (let i = 0; i < raw.length; i += size) {
    await extractor.push(raw.slice(i, i + size));
  }
  return log;
}

test('emotions written before text are reported before any text', async () => {
  const log = await feed('{"emotions":{"happy":0.6,"caring":0.3},"overall_intensity":0.8,"text":"やったね！"}');
  assert.equal(log[0][0], 'emotions');
  assert.deepEqual(log[0][1], { emotions: { happy: 0.6, caring: 0.3 }, overall_intensity: 0.8 });
  assert.equal(log.slice(1).map(([, t]) => t).join(''), 'やったね！');
});

test('emotions without overall_intensity are reported when text starts', async () => {
  const log = await feed('{"emotions":{"sad":0.5},"text":"そっか"}');
  assert.equal(log[0][0], 'emotions');
  assert.equal(log[0][1].overall_intensity, undefined);
});

test('old order (text first) still reports emotions once, after the text', async () => {
  const log = await feed('{"text":"うん","emotions":{"neutral":0.5}}');
  assert.deepEqual(log.map(([k]) => k), ['text', 'emotions']);
});

test('emotions are reported only once', async () => {
  const log = await feed('{"emotions":{"happy":0.6},"text":"a","emotions":{"sad":0.5}}');
  assert.equal(log.filter(([k]) => k === 'emotions').length, 1);
});

test('publisher sends stream.emotion once, before deltas', async () => {
  const commands = [];
  const publisher = createResponseQueuePublisher({
    requestId: 'req-1', connectionId: 'c', sub: 'u', source: 'websocket',
  }, {
    client: { send: async (command) => commands.push(command.input) },
    env: { RESPONSE_QUEUE_URL: 'https://sqs.example/r.fifo', STREAM_CHUNK_MIN_CHARACTERS: '1' },
  });

  await publisher.start();
  await publisher.emotion({ emotions: { happy: 1 }, overall_intensity: 0.8, emotion: 'happy', intensity: 0.8 });
  await publisher.emotion({ emotions: { sad: 1 }, overall_intensity: 0.5, emotion: 'sad', intensity: 0.5 });
  await publisher.appendText('こんにちは');
  await publisher.completed({ text: 'こんにちは', emotion: 'happy', intensity: 0.8 });

  const messages = commands.map((command) => JSON.parse(command.MessageBody));
  assert.deepEqual(messages.map((m) => m.type), ['stream.start', 'stream.emotion', 'stream.delta', 'stream.completed']);
  assert.deepEqual(messages[1].emotions, { happy: 1 });
});

test('SQS handler turns early emotions into stream.emotion and updates the voice', async () => {
  const events = [];
  const voiceCalls = [];
  const publisher = {
    start: async () => events.push('start'),
    emotion: async (value) => events.push(['emotion', value.emotion, value.overall_intensity]),
    appendText: async (text) => events.push(['delta', text]),
    completed: async () => events.push('completed'),
    error: async () => events.push('error'),
  };

  const handler = createSqsCoreHandler({
    normalizeCoreEvent: () => ({ sub: 'u', requestId: 'r', connectionId: 'c', source: 'websocket', text: 'x', images: [] }),
    claimRequest: async () => ({ claimed: true, requestKey: 'u#r' }),
    createResponseQueuePublisher: () => publisher,
    createTtsClient: () => null,
    getVoiceParamsFromEmotions: (emotions, overall) => {
      voiceCalls.push([emotions, overall]);
      return {};
    },
    handleCoreChat: async (input, options) => {
      await options.onMantleTextDelta('{"emotions":{"happy":0.6,"caring":0.3},');
      await options.onMantleTextDelta('"overall_intensity":0.8,"text":"やった');
      await options.onMantleTextDelta('ね"}');
      return { ok: true, type: 'chat', text: 'やったね', emotion: 'happy', intensity: 0.5 };
    },
    markRequestCompleted: async () => {},
    markRequestFailed: async () => {},
  });

  await handler({ Records: [{ messageId: 'm', eventSource: 'aws:sqs', attributes: {}, body: '{}' }] }, { awsRequestId: 'i' });

  assert.deepEqual(events[0], 'start');
  assert.deepEqual(events[1], ['emotion', 'happy', 0.8]);
  assert.deepEqual(events[2][0], 'delta');
  assert.ok(voiceCalls.some(([emotions, overall]) => emotions && emotions.happy && overall === 0.8));
});

test('few-shot examples and output rules put emotions before text', () => {
  const messages = buildFewShotMessages({
    id: 'x',
    few_shots: [{ user: 'こんにちは', raim: 'やあ', emotions: { happy: 0.5 } }],
  }, 'bright');
  const content = messages[1].content;
  assert.ok(content.indexOf('"emotions"') < content.indexOf('"text"'));

  for (const prompt of [buildSystemPrompt({ withTools: true }), buildSystemPrompt(), getPersonaDigest('bright')]) {
    assert.ok(!/\{"text"/.test(prompt), 'text が先の JSON 例が残っている');
  }
});

test('publisher tells the client which persona is active', async () => {
  const commands = [];
  const publisher = createResponseQueuePublisher({
    requestId: 'req-2', connectionId: 'c', sub: 'u', source: 'websocket',
  }, {
    client: { send: async (command) => commands.push(command.input) },
    env: { RESPONSE_QUEUE_URL: 'https://sqs.example/r.fifo' },
    persona: 'downer',
  });

  await publisher.start();
  await publisher.completed({ text: 'ん', emotion: 'neutral', intensity: 0.5 });

  const messages = commands.map((command) => JSON.parse(command.MessageBody));
  assert.equal(messages[0].persona, 'downer');
  assert.equal(messages[1].persona, 'downer');
});
