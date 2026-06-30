'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { authorize } = require('../lib/authorizer-service');

test('authorize allows a valid token and returns sub context', async () => {
  const result = await authorize({
    methodArn: 'arn:aws:execute-api:ap-northeast-1:123:api/dev/$connect',
    headers: {
      Authorization: 'Bearer valid-token',
    },
  }, {
    tokenVerifier: async (token) => {
      assert.equal(token, 'valid-token');
      return {
        sub: 'user-001',
        token_use: 'access',
      };
    },
  });

  assert.equal(result.principalId, 'user-001');
  assert.equal(result.policyDocument.Statement[0].Effect, 'Allow');
  assert.equal(result.context.sub, 'user-001');
});

test('authorize denies invalid token without throwing', async () => {
  const logs = [];
  const result = await authorize({
    methodArn: 'arn',
    headers: {
      Authorization: 'Bearer invalid-token',
    },
  }, {
    tokenVerifier: async () => {
      throw new Error('invalid');
    },
    logger: {
      warn: (...args) => logs.push(args),
    },
  });

  assert.equal(result.principalId, 'anonymous');
  assert.equal(result.policyDocument.Statement[0].Effect, 'Deny');
  assert.equal(logs.length, 1);
});

test('authorize denies token without sub', async () => {
  const result = await authorize({
    methodArn: 'arn',
    headers: {
      Authorization: 'Bearer token',
    },
  }, {
    tokenVerifier: async () => ({
      token_use: 'access',
    }),
  });

  assert.equal(result.policyDocument.Statement[0].Effect, 'Deny');
  assert.equal(result.context.reason, 'JWT sub is missing');
});
