'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CoreEventError,
  normalizeCoreEvent,
} = require('../lib/core-event');

test('normalizeCoreEvent normalizes a direct Core Lambda event', () => {
  const result = normalizeCoreEvent({
    sub: ' user-1 ',
    requestId: ' req-1 ',
    connectionId: ' connection-1 ',
    text: 'こんにちは',
    images: [],
    source: 'websocket',
  });

  assert.deepEqual(result, {
    sub: 'user-1',
    requestId: 'req-1',
    connectionId: 'connection-1',
    source: 'websocket',
    text: 'こんにちは',
    images: [],
  });
});

test('normalizeCoreEvent unwraps one SQS record', () => {
  const result = normalizeCoreEvent({
    Records: [{
      body: JSON.stringify({
        schemaVersion: 1,
        type: 'chat.request',
        sub: 'user-1',
        requestId: 'req-1',
        connectionId: 'connection-1',
        source: 'websocket',
        text: 'hello',
        images: [],
      }),
    }],
  });

  assert.equal(result.source, 'websocket');
  assert.equal(result.text, 'hello');
  assert.equal(result.connectionId, 'connection-1');
  assert.deepEqual(result.images, []);
});

test('normalizeCoreEvent accepts the Edge Lambda Request Queue message shape', () => {
  const result = normalizeCoreEvent({
    Records: [{
      eventSource: 'aws:sqs',
      messageId: 'message-1',
      body: JSON.stringify({
        schemaVersion: 1,
        type: 'chat.request',
        requestId: 'req-001',
        connectionId: 'conn-001',
        sub: 'user-001',
        source: 'websocket',
        text: 'つまんないダジャレ言うぞ',
        images: [],
        createdAt: '2026-06-30T00:00:00.000Z',
      }),
    }],
  });

  assert.deepEqual(result, {
    sub: 'user-001',
    requestId: 'req-001',
    connectionId: 'conn-001',
    source: 'websocket',
    text: 'つまんないダジャレ言うぞ',
    images: [],
  });
});

test('normalizeCoreEvent rejects unsupported request schemaVersion', () => {
  assert.throws(
    () => normalizeCoreEvent({
      schemaVersion: 999,
      type: 'chat.request',
      sub: 'user-1',
      text: 'hello',
    }),
    /Unsupported Core request schemaVersion/
  );
});

test('normalizeCoreEvent rejects unsupported request type', () => {
  assert.throws(
    () => normalizeCoreEvent({
      schemaVersion: 1,
      type: 'unknown.request',
      sub: 'user-1',
      text: 'hello',
    }),
    /Unsupported Core request type/
  );
});

test('normalizeCoreEvent permits an image-only message', () => {
  const result = normalizeCoreEvent({
    sub: 'user-1',
    images: [{ media_type: 'image/png', data: 'AAAA' }],
  }, { fallbackRequestId: 'aws-request-1' });

  assert.equal(result.requestId, 'aws-request-1');
  assert.equal(result.text, '');
  assert.equal(result.images.length, 1);
});

test('normalizeCoreEvent rejects missing sub', () => {
  assert.throws(
    () => normalizeCoreEvent({ text: 'hello' }),
    (error) => error instanceof CoreEventError && error.message === 'sub is required'
  );
});

test('normalizeCoreEvent rejects an SQS batch instead of silently dropping records', () => {
  assert.throws(
    () => normalizeCoreEvent({ Records: [{ body: '{}' }, { body: '{}' }] }),
    /exactly one SQS record/
  );
});
