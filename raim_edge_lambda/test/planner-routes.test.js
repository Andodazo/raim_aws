'use strict';

// 予定の一覧・手で足す・直す・消す（planner.*）と、ほかの端末への知らせ

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWebSocketHandler } = require('../lib/websocket-handler');
const { createResponseQueueHandler } = require('../lib/response-queue-handler');
const { createPlannerStore, expiresAtForEvent } = require('../lib/planner-store');

// 2026-11-11 11:30 JST
const NOW = new Date('2026-11-11T02:30:00Z');

function event(body, { routeKey = '$default', connectionId = 'conn-1' } = {}) {
  return {
    requestContext: {
      routeKey,
      connectionId,
      domainName: 'example.com',
      stage: 'dev',
      authorizer: { claims: { sub: 'user-1' } },
    },
    body: JSON.stringify(body),
  };
}

/** 予定テーブルの偽物（sub+itemId のキーで持つ） */
function fakePlannerDynamo() {
  const rows = new Map();
  return {
    rows,
    send: async (command) => {
      const name = command.constructor.name;
      const input = command.input;
      if (name === 'QueryCommand') {
        return { Items: [...rows.values()].filter((r) => r.sub === input.ExpressionAttributeValues[':sub']) };
      }
      if (name === 'GetCommand') {
        const row = rows.get(input.Key.itemId);
        return { Item: row ? { ...row } : undefined };
      }
      if (name === 'PutCommand') {
        rows.set(input.Item.itemId, { ...input.Item });
        return {};
      }
      if (name === 'UpdateCommand') {
        const row = rows.get(input.Key.itemId);
        if (!row) {
          const error = new Error('conditional');
          error.name = 'ConditionalCheckFailedException';
          throw error;
        }
        for (const [key, field] of Object.entries(input.ExpressionAttributeNames)) {
          const value = input.ExpressionAttributeValues[key.replace('#', ':')];
          if (value !== undefined) row[field] = value;
        }
        return { Attributes: { ...row } };
      }
      if (name === 'DeleteCommand') {
        const row = rows.get(input.Key.itemId);
        rows.delete(input.Key.itemId);
        return { Attributes: row };
      }
      throw new Error(`unexpected ${name}`);
    },
  };
}

function setup({ connections = ['conn-1', 'conn-2'] } = {}) {
  const posted = [];
  const enriched = [];
  const removed = [];
  const db = fakePlannerDynamo();
  const plannerStore = createPlannerStore({ docClient: db, now: () => NOW });
  const sessionStore = {
    listConnections: async () => connections,
    removeConnection: async (sub, id) => removed.push(id),
    addConnection: async () => {},
  };
  const handler = createWebSocketHandler({
    rateLimiter: { consume: async () => assert.fail('予定は回数に数えない') },
    connectionStore: { getConnection: async () => ({ sub: 'user-1' }) },
    postback: {
      postJson: async (connectionId, payload) => {
        posted.push({ connectionId, payload });
        return connectionId === 'conn-gone' ? { ok: false, gone: true } : { ok: true };
      },
    },
    sessionStore,
    plannerStore,
    requestPublisher: {
      publishChatRequest: async () => assert.fail('チャットとして送らない'),
      publishPlannerEnrich: async (job) => enriched.push(job),
    },
  });
  return { handler, posted, enriched, removed, db };
}

test('planner.add saves, returns the list, tells other devices and asks Core for lines', async () => {
  const { handler, posted, enriched } = setup();
  const res = await handler(event({
    type: 'planner.add', requestId: 'r1', item: { title: '歯医者', date: '2026-11-14', time: '15:00' },
  }));
  assert.equal(res.statusCode, 202);
  const reply = posted.find((p) => p.connectionId === 'conn-1').payload;
  assert.equal(reply.type, 'planner');
  assert.equal(reply.items.length, 1);
  assert.equal(reply.items[0].title, '歯医者');
  assert.equal(reply.items[0].enriched, false);
  assert.equal(reply.items[0].expiresAt, expiresAtForEvent('2026-11-14'));
  assert.equal(reply.changed.type, 'added');
  // ほかの端末へ
  assert.deepEqual(posted.filter((p) => p.connectionId === 'conn-2').map((p) => p.payload), [{ type: 'planner.changed' }]);
  // Core へ知らせる文を頼む
  assert.equal(enriched.length, 1);
  assert.equal(enriched[0].itemId, reply.items[0].itemId);
});

