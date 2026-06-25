'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { toClientMessage } = require('../lib/client-message');

test('toClientMessage maps completed event for the client', () => {
  assert.deepEqual(toClientMessage({
    type: 'stream.completed',
    requestId: 'req-001',
    sequence: 2,
    text: 'やあ',
    emotion: 'happy',
    intensity: 0.6,
  }), {
    type: 'stream.completed',
    requestId: 'req-001',
    sequence: 2,
    text: 'やあ',
    emotion: 'happy',
    intensity: 0.6,
  });
});
