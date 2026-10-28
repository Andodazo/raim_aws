'use strict';

// 覚えていることの表示と削除（memory.get / memory.forget）

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWebSocketHandler } = require('../lib/websocket-handler');
const { createWebSocketPostback } = require('../lib/websocket-postback');
const {
  parseMemory,
  formatMemory,
  forgetMemory,
  MAX_FORGOTTEN,
} = require('../lib/user-session-store');

const ENV = {
  REQUEST_QUEUE_URL: 'https://sqs.example/q.fifo',
  RESPONSE_QUEUE_URL: 'https://sqs.example/r.fifo',
  CONNECTION_TABLE_NAME: 'RAiM-WebSocketConnection-dev',
  WEBSOCKET_API_ENDPOINT: 'https://example.com/dev',
  AWS_REGION: 'ap-northeast-1',
};

const MEMORY = '【事実】\n- 卒業制作でアプリを作っている\n- 猫を飼っている\n\n【関係性】\n- 制作の話になると楽しそうな様子';

function event(body) {
  return {
    requestContext: {
      routeKey: '$default',
      connectionId: 'conn-1',
      domainName: 'example.com',
      stage: 'dev',
      authorizer: { claims: { sub: 'user-1' } },
    },
    body: JSON.stringify(body),
  };
}

function setup(sessionStore) {
  const sent = [];
  const postback = createWebSocketPostback({
    client: {
      send: async (command) => {
        sent.push(JSON.parse(Buffer.from(command.input.Data).toString('utf8')));
      },
    },
    env: ENV,
  });
  let consumed = 0;
  const handler = createWebSocketHandler({
    rateLimiter: { consume: async () => { consumed += 1; return { allowed: true }; } },
    connectionStore: { getConnection: async () => ({ sub: 'user-1' }) },
    postback,
    sessionStore,
    requestPublisher: { publishChatRequest: async () => assert.fail('チャットとして送らない') },
  });
  return { handler, sent, consumed: () => consumed };
}

/** UserSession 1件だけを持つ偽の DynamoDB */
function fakeDynamo(initial) {
  const state = { item: { ...initial }, writes: 0, conflictOnce: false };
  return {
    state,
    docClient: {
      send: async (command) => {
        const name = command.constructor.name;
        if (name === 'GetCommand') return { Item: { ...state.item } };
        if (name === 'UpdateCommand') {
          const v = command.input.ExpressionAttributeValues;
          if (state.conflictOnce) {
            // 読んだあとに Summary Lambda が書き換えた
            state.conflictOnce = false;
            state.item.userMemory = `${state.item.userMemory}\n- 新しく覚えたこと`;
          }
          if (String(state.item.userMemory || '') !== v[':old']) {
            const error = new Error('conditional');
            error.name = 'ConditionalCheckFailedException';
            throw error;
          }
          state.writes += 1;
          state.item.userMemory = v[':memory'];
          state.item.forgottenMemories = v[':forgotten'];
          state.item.memoryGeneration = (state.item.memoryGeneration || 0) + 1;
          return {};
        }
        throw new Error(`unexpected ${name}`);
      },
    },
  };
}

test('parseMemory は見出しごとに項目へ分け、formatMemory で元に戻る', () => {
  const memory = parseMemory(MEMORY);
  assert.deepEqual(memory, {
    facts: ['卒業制作でアプリを作っている', '猫を飼っている'],
    relationship: ['制作の話になると楽しそうな様子'],
  });
  assert.equal(formatMemory(memory), MEMORY);
  // 見出しの無い古い形は事実として扱う
  assert.deepEqual(parseMemory('- 甘いものが好き').facts, ['甘いものが好き']);
  assert.deepEqual(parseMemory(''), { facts: [], relationship: [] });
});

