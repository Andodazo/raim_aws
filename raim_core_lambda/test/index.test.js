'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyCoreError, handler } = require('../index');

test('classifyCoreError preserves Mantle and Titan error categories', () => {
  assert.deepEqual(classifyCoreError({
    coreErrorCode: 'LLM_ERROR',
    retriable: false,
  }), {
    code: 'LLM_ERROR',
    message: 'Mantle request failed',
    retriable: false,
  });

  assert.equal(classifyCoreError({ coreErrorCode: 'EMBED_ERROR' }).code, 'EMBED_ERROR');
});

test('classifyCoreError hides unknown internal errors', () => {
  assert.equal(classifyCoreError(new Error('secret detail')).code, 'INTERNAL_ERROR');
});

test('handler does not retry non-retriable invalid SQS messages', async () => {
  const originalConsoleError = console.error;
  console.error = () => {};

  try {
    const result = await handler({
      Records: [{
        eventSource: 'aws:sqs',
        messageId: 'invalid-message',
        body: 'not-json',
      }],
    }, { awsRequestId: 'invocation-1' });

    assert.deepEqual(result, {
      batchItemFailures: [],
    });
  } finally {
    console.error = originalConsoleError;
  }
});
