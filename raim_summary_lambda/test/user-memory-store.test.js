'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MemoryGenerationChangedError,
  getMemoryGeneration,
  updateUserMemory,
} = require('../lib/user-memory-store');

function fakeClient(handler) {
  const commands = [];
  return {
    commands,
    send: async (command) => {
      commands.push(command.input);
      return handler ? handler(command.input) : {};
    },
  };
}

test('updateUserMemory requires the generation to be unchanged', async () => {
  const client = fakeClient(() => ({ Attributes: {} }));
  await updateUserMemory('u1', '記憶', { docClient: client, expectedGeneration: 2 });

  assert.equal(client.commands[0].ConditionExpression, 'memoryGeneration = :generation');
  assert.equal(client.commands[0].ExpressionAttributeValues[':generation'], 2);
});

test('updateUserMemory requires no generation yet when it started without one', async () => {
  const client = fakeClient(() => ({ Attributes: {} }));
  await updateUserMemory('u1', '記憶', { docClient: client, expectedGeneration: null });

  assert.equal(client.commands[0].ConditionExpression, 'attribute_not_exists(memoryGeneration)');
});

test('updateUserMemory without a generation keeps the old unconditional write', async () => {
  const client = fakeClient(() => ({ Attributes: {} }));
  await updateUserMemory('u1', '記憶', { docClient: client });

  assert.equal(client.commands[0].ConditionExpression, undefined);
});

test('updateUserMemory reports a changed generation', async () => {
  const client = fakeClient(() => {
    const error = new Error('The conditional request failed');
    error.name = 'ConditionalCheckFailedException';
    throw error;
  });

  await assert.rejects(
    updateUserMemory('u1', '記憶', { docClient: client, expectedGeneration: 1 }),
    MemoryGenerationChangedError
  );
});

test('getMemoryGeneration reads strongly and returns null when there is none', async () => {
  const empty = fakeClient(() => ({ Item: { sub: 'u1' } }));
  assert.equal(await getMemoryGeneration('u1', { docClient: empty }), null);
  assert.equal(empty.commands[0].ConsistentRead, true);

  const some = fakeClient(() => ({ Item: { memoryGeneration: 4 } }));
  assert.equal(await getMemoryGeneration('u1', { docClient: some }), 4);
});
