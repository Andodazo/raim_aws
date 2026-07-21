'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { toClientMessage } = require('../lib/client-message');

test('toClientMessage maps stream.start to client metadata', () => {
  assert.deepEqual(toClientMessage({
    type: 'stream.start',
    requestId: 'req-001',
    sequence: 0,
  }), {
    type: 'metadata',
    requestId: 'req-001',
    sequence: 0,
    emotions: {
      neutral: 1,
    },
    overall_intensity: 0.5,
    emotion: 'neutral',
    intensity: 0.5,
  });
});

test('toClientMessage maps stream.delta to client text_chunk', () => {
  assert.deepEqual(toClientMessage({
    type: 'stream.delta',
    requestId: 'req-001',
    sequence: 1,
    textDelta: 'こんにちは',
  }), {
    type: 'text_chunk',
    requestId: 'req-001',
    sequence: 1,
    text: 'こんにちは',
    chunk_id: 'req-001_chunk_1',
    is_first: true,
    is_filler: false,
  });
});

test('stream.delta preserves Core-provided chunkId', () => {
  const result = toClientMessage({
    type: 'stream.delta',
    requestId: 'req-001',
    sequence: 8,
    chunkId: 'req-001_chunk_2',
    textDelta: 'こんにちは。',
    isFirst: false,
    isFiller: true,
  });

  assert.equal(result.type, 'text_chunk');
  assert.equal(result.chunk_id, 'req-001_chunk_2');
  assert.equal(result.is_first, false);
  assert.equal(result.is_filler, true);
});

test('stream.delta maps Core isFiller to client is_filler', () => {
  const result = toClientMessage({
    type: 'stream.delta',
    requestId: 'req-001',
    sequence: 1,
    textDelta: '少々お待ちください',
    isFiller: true,
  });

  assert.equal(result.is_filler, true);
  assert.equal(result.chunk_id, 'req-001_chunk_1');
});

test('toClientMessage maps stream.audio to multipart audio_chunk', () => {
  assert.deepEqual(toClientMessage({
    type: 'stream.audio',
    requestId: 'req-001',
    sequence: 4,
    chunkId: 'req-001_chunk_0',
    format: 'wav',
    partIndex: 1,
    partCount: 3,
    audio: 'AAAA',
  }), {
    type: 'audio_chunk',
    requestId: 'req-001',
    sequence: 4,
    chunk_id: 'req-001_chunk_0',
    format: 'wav',
    part_index: 1,
    part_count: 3,
    is_first: false,
    is_last: false,
    audio: 'AAAA',
  });
});

test('toClientMessage maps single-part stream.audio to first and last audio_chunk', () => {
  assert.deepEqual(toClientMessage({
    type: 'stream.audio',
    requestId: 'req-001',
    sequence: 4,
    chunkId: 'req-001_chunk_0',
    audio: 'AAAA',
  }), {
    type: 'audio_chunk',
    requestId: 'req-001',
    sequence: 4,
    chunk_id: 'req-001_chunk_0',
    format: 'wav',
    part_index: 0,
    part_count: 1,
    is_first: true,
    is_last: true,
    audio: 'AAAA',
  });
});

test('toClientMessage rejects invalid stream.audio payloads as non-retriable', () => {
  const invalidEvents = [
    {
      type: 'stream.audio',
      requestId: 'req-001',
      sequence: 4,
      audio: 'AAAA',
    },
    {
      type: 'stream.audio',
      requestId: 'req-001',
      sequence: 4,
      chunkId: 'req-001_chunk_0',
      audio: '',
    },
    {
      type: 'stream.audio',
      requestId: 'req-001',
      sequence: 4,
      chunkId: 'req-001_chunk_0',
      partIndex: -1,
      partCount: 3,
      audio: 'AAAA',
    },
    {
      type: 'stream.audio',
      requestId: 'req-001',
      sequence: 4,
      chunkId: 'req-001_chunk_0',
      partIndex: 3,
      partCount: 3,
      audio: 'AAAA',
    },
    {
      type: 'stream.audio',
      requestId: 'req-001',
      sequence: 4,
      chunkId: 'req-001_chunk_0',
      partIndex: 0,
      partCount: 0,
      audio: 'AAAA',
    },
  ];

  for (const event of invalidEvents) {
    assert.throws(
      () => toClientMessage(event),
      (error) => error.retriable === false
    );
  }
});

test('toClientMessage maps stream.bubble_break to client bubble_break', () => {
  assert.deepEqual(toClientMessage({
    type: 'stream.bubble_break',
    requestId: 'req-001',
    sequence: 5,
  }), {
    type: 'bubble_break',
    requestId: 'req-001',
    sequence: 5,
  });
});

test('toClientMessage maps stream.tool to client tool_call', () => {
  assert.deepEqual(toClientMessage({
    type: 'stream.tool',
    requestId: 'req-001',
    sequence: 6,
    tool: 'get_weather',
    description: '東京の天気を調べています',
    estimatedSeconds: 3,
  }), {
    type: 'tool_call',
    requestId: 'req-001',
    sequence: 6,
    tool: 'get_weather',
    description: '東京の天気を調べています',
    estimated_seconds: 3,
  });
});

test('toClientMessage maps stream.completed to client chat_end', () => {
  assert.deepEqual(toClientMessage({
    type: 'stream.completed',
    requestId: 'req-001',
    sequence: 2,
    text: 'こんにちは！',
    emotion: 'happy',
    intensity: 0.6,
  }), {
    type: 'chat_end',
    requestId: 'req-001',
    sequence: 2,
    full_text: 'こんにちは！',
    emotions: {
      happy: 1,
    },
    overall_intensity: 0.6,
    emotion: 'happy',
    intensity: 0.6,
  });
});

test('toClientMessage normalizes multiple emotions for client chat_end', () => {
  const payload = toClientMessage({
    type: 'stream.completed',
    requestId: 'req-001',
    sequence: 2,
    text: 'いいね！',
    emotions: {
      happy: 0.6,
      caring: 0.3,
    },
    overall_intensity: 0.9,
  });

  assert.equal(payload.type, 'chat_end');
  assert.equal(payload.emotion, 'happy');
  assert.equal(payload.overall_intensity, 0.9);
  assert.equal(payload.intensity, 0.6);
  assert.equal(payload.emotions.happy, 0.667);
  assert.equal(payload.emotions.caring, 0.333);
});

test('toClientMessage maps stream.error to client error', () => {
  assert.deepEqual(toClientMessage({
    type: 'stream.error',
    requestId: 'req-001',
    sequence: 3,
    code: 'LLM_TIMEOUT',
    message: 'Core Lambda processing failed',
    retriable: true,
  }), {
    type: 'error',
    requestId: 'req-001',
    sequence: 3,
    code: 'LLM_TIMEOUT',
    message: 'Core Lambda processing failed',
    text: 'Core Lambda processing failed',
    emotions: {
      sad: 1,
    },
    overall_intensity: 0.5,
    emotion: 'sad',
    intensity: 0.5,
    retriable: true,
  });
});
