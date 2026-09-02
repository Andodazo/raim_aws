'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { listThreads, getThreadHistory } = require('../lib/thread-list-store');

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

function makeMessages(count) {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    text: `メッセージ${i}`,
    createdAt: '2026-08-01T00:00:00.000Z',
  }));
}

// ── listThreads ─────────────────────────────

test('listThreads escapes the reserved word sub', async () => {
  const client = fakeClient(() => ({ Items: [] }));
  await listThreads('u', { docClient: client });

  // sub は DynamoDB の予約語なので式中では別名が必須
  assert.equal(client.calls[0].KeyConditionExpression, '#sub = :sub');
  assert.deepEqual(client.calls[0].ExpressionAttributeNames, { '#sub': 'sub' });
});

test('listThreads excludes messages from the projection', async () => {
  const client = fakeClient(() => ({ Items: [] }));
  await listThreads('u', { docClient: client });

  // 一覧に messages を含めると応答が肥大するため除外している
  assert.ok(!String(client.calls[0].ProjectionExpression || '').includes('messages'));
});

test('listThreads sorts newest first', async () => {
  const client = fakeClient(() => ({
    Items: [
      { threadId: 'old', updatedAt: '2026-07-01T00:00:00.000Z' },
      { threadId: 'new', updatedAt: '2026-08-01T00:00:00.000Z' },
    ],
  }));
  const threads = await listThreads('u', { docClient: client });
  assert.equal(threads[0].threadId, 'new');
});

test('listThreads requires sub', async () => {
  await assert.rejects(() => listThreads(''), /sub is required/);
});

// ── getThreadHistory ────────────────────────

test('getThreadHistory returns messages in chronological order', async () => {
  const client = fakeClient(() => ({
    Item: { threadId: 't', title: 'テスト', messages: makeMessages(4) },
  }));

  const result = await getThreadHistory('u', 't', { docClient: client });

  assert.equal(result.messages.length, 4);
  assert.equal(result.messages[0].text, 'メッセージ0');
  assert.equal(result.messages[3].text, 'メッセージ3');
  assert.equal(result.hasMore, false);
});

test('getThreadHistory keeps only the newest messages when over the limit', async () => {
  const client = fakeClient(() => ({
    Item: { threadId: 't', title: 'テスト', messages: makeMessages(120) },
  }));

  const result = await getThreadHistory('u', 't', { docClient: client, maxMessages: 50 });

  assert.equal(result.messages.length, 50);
  assert.equal(result.totalMessages, 120);
  assert.equal(result.hasMore, true);
  // 直近50件（70〜119）が時系列順で返る
  assert.equal(result.messages[0].text, 'メッセージ70');
  assert.equal(result.messages[49].text, 'メッセージ119');
});

test('getThreadHistory stops at the byte budget', async () => {
  const long = Array.from({ length: 50 }, (_, i) => ({
    role: 'user',
    text: 'あ'.repeat(500),
    createdAt: '2026-08-01T00:00:00.000Z',
  }));
  const client = fakeClient(() => ({ Item: { threadId: 't', messages: long } }));

  // WebSocket の 128KB 制限に収まるよう、件数だけでなくバイト数でも打ち切る
  const result = await getThreadHistory('u', 't', {
    docClient: client,
    maxMessages: 50,
    maxBytes: 5000,
  });

  assert.ok(result.messages.length < 50);
  const size = Buffer.byteLength(JSON.stringify(result), 'utf8');
  assert.ok(size < 20000, `応答が大きすぎる: ${size}`);
});

test('getThreadHistory always returns at least one message', async () => {
  const huge = [{ role: 'user', text: 'あ'.repeat(10000), createdAt: '2026-08-01T00:00:00.000Z' }];
  const client = fakeClient(() => ({ Item: { threadId: 't', messages: huge } }));

  // 1件目だけは予算を超えても返す（空応答を避けるため）
  const result = await getThreadHistory('u', 't', { docClient: client, maxBytes: 100 });
  assert.equal(result.messages.length, 1);
});

test('getThreadHistory returns null for a missing thread', async () => {
  const client = fakeClient(() => ({}));
  assert.equal(await getThreadHistory('u', 'missing', { docClient: client }), null);
});

test('getThreadHistory tolerates a thread with no messages', async () => {
  const client = fakeClient(() => ({ Item: { threadId: 't', title: '空' } }));
  const result = await getThreadHistory('u', 't', { docClient: client });
  assert.deepEqual(result.messages, []);
  assert.equal(result.hasMore, false);
});

test('getThreadHistory requires sub and threadId', async () => {
  await assert.rejects(() => getThreadHistory('u', ''), /required/);
});

// ── 履歴の遡り（ページング）─────────────────

test('getThreadHistory returns startIndex as a cursor', async () => {
  const client = fakeClient(() => ({
    Item: { threadId: 't', messages: makeMessages(200) },
  }));

  const first = await getThreadHistory('u', 't', {
    docClient: client,
    maxMessages: 50,
  });

  // 末尾50件（150〜199）が返り、次に遡る位置は 150
  assert.equal(first.messages.length, 50);
  assert.equal(first.messages[0].text, 'メッセージ150');
  assert.equal(first.startIndex, 150);
  assert.equal(first.hasMore, true);
});

test('getThreadHistory walks back through the whole history without gaps', async () => {
  const client = fakeClient(() => ({
    Item: { threadId: 't', messages: makeMessages(200) },
  }));

  const seen = [];
  let before;

  for (let page = 0; page < 10; page += 1) {
    const result = await getThreadHistory('u', 't', {
      docClient: client,
      maxMessages: 50,
      beforeIndex: before,
    });

    // 取得したものを先頭へ積む（古い順に並ぶ）
    seen.unshift(...result.messages.map((m) => m.text));

    if (!result.hasMore) break;
    before = result.startIndex;
  }

  // 重複も欠落もなく全件そろう
  assert.equal(seen.length, 200);
  assert.equal(seen[0], 'メッセージ0');
  assert.equal(seen[199], 'メッセージ199');
  assert.equal(new Set(seen).size, 200);
});

test('getThreadHistory reports hasMore=false at the beginning', async () => {
  const client = fakeClient(() => ({
    Item: { threadId: 't', messages: makeMessages(30) },
  }));

  const result = await getThreadHistory('u', 't', {
    docClient: client,
    maxMessages: 50,
    beforeIndex: 20,
  });

  assert.equal(result.messages.length, 20);
  assert.equal(result.startIndex, 0);
  assert.equal(result.hasMore, false);
});

test('getThreadHistory ignores an out-of-range cursor', async () => {
  const client = fakeClient(() => ({
    Item: { threadId: 't', messages: makeMessages(10) },
  }));

  // 実際の件数より大きい値を渡しても末尾から返す（壊れない）
  const result = await getThreadHistory('u', 't', {
    docClient: client,
    beforeIndex: 9999,
  });

  assert.equal(result.messages.length, 10);
  assert.equal(result.startIndex, 0);
});

test('getThreadHistory treats a zero cursor as the beginning', async () => {
  const client = fakeClient(() => ({
    Item: { threadId: 't', messages: makeMessages(10) },
  }));

  const result = await getThreadHistory('u', 't', {
    docClient: client,
    beforeIndex: 0,
  });

  assert.deepEqual(result.messages, []);
  assert.equal(result.hasMore, false);
});
