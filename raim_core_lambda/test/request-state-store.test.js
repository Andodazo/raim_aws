'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  claimRequest,
  createRequestKey,
  markRequestCompleted,
} = require('../lib/request-state-store');

test('claimRequest creates a processing lease with TTL', async () => {
  const commands = [];
  const client = {
    send: async (command) => {
      commands.push(command.input);
      return {};
    },
  };
  const result = await claimRequest({
    sub: 'user-1',
    requestId: 'req-1',
    connectionId: 'connection-1',
    ownerId: 'invocation-1',
  }, {
    client,
    tableName: 'request-state',
    leaseSeconds: 120,
    ttlSeconds: 86400,
  });

  assert.equal(result.claimed, true);
  assert.equal(result.requestKey, 'user-1#req-1');
  assert.equal(commands[0].TableName, 'request-state');
  assert.match(commands[0].ConditionExpression, /attribute_not_exists/);
});

test('claimRequest identifies a completed duplicate', async () => {
  let attempt = 0;
  const client = {
    send: async () => {
      attempt += 1;
      if (attempt === 1) {
        const error = new Error('conditional');
        error.name = 'ConditionalCheckFailedException';
        throw error;
      }
      return { Item: { status: 'COMPLETED' } };
    },
  };
  const result = await claimRequest({
    sub: 'user-1',
    requestId: 'req-1',
    ownerId: 'invocation-2',
  }, { client, tableName: 'request-state' });

  assert.deepEqual(result, {
    claimed: false,
    requestKey: 'user-1#req-1',
    status: 'COMPLETED',
  });
});

test('markRequestCompleted releases the processing lease', async () => {
  let input;
  const client = {
    send: async (command) => {
      input = command.input;
    },
  };
  await markRequestCompleted({
    requestKey: createRequestKey('user-1', 'req-1'),
    ownerId: 'invocation-1',
    details: { ok: true },
  }, { client, tableName: 'request-state' });

  assert.match(input.UpdateExpression, /REMOVE leaseExpiresAt/);
  assert.equal(input.ExpressionAttributeValues[':status'], 'COMPLETED');
});
