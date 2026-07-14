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
      happy: 2,
      caring: 1,
    },
    overall_intensity: 0.9,
  });

  assert.equal(payload.type, 'chat_end');
  assert.equal(payload.emotion, 'happy');
  assert.equal(payload.overall_intensity, 0.9);
  assert.equal(payload.intensity, 0.6);
  assert.ok(Math.abs(payload.emotions.happy - (2 / 3)) < 1e-9);
  assert.ok(Math.abs(payload.emotions.caring - (1 / 3)) < 1e-9);
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
