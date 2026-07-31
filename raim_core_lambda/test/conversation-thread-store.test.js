'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createThreadId,
  getThread,
  ensureThread,
  listThreads,
  appendTurn,
  updateThreadTitle,
  deriveTitle,
  buildMessageRecord,
} = require('../lib/conversation-thread-store');

function fakeClient(responder) {
  const calls = [];
  return {
    calls,
    send: async (command) => {
      calls.push(command.input);
      return responder ? responder(command.input, calls.length) : { Attributes: {} };
    },
  };
}

// ── ID / タイトル ────────────────────────────

test('createThreadId produces a unique prefixed id', () => {
  const a = createThreadId();
  const b = createThreadId();
  assert.ok(a.startsWith('thread-'));
  assert.notEqual(a, b);
});

test('deriveTitle shortens long text', () => {
  assert.equal(deriveTitle('こんにちは'), 'こんにちは');
  assert.equal(deriveTitle(''), '新しい会話');
  const long = deriveTitle('あ'.repeat(50));
  assert.ok(long.endsWith('…'));
  assert.ok(long.length <= 21);
});

test('deriveTitle collapses whitespace', () => {
  assert.equal(deriveTitle('  こん   にちは \n '), 'こん にちは');
});

// ── メッセージレコード ────────────────────────

test('buildMessageRecord stores image description instead of binary', () => {
  const record = buildMessageRecord({
    role: 'user',
    text: 'これ何？',
    imageDescription: '猫が寝ている写真',
  });
  assert.equal(record.role, 'user');
  assert.equal(record.imageDescription, '猫が寝ている写真');
});

test('buildMessageRecord keeps emotions only for assistant', () => {
  const assistant = buildMessageRecord({
    role: 'assistant',
    text: 'あ、猫だね',
    emotions: { happy: 0.6, curious: 0.4 },
  });
  const user = buildMessageRecord({
    role: 'user',
    text: 'これ何？',
    emotions: { happy: 1 },
  });
  assert.deepEqual(assistant.emotions, { happy: 0.6, curious: 0.4 });
  assert.equal(user.emotions, undefined);
});

test('buildMessageRecord normalizes unknown roles to user', () => {
  assert.equal(buildMessageRecord({ role: 'system', text: 'x' }).role, 'user');
});

// ── ensureThread ────────────────────────────

test('ensureThread uses if_not_exists so it never overwrites', async () => {
  const client = fakeClient(() => ({ Attributes: { threadId: 't' } }));
  await ensureThread({ sub: 'u', threadId: 't', title: 'テスト' }, { docClient: client });

  const expr = client.calls[0].UpdateExpression;
  // 既存の会話内容を初期値で潰さないこと
  assert.ok(expr.includes('messages = if_not_exists(messages, :emptyList)'));
  assert.ok(expr.includes('createdAt = if_not_exists(createdAt, :now)'));
  assert.ok(expr.includes('turnCount = if_not_exists(turnCount, :zero)'));
});

test('ensureThread defaults the title', async () => {
  const client = fakeClient(() => ({ Attributes: {} }));
  await ensureThread({ sub: 'u', threadId: 't' }, { docClient: client });
  assert.equal(client.calls[0].ExpressionAttributeValues[':title'], '新しい会話');
});

// ── getThread / listThreads ─────────────────

test('getThread returns null when absent', async () => {
  const client = fakeClient(() => ({}));
  assert.equal(await getThread('u', 't', { docClient: client }), null);
});

test('listThreads escapes the reserved word sub', async () => {
  const client = fakeClient(() => ({ Items: [] }));
  await listThreads('u', {}, { docClient: client });
  assert.equal(client.calls[0].KeyConditionExpression, '#sub = :sub');
  assert.deepEqual(client.calls[0].ExpressionAttributeNames, { '#sub': 'sub' });
});

test('listThreads excludes messages by default', async () => {
  const client = fakeClient(() => ({ Items: [] }));
  await listThreads('u', {}, { docClient: client });
  assert.ok(!client.calls[0].ProjectionExpression.includes('messages'));
});

