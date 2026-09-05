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

// クエリ文字列は API Gateway のアクセスログや経路上のプロキシに残るため、
// 既定では受け付けない。wscat での検証時だけ環境変数で開ける。
test('extractToken ignores access_token query parameter by default', () => {
  assert.throws(
    () => extractToken({
      queryStringParameters: {
        access_token: 'query-token',
      },
    }, { env: {} }),
    TokenExtractorError
  );
});

test('extractToken reads access_token query parameter when explicitly allowed', () => {
  const token = extractToken({
    queryStringParameters: {
      access_token: 'query-token',
    },
  }, { env: { ALLOW_QUERY_TOKEN: 'true' } });

  assert.equal(token, 'query-token');
});

test('extractToken prefers the Authorization header even when query is allowed', () => {
  const token = extractToken({
    headers: { Authorization: 'Bearer header-token' },
    queryStringParameters: { access_token: 'query-token' },
  }, { env: { ALLOW_QUERY_TOKEN: 'true' } });

  assert.equal(token, 'header-token');
});

test('extractToken rejects missing token', () => {
  assert.throws(
    () => extractToken({}),
    TokenExtractorError
  );
});
