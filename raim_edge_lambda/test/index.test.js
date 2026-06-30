'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isSqsEvent,
  isWebSocketEvent,
} = require('../index');

test('isSqsEvent accepts only pure SQS record batches', () => {
  assert.equal(isSqsEvent({
    Records: [
      { eventSource: 'aws:sqs' },
      { eventSource: 'aws:sqs' },
    ],
  }), true);

  assert.equal(isSqsEvent({
    Records: [
      { eventSource: 'aws:sqs' },
      { eventSource: 'aws:dynamodb' },
    ],
  }), false);

  assert.equal(isSqsEvent({ Records: [] }), false);
});

test('isWebSocketEvent detects API Gateway WebSocket events', () => {
  assert.equal(isWebSocketEvent({
    requestContext: {
      connectionId: 'conn-001',
    },
  }), true);

  assert.equal(isWebSocketEvent({}), false);
});
