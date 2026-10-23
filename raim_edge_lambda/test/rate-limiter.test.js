'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRateLimiter } = require('../lib/rate-limiter');
const { createWebSocketHandler } = require('../lib/websocket-handler');

/** 回数を覚えて、条件（上限）を本物の DynamoDB と同じように確かめる */
function fakeDynamo() {
  const counts = new Map();
  const calls = [];
  return {
    calls,
    counts,
    send: async (command) => {
      const input = command.input;
      calls.push(input);
      const key = input.Key.requestKey;
      const current = counts.get(key) || 0;
      if (current >= input.ExpressionAttributeValues[':limit']) {
        const error = new Error('conditional');
        error.name = 'ConditionalCheckFailedException';
        throw error;
      }
      counts.set(key, current + 1);
      return {};
    },
  };
}

test('1分の上限までは通し、超えたら断る', async () => {
  const client = fakeDynamo();
  const limiter = createRateLimiter({
    client,
    env: { CHAT_RATE_LIMIT_PER_MINUTE: '3', CHAT_RATE_LIMIT_PER_DAY: '100' },
    now: () => Date.parse('2026-10-23T00:00:10Z'),
  });

  const results = [];
  for (let i = 0; i < 4; i++) results.push(await limiter.consume('user-1'));

  assert.deepEqual(results.map((r) => r.allowed), [true, true, true, false]);
  assert.equal(results[3].window, 'minute');
  // 別の人は数えが別
  assert.equal((await limiter.consume('user-2')).allowed, true);
});

test('次の1分になれば、また送れる', async () => {
  const client = fakeDynamo();
  let now = Date.parse('2026-10-23T00:00:10Z');
  const limiter = createRateLimiter({
    client,
    env: { CHAT_RATE_LIMIT_PER_MINUTE: '1', CHAT_RATE_LIMIT_PER_DAY: '100' },
    now: () => now,
  });

  assert.equal((await limiter.consume('u')).allowed, true);
  assert.equal((await limiter.consume('u')).allowed, false);
  now += 60 * 1000;
  assert.equal((await limiter.consume('u')).allowed, true);
});

test('1日の上限も見る', async () => {
  const client = fakeDynamo();
  let now = Date.parse('2026-10-23T00:00:10Z');
  const limiter = createRateLimiter({
    client,
    env: { CHAT_RATE_LIMIT_PER_MINUTE: '100', CHAT_RATE_LIMIT_PER_DAY: '2' },
    now: () => now,
  });

  assert.equal((await limiter.consume('u')).allowed, true);
  now += 60 * 1000;
  assert.equal((await limiter.consume('u')).allowed, true);
  now += 60 * 1000;
  const third = await limiter.consume('u');
  assert.equal(third.allowed, false);
  assert.equal(third.window, 'day');
});

test('数えた項目は TTL で消えるよう expiresAt を付け、キーは rate# で始める', async () => {
  const client = fakeDynamo();
  const limiter = createRateLimiter({
    client,
    env: {},
    now: () => Date.parse('2026-10-23T00:00:10Z'),
  });

  await limiter.consume('u');

  assert.ok(client.calls.every((c) => c.Key.requestKey.startsWith('rate#')));
  assert.ok(client.calls.every((c) => c.ExpressionAttributeValues[':expiresAt'] > 0));
  assert.equal(client.calls[0].TableName, 'RAiM-CoreRequest-dev');
});

test('数えるのに失敗したら通す（障害でチャット全体を止めない）', async () => {
  const limiter = createRateLimiter({
    client: { send: async () => { throw new Error('DynamoDB down'); } },
    env: {},
  });

  assert.equal((await limiter.consume('u')).allowed, true);
});

test('上限を超えたチャットは Core へ送らず、RATE_LIMITED を requestId 付きで返す', async () => {
  const sent = [];
  const published = [];
  const handler = createWebSocketHandler({
    rateLimiter: { consume: async () => ({ allowed: false, window: 'minute', limit: 20 }) },
    connectionStore: { getConnection: async () => ({ sub: 'user-1' }) },
    requestPublisher: { publishChatRequest: async (r) => { published.push(r); return r; } },
    postback: { postJson: async (connectionId, payload) => sent.push(payload) },
  });

  const response = await handler({
    requestContext: {
      routeKey: '$default',
      connectionId: 'conn-1',
      authorizer: { claims: { sub: 'user-1' } },
    },
    body: JSON.stringify({ requestId: 'req-1', text: 'やあ' }),
  });

  assert.equal(response.statusCode, 429);
  assert.equal(published.length, 0);
  assert.equal(sent[0].type, 'error');
  assert.equal(sent[0].code, 'RATE_LIMITED');
  assert.equal(sent[0].requestId, 'req-1');
  assert.equal(sent[0].retriable, false);
});