test('planner.add rejects bad input', async () => {
  const { handler, posted } = setup();
  for (const item of [{ title: '', date: '2026-11-14' }, { title: 'x', date: '来週' }, { title: 'x', date: '2026-11-14', time: '25:00' }, { title: 'x', date: '2020-01-01' }]) {
    const res = await handler(event({ type: 'planner.add', item }));
    assert.equal(res.statusCode, 400);
  }
  // 失敗は WebSocket でも返る（requestId 付きの error）
  assert.ok(posted.every((p) => p.payload.type === 'error'));
});

test('planner.update re-enriches only when title/date/time change; delete removes', async () => {
  const { handler, posted, enriched } = setup({ connections: ['conn-1'] });
  await handler(event({ type: 'planner.add', item: { title: '歯医者', date: '2026-11-14' } }));
  const id = posted[0].payload.items[0].itemId;
  enriched.length = 0;

  await handler(event({ type: 'planner.update', itemId: id, changes: { note: '保険証' } }));
  assert.equal(enriched.length, 0);
  await handler(event({ type: 'planner.update', itemId: id, changes: { time: '16:30' } }));
  assert.equal(enriched.length, 1);
  const last = posted.at(-1).payload;
  assert.equal(last.items[0].time, '16:30');
  assert.equal(last.items[0].note, '保険証');

  const missing = await handler(event({ type: 'planner.update', itemId: 'ev_nope', changes: { note: 'x' } }));
  assert.equal(missing.statusCode, 404);

  await handler(event({ type: 'planner.delete', itemId: id }));
  assert.deepEqual(posted.at(-1).payload.items, []);
  assert.equal(posted.at(-1).payload.changed.type, 'deleted');
});

test('planner.list hides items past their keep period', async () => {
  const { handler, posted, db } = setup();
  db.rows.set('ev_old', { sub: 'user-1', itemId: 'ev_old', kind: 'event', title: '古い', date: '2026-11-01', expiresAt: expiresAtForEvent('2026-11-01') });
  db.rows.set('ev_new', { sub: 'user-1', itemId: 'ev_new', kind: 'event', title: '新しい', date: '2026-11-14', expiresAt: expiresAtForEvent('2026-11-14') });
  await handler(event({ type: 'planner.list', requestId: 'r2' }));
  assert.deepEqual(posted[0].payload.items.map((i) => i.title), ['新しい']);
  // 一覧だけなら、ほかの端末へは送らない
  assert.equal(posted.length, 1);
});

test('broadcast drops connections that are gone', async () => {
  const { handler, removed } = setup({ connections: ['conn-1', 'conn-gone'] });
  await handler(event({ type: 'planner.add', item: { title: 'x', date: '2026-11-14' } }));
  assert.deepEqual(removed, ['conn-gone']);
});

test('connect/disconnect register the connection for sync', async () => {
  const calls = [];
  const handler = createWebSocketHandler({
    connectionStore: {
      putConnection: async () => {},
      getConnection: async () => ({ sub: 'user-1' }),
      deleteConnection: async () => {},
    },
    sessionStore: {
      addConnection: async (sub, id) => calls.push(['add', sub, id]),
      removeConnection: async (sub, id) => calls.push(['remove', sub, id]),
    },
  });
  await handler(event({}, { routeKey: '$connect' }));
  await handler(event({}, { routeKey: '$disconnect' }));
  assert.deepEqual(calls, [['add', 'user-1', 'conn-1'], ['remove', 'user-1', 'conn-1']]);
});

test('response queue: a planner client_action from Raim is also announced to other devices', async () => {
  const posted = [];
  const handler = createResponseQueueHandler({
    postback: { postJson: async (connectionId, payload) => { posted.push({ connectionId, payload }); return { ok: true }; } },
    connectionStore: { deleteConnection: async () => {} },
    sessionStore: { listConnections: async () => ['conn-1', 'conn-2'], removeConnection: async () => {} },
  });
  await handler({
    Records: [{
      messageId: 'm1',
      body: JSON.stringify({
        type: 'stream.action', requestId: 'r1', connectionId: 'conn-1', sub: 'user-1', sequence: 2,
        action: 'planner.added', actionId: 'r1_action_0', params: { item: { itemId: 'ev_1' } },
      }),
    }],
  });
  assert.equal(posted[0].payload.type, 'client_action');
  assert.deepEqual(posted[1], { connectionId: 'conn-2', payload: { type: 'planner.changed' } });
});

// ─────────────────────────────────────────────
// メモ帳（機能2）
// ─────────────────────────────────────────────

