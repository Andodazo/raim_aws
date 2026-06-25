'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createCoreChat,
  createCoreError,
  removeInternalFields,
} = require('../lib/core-response');

test('createCoreChat returns the Edge-friendly success envelope', () => {
  assert.deepEqual(createCoreChat({
    requestId: 'req-1',
    text: 'hello',
    emotion: 'happy',
    intensity: 0.7,
  }), {
    ok: true,
    type: 'chat',
    text: 'hello',
    emotion: 'happy',
    intensity: 0.7,
    requestId: 'req-1',
  });
});

test('createCoreError returns the requestId and error metadata', () => {
  assert.deepEqual(createCoreError({
    requestId: 'req-1',
    code: 'INVALID_INPUT',
    message: 'bad input',
    retriable: false,
  }), {
    ok: false,
    type: 'error',
    code: 'INVALID_INPUT',
    message: 'bad input',
    retriable: false,
    requestId: 'req-1',
  });
});

test('removeInternalFields omits underscore-prefixed fields', () => {
  assert.deepEqual(removeInternalFields({ text: 'hello', _debug: true }), {
    text: 'hello',
  });
});
