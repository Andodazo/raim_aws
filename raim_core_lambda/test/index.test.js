'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyCoreError, handler, redactSensitiveText } = require('../index');

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

test('redactSensitiveText removes presigned URL query parameters', () => {
  const text = redactSensitiveText(
    'got https://bucket.s3.ap-northeast-1.amazonaws.com/key.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=secret'
  );

  assert.equal(text, 'got [redacted-presigned-url]');
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