test('forgetMemory は選んだ項目だけ消し、消したものを覚えておく', async () => {
  const db = fakeDynamo({ userMemory: MEMORY, forgottenMemories: ['前に消したこと'] });
  const result = await forgetMemory('user-1', { items: ['猫を飼っている'] }, db);

  assert.deepEqual(result.facts, ['卒業制作でアプリを作っている']);
  assert.deepEqual(result.relationship, ['制作の話になると楽しそうな様子']);
  assert.ok(!db.state.item.userMemory.includes('猫'));
  assert.deepEqual(db.state.item.forgottenMemories, ['前に消したこと', '猫を飼っている']);
  // 作り直しの途中だった記憶が書き戻されないよう、世代を進める
  assert.equal(db.state.item.memoryGeneration, 1);
});

test('forgetMemory は all で全部消す', async () => {
  const db = fakeDynamo({ userMemory: MEMORY });
  const result = await forgetMemory('user-1', { all: true }, db);
  assert.deepEqual(result.facts, []);
  assert.deepEqual(result.relationship, []);
  assert.equal(db.state.item.userMemory, '');
  assert.equal(db.state.item.forgottenMemories.length, 3);
});

test('forgetMemory は読んだあとに書き換えられていたら読み直す', async () => {
  const db = fakeDynamo({ userMemory: MEMORY });
  db.state.conflictOnce = true;
  const result = await forgetMemory('user-1', { items: ['猫を飼っている'] }, db);
  // 新しく覚えたこと（関係性の見出しの下に足された）は消さない
  assert.deepEqual(result.facts, ['卒業制作でアプリを作っている']);
  assert.deepEqual(result.relationship, ['制作の話になると楽しそうな様子', '新しく覚えたこと']);
  assert.equal(db.state.writes, 1);
});

test('消したものは古いものから捨て、上限を超えない', async () => {
  const old = Array.from({ length: MAX_FORGOTTEN }, (_, i) => `古い${i}`);
  const db = fakeDynamo({ userMemory: MEMORY, forgottenMemories: old });
  await forgetMemory('user-1', { items: ['猫を飼っている'] }, db);
  assert.equal(db.state.item.forgottenMemories.length, MAX_FORGOTTEN);
  assert.equal(db.state.item.forgottenMemories.at(-1), '猫を飼っている');
  assert.equal(db.state.item.forgottenMemories[0], '古い1');
});

test('memory.get は覚えていることを項目で返す（チャットの回数には数えない）', async () => {
  const { handler, sent, consumed } = setup({
    getMemory: async (sub) => {
      assert.equal(sub, 'user-1');
      return { ...parseMemory(MEMORY), updatedAt: '2026-10-28T00:00:00.000Z' };
    },
  });

  const response = await handler(event({ type: 'memory.get', requestId: 'req-m1' }));

  assert.equal(response.statusCode, 202);
  assert.equal(consumed(), 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'memory');
  assert.equal(sent[0].requestId, 'req-m1');
  assert.deepEqual(sent[0].facts, ['卒業制作でアプリを作っている', '猫を飼っている']);
  assert.deepEqual(sent[0].relationship, ['制作の話になると楽しそうな様子']);
});

test('memory.forget は選んだ項目を消して、消したあとの内容を返す', async () => {
  const calls = [];
  const { handler, sent } = setup({
    forgetMemory: async (sub, options) => {
      calls.push(options);
      return { facts: ['卒業制作でアプリを作っている'], relationship: [], updatedAt: 'now' };
    },
  });

  const response = await handler(event({
    type: 'memory.forget',
    requestId: 'req-m2',
    items: ['猫を飼っている', 123, ''],
  }));

  assert.equal(response.statusCode, 202);
  assert.deepEqual(calls, [{ items: ['猫を飼っている'], all: false }]);
  assert.deepEqual(sent[0].facts, ['卒業制作でアプリを作っている']);
});

test('memory.forget は消すものが無ければ入力不正にする', async () => {
  const { handler, sent } = setup({
    forgetMemory: async () => assert.fail('呼ばない'),
  });

  const response = await handler(event({ type: 'memory.forget', requestId: 'req-m3' }));

  assert.equal(response.statusCode, 400);
  // $default の失敗はアプリにも伝える
  assert.equal(sent.at(-1)?.type, 'error');
});