test('listThreads sorts newest first', async () => {
  const client = fakeClient(() => ({
    Items: [
      { threadId: 'old', updatedAt: '2026-07-01T00:00:00.000Z' },
      { threadId: 'new', updatedAt: '2026-07-30T00:00:00.000Z' },
    ],
  }));
  const items = await listThreads('u', {}, { docClient: client });
  assert.equal(items[0].threadId, 'new');
});

// ── appendTurn ──────────────────────────────

test('appendTurn appends both messages with list_append', async () => {
  const client = fakeClient(() => ({ Attributes: { messages: [] } }));

  await appendTurn(
    {
      sub: 'u',
      threadId: 't',
      userMessage: { text: 'こんにちは' },
      assistantMessage: { text: 'あ、こんにちは', emotions: { happy: 1 } },
      inputTokens: 1800,
      responseId: 'resp_1',
    },
    { docClient: client }
  );

  const input = client.calls[0];
  assert.ok(input.UpdateExpression.includes('list_append'));

  const appended = input.ExpressionAttributeValues[':newMessages'];
  assert.equal(appended.length, 2);
  assert.equal(appended[0].role, 'user');
  assert.equal(appended[1].role, 'assistant');
});

test('appendTurn accumulates tokens and turn count atomically', async () => {
  const client = fakeClient(() => ({ Attributes: { messages: [] } }));

  await appendTurn(
    { sub: 'u', threadId: 't', userMessage: { text: 'a' }, inputTokens: 1800 },
    { docClient: client }
  );

  const input = client.calls[0];
  assert.ok(input.UpdateExpression.includes('ADD cumulativeInputTokens :tokens, turnCount :one'));
  assert.equal(input.ExpressionAttributeValues[':tokens'], 1800);
  assert.equal(input.ExpressionAttributeValues[':one'], 1);
});

test('appendTurn records lastResponseId when provided', async () => {
  const client = fakeClient(() => ({ Attributes: { messages: [] } }));
  await appendTurn(
    { sub: 'u', threadId: 't', userMessage: { text: 'a' }, responseId: 'resp_9' },
    { docClient: client }
  );
  assert.equal(client.calls[0].ExpressionAttributeValues[':responseId'], 'resp_9');
});

test('appendTurn omits response fields when no responseId', async () => {
  const client = fakeClient(() => ({ Attributes: { messages: [] } }));
  await appendTurn({ sub: 'u', threadId: 't', userMessage: { text: 'a' } }, { docClient: client });
  assert.ok(!client.calls[0].UpdateExpression.includes('lastResponseId'));
});

test('appendTurn does nothing when no messages are given', async () => {
  const client = fakeClient(() => ({ Attributes: {} }));
  const result = await appendTurn({ sub: 'u', threadId: 't' }, { docClient: client });
  assert.equal(result, null);
  assert.equal(client.calls.length, 0);
});

test('appendTurn trims history when it exceeds the cap', async () => {
  // 1回目の更新で上限超過を返す → 2回目に切り詰めが走る
  const over = Array.from({ length: 250 }, (_, i) => ({ role: 'user', text: `m${i}` }));
  const client = fakeClient((input, n) =>
    n === 1 ? { Attributes: { messages: over } } : { Attributes: { messages: [] } }
  );

  await appendTurn(
    { sub: 'u', threadId: 't', userMessage: { text: 'x' } },
    { docClient: client }
  );

  assert.equal(client.calls.length, 2);
  const trimmed = client.calls[1].ExpressionAttributeValues[':messages'];
  assert.equal(trimmed.length, 200);
  // 古い方から落ちる（末尾が残る）
  assert.equal(trimmed[trimmed.length - 1].text, 'm249');
});

// ── updateThreadTitle ───────────────────────

test('updateThreadTitle caps the length', async () => {
  const client = fakeClient(() => ({ Attributes: {} }));
  await updateThreadTitle('u', 't', 'あ'.repeat(200), { docClient: client });
  assert.equal(client.calls[0].ExpressionAttributeValues[':title'].length, 100);
});

test('updateThreadTitle skips empty titles', async () => {
  const client = fakeClient(() => ({ Attributes: {} }));
  assert.equal(await updateThreadTitle('u', 't', '', { docClient: client }), null);
  assert.equal(client.calls.length, 0);
});
