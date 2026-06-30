'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAllowPolicy,
  createDenyPolicy,
} = require('../lib/policy');

test('createAllowPolicy returns principalId and context.sub', () => {
  const policy = createAllowPolicy({
    sub: 'user-001',
    methodArn: 'arn:aws:execute-api:ap-northeast-1:123:api/dev/$connect',
    claims: {
      username: 'raim-user',
      email: 'user@example.com',
      token_use: 'access',
    },
  });

  assert.equal(policy.principalId, 'user-001');
  assert.equal(policy.policyDocument.Statement[0].Effect, 'Allow');
  assert.equal(policy.context.sub, 'user-001');
  assert.equal(policy.context.tokenUse, 'access');
});

test('createDenyPolicy returns deny response', () => {
  const policy = createDenyPolicy({
    methodArn: 'arn',
    reason: 'Unauthorized',
  });

  assert.equal(policy.principalId, 'anonymous');
  assert.equal(policy.policyDocument.Statement[0].Effect, 'Deny');
  assert.equal(policy.context.reason, 'Unauthorized');
});