test('planner.add makes a memo or a list without asking Core for lines', async () => {
  const { handler, posted, enriched, db } = setup();
  await handler(event({ type: 'planner.add', requestId: 'm1', item: { kind: 'memo', text: '駐輪場は3階' } }));
  await handler(event({ type: 'planner.add', requestId: 'm2', item: { kind: 'list', title: '買うもの', entries: ['牛乳', { text: '卵' }] } }));
  const rows = [...db.rows.values()];
  assert.equal(rows.find((r) => r.kind === 'memo').text, '駐輪場は3階');
  assert.equal(rows.find((r) => r.kind === 'memo').expiresAt, undefined);
  const list = rows.find((r) => r.kind === 'list');
  assert.deepEqual(list.entries.map((e) => e.text), ['牛乳', '卵']);
  assert.match(list.entries[0].id, /^e[0-9a-f]{8}$/);
  assert.equal(enriched.length, 0);
  // 足した端末に一覧、もう1台に planner.changed
  assert.ok(posted.some((p) => p.connectionId === 'conn-2' && p.payload.type === 'planner.changed'));
  const bad = await handler(event({ type: 'planner.add', item: { kind: 'memo', text: ' ' } }));
  assert.equal(bad.statusCode, 400);
});

test('planner.update edits memo text and list entries; a new check gets a time; timers cannot be changed', async () => {
  const { handler, db } = setup();
  await handler(event({ type: 'planner.add', item: { kind: 'list', title: '買うもの', entries: ['牛乳', '卵'] } }));
  const list = [...db.rows.values()].find((r) => r.kind === 'list');
  const [milk, egg] = list.entries;
  await handler(event({ type: 'planner.update', itemId: list.itemId, changes: {
    entries: [{ ...milk, checked: true }, egg, { text: 'パン' }],
  } }));
  const after = db.rows.get(list.itemId);
  assert.equal(after.entries[0].checked, true);
  assert.equal(after.entries[0].checkedAt, NOW.toISOString());
  assert.equal(after.entries[2].text, 'パン');

  await handler(event({ type: 'planner.add', item: { kind: 'memo', text: 'a' } }));
  const memo = [...db.rows.values()].find((r) => r.kind === 'memo');
  await handler(event({ type: 'planner.update', itemId: memo.itemId, changes: { text: '駐輪場は4階' } }));
  assert.equal(db.rows.get(memo.itemId).text, '駐輪場は4階');

  db.rows.set('tm_1', { sub: 'user-1', itemId: 'tm_1', kind: 'timer', title: 'タイマー' });
  const timer = await handler(event({ type: 'planner.update', itemId: 'tm_1', changes: { title: 'x' } }));
  assert.equal(timer.statusCode, 400);
});

test('list: entries checked before today (JST) are hidden and dropped on the next write', async () => {
  const { handler, posted, db } = setup();
  db.rows.set('ls_1', {
    sub: 'user-1', itemId: 'ls_1', kind: 'list', title: '買うもの',
    entries: [
      { id: 'e00000001', text: '昨日の', checked: true, checkedAt: '2026-11-10T10:00:00Z' },
      { id: 'e00000002', text: '今日の', checked: true, checkedAt: '2026-11-11T01:00:00Z' },
      { id: 'e00000003', text: 'まだ', checked: false },
    ],
  });
  await handler(event({ type: 'planner.list', requestId: 'l1' }));
  const listed = posted.find((p) => p.payload.type === 'planner').payload.items.find((i) => i.itemId === 'ls_1');
  assert.deepEqual(listed.entries.map((e) => e.text), ['今日の', 'まだ']);
});

test('planner.add from the suggestion button drops the kept follow-up; follow-ups cannot be edited', async () => {
  const { handler, posted, db } = setup({ connections: ['conn-1'] });
  const followUpId = 'fu_0b6f5b2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
  db.rows.set(followUpId, {
    sub: 'user-1', itemId: followUpId, kind: 'followup', title: 'テスト', date: '2026-11-12', time: '',
  });
  // 手では直せない
  const edit = await handler(event({ type: 'planner.update', itemId: followUpId, changes: { title: 'x' } }));
  assert.equal(edit.statusCode, 400);
  posted.length = 0;

  await handler(event({
    type: 'planner.add', source: 'suggest', followUpId, item: { title: 'テスト', date: '2026-11-12' },
  }));
  const reply = posted.find((p) => p.payload.type === 'planner').payload;
  assert.deepEqual(reply.items.map((i) => i.kind), ['event']);
  assert.equal(reply.items[0].source, 'suggest');
  assert.equal(db.rows.has(followUpId), false);

  // ほかの形の id は消さない
  db.rows.set('ev_keep', { sub: 'user-1', itemId: 'ev_keep', kind: 'event', title: '歯医者', date: '2026-11-14', time: '' });
  await handler(event({ type: 'planner.add', followUpId: 'ev_keep', item: { title: '散歩', date: '2026-11-14' } }));
  assert.equal(db.rows.has('ev_keep'), true);
});
