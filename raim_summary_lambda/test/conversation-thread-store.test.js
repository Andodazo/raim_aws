'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getThread,
  listThreads,
  scanIdleThreads,
  saveThreadSummary,
  resetThreadSession,
} = require('../lib/conversation-thread-store');

function fakeClient(responder) {
  const calls = [];
  return {
    calls,
    send: async (command) => {
      calls.push(command.input);
      return responder ? responder(command.input) : {};
    },
  };
}

test('getThread fetches by composite key', async () => {
  const client = fakeClient(() => ({ Item: { sub: 'u', threadId: 't' } }));
  const thread = await getThread('u', 't', { docClient: client });
  assert.deepEqual(client.calls[0].Key, { sub: 'u', threadId: 't' });
  assert.equal(thread.threadId, 't');
});

test('getThread returns null when absent', async () => {
  const client = fakeClient(() => ({}));
  assert.equal(await getThread('u', 't', { docClient: client }), null);
});

test('listThreads escapes the reserved word sub', async () => {
  const client = fakeClient(() => ({ Items: [] }));
  await listThreads('u', {}, { docClient: client });

  const input = client.calls[0];
  // sub は DynamoDB の予約語なので式中では別名が必須
  assert.equal(input.KeyConditionExpression, '#sub = :sub');
  assert.deepEqual(input.ExpressionAttributeNames, { '#sub': 'sub' });
});

test('listThreads excludes messages by default', async () => {
  const client = fakeClient(() => ({ Items: [] }));
  await listThreads('u', {}, { docClient: client });
  assert.ok(client.calls[0].ProjectionExpression);
  assert.ok(!client.calls[0].ProjectionExpression.includes('messages'));
});

test('listThreads includes messages when requested', async () => {
  const client = fakeClient(() => ({ Items: [] }));
  await listThreads('u', { includeMessages: true }, { docClient: client });
  assert.equal(client.calls[0].ProjectionExpression, undefined);
});

test('listThreads follows pagination', async () => {
  let page = 0;
  const client = fakeClient(() => {
    page += 1;
    return page === 1
      ? { Items: [{ threadId: 'a' }], LastEvaluatedKey: { sub: 'u', threadId: 'a' } }
      : { Items: [{ threadId: 'b' }] };
  });
  const items = await listThreads('u', {}, { docClient: client });
  assert.equal(items.length, 2);
});

test('scanIdleThreads filters by updatedAt threshold', async () => {
  const client = fakeClient(() => ({ Items: [] }));
  await scanIdleThreads(
    { idleDays: 7 },
    { docClient: client, now: () => new Date('2026-07-30T00:00:00.000Z') }
  );

  const input = client.calls[0];
  assert.ok(input.FilterExpression.includes('updatedAt < :threshold'));
  // 7日前
  assert.equal(input.ExpressionAttributeValues[':threshold'], '2026-07-23T00:00:00.000Z');
});

test('scanIdleThreads honours the limit', async () => {
  const client = fakeClient(() => ({
    Items: Array.from({ length: 10 }, (_, i) => ({ threadId: `t${i}` })),
    LastEvaluatedKey: { sub: 'u' },
  }));
  const items = await scanIdleThreads({ limit: 3 }, { docClient: client });
  assert.equal(items.length, 3);
});

test('saveThreadSummary stores summary and resets counters', async () => {
  const client = fakeClient(() => ({ Attributes: {} }));
  await saveThreadSummary('u', 't', '【事実】\n- あり', {}, { docClient: client });

  const input = client.calls[0];
  assert.ok(input.UpdateExpression.includes('sessionSummary = :summary'));
  assert.ok(input.UpdateExpression.includes('summarizedAtInputTokens = if_not_exists(sessionInputTokens, :zero)'));
  assert.equal(input.ExpressionAttributeValues[':zero'], 0);
});

test('saveThreadSummary can keep counters', async () => {
  const client = fakeClient(() => ({ Attributes: {} }));
  await saveThreadSummary('u', 't', 'x', { resetCounters: false }, { docClient: client });
  assert.ok(!client.calls[0].UpdateExpression.includes('summarizedAtInputTokens'));
});

test('saveThreadSummary refuses to overwrite with an empty summary', async () => {
  const client = fakeClient(() => ({ Attributes: {} }));
  const result = await saveThreadSummary('u', 't', '   ', {}, { docClient: client });
  assert.equal(result, null);
  assert.equal(client.calls.length, 0);
});

test('resetThreadSession clears lastResponseId', async () => {
  const client = fakeClient(() => ({ Attributes: {} }));
  await resetThreadSession('u', 't', { docClient: client });
  const input = client.calls[0];
  assert.ok(input.UpdateExpression.includes('lastResponseId = :empty'));
  assert.equal(input.ExpressionAttributeValues[':empty'], '');
});
