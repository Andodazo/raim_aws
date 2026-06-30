'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TokenExtractorError,
  extractToken,
  normalizeHeaders,
  stripBearer,
} = require('../lib/token-extractor');

test('stripBearer removes Bearer prefix', () => {
  assert.equal(stripBearer('Bearer abc.def.ghi'), 'abc.def.ghi');
  assert.equal(stripBearer('abc.def.ghi'), 'abc.def.ghi');
});

test('normalizeHeaders lowercases header names', () => {
  assert.deepEqual(normalizeHeaders({
    Authorization: 'Bearer token',
  }), {
    authorization: 'Bearer token',
  });
});

test('extractToken reads Authorization header', () => {
  const token = extractToken({
    headers: {
      Authorization: 'Bearer header-token',
    },
  });

  assert.equal(token, 'header-token');
});

test('extractToken reads access_token query parameter for wscat', () => {
  const token = extractToken({
    queryStringParameters: {
      access_token: 'query-token',
    },
  });

  assert.equal(token, 'query-token');
});

test('extractToken rejects missing token', () => {
  assert.throws(
    () => extractToken({}),
    TokenExtractorError
  );
});
