'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getThread,
  listThreads,
  scanIdleThreads,
  saveThreadSummary,
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
  assert.ok(input.UpdateExpression.includes('turnCount = :zero'));
  assert.ok(!input.UpdateExpression.includes('summarizedAtInputTokens'));
  assert.equal(input.ExpressionAttributeValues[':zero'], 0);
});

test('saveThreadSummary can keep counters', async () => {
  const client = fakeClient(() => ({ Attributes: {} }));
  await saveThreadSummary('u', 't', 'x', { resetCounters: false }, { docClient: client });
  assert.ok(!client.calls[0].UpdateExpression.includes('turnCount'));
});

test('saveThreadSummary refuses to overwrite with an empty summary', async () => {
  const client = fakeClient(() => ({ Attributes: {} }));
  const result = await saveThreadSummary('u', 't', '   ', {}, { docClient: client });
  assert.equal(result, null);
  assert.equal(client.calls.length, 0);
});

test('saveThreadSummary does not recreate a deleted thread', async () => {
  const { saveThreadSummary, ThreadDeletedError } = require('../lib/conversation-thread-store');
  const commands = [];
  const docClient = {
    send: async (command) => {
      commands.push(command.input);
      const error = new Error('The conditional request failed');
      error.name = 'ConditionalCheckFailedException';
      throw error;
    },
  };

  await assert.rejects(
    saveThreadSummary('u1', 't1', '要約', {}, { docClient }),
    ThreadDeletedError
  );
  assert.equal(
    commands[0].ConditionExpression,
    'attribute_exists(threadId) AND attribute_not_exists(deletedAt)'
  );
});

// 2026-11-06: 会話一覧の題名が「消えたいと感じている」になっていた
test('deriveTitleFromSummary softens a title about wanting to disappear', () => {
  const { deriveTitleFromSummary } = require('../lib/conversation-thread-store');
  assert.equal(
    deriveTitleFromSummary('【事実】\n- ユーザーは消えたいと感じている\n\n【関係性】\n- 弱音を吐いている様子'),
    '気持ちを話した'
  );
  assert.equal(
    deriveTitleFromSummary('【事実】\n- ユーザーは新宿で起こしてほしいと述べた'),
    '新宿で起こしてほしいと述べた'
  );
});

// 2026-11-15: 題名を要約と一緒に LLM に作らせる
test('resolveThreadTitle tidies the title the model wrote', () => {
  const { resolveThreadTitle } = require('../lib/conversation-thread-store');
  assert.equal(resolveThreadTitle({ title: '「カフェ巡りと卒業制作」' }), 'カフェ巡りと卒業制作');
  assert.equal(resolveThreadTitle({ title: 'ユーザーの猫の体調。' }), '猫の体調');
  assert.equal(resolveThreadTitle({ title: '消えたい気持ち' }), '気持ちを話した');
  assert.equal(
    resolveThreadTitle({ title: 'あ'.repeat(25) }),
    `${'あ'.repeat(20)}…`
  );
});

test('resolveThreadTitle falls back to the first fact when the model wrote none', () => {
  const { resolveThreadTitle } = require('../lib/conversation-thread-store');
  assert.equal(
    resolveThreadTitle({ title: '', summary: '【事実】\n- ユーザーは新宿で起こしてほしいと述べた' }),
    '新宿で起こしてほしいと述べた'
  );
  assert.equal(resolveThreadTitle({ title: '  ', summary: '' }), '');
});

test('updateTitleFromSummary prefers the model title', async () => {
  const { updateTitleFromSummary } = require('../lib/conversation-thread-store');
  const commands = [];
  const docClient = { send: async (command) => { commands.push(command.input); return { Attributes: {} }; } };

  await updateTitleFromSummary('u1', 't1', '【事実】\n- ユーザーはカフェに行った', { docClient }, { title: 'カフェ巡り' });
  assert.equal(commands[0].ExpressionAttributeValues[':title'], 'カフェ巡り');

  // 題名が無ければ今まで通り【事実】の1行目
  await updateTitleFromSummary('u1', 't1', '【事実】\n- ユーザーはカフェに行った', { docClient });
  assert.equal(commands[1].ExpressionAttributeValues[':title'], 'カフェに行った');
});

test('resolveThreadTitle keeps at most two topics, joined with と', () => {
  const { resolveThreadTitle } = require('../lib/conversation-thread-store');
  assert.equal(resolveThreadTitle({ title: '卒業制作の進捗, バイトの状況, 京都旅行' }), '卒業制作の進捗とバイトの状況');
  assert.equal(resolveThreadTitle({ title: 'カフェ、チーズケーキ' }), 'カフェとチーズケーキ');
  assert.equal(resolveThreadTitle({ title: '歯医者と甘いもの' }), '歯医者と甘いもの');
});
