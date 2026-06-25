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
        sub: 'user-1',
        requestId: 'req-1',
        text: 'hello',
      }),
    }],
  });

  assert.equal(result.source, 'sqs');
  assert.equal(result.text, 'hello');
  assert.deepEqual(result.images, []);
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
