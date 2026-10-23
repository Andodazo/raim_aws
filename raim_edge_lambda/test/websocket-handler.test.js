'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWebSocketHandler } = require('../lib/websocket-handler');

test('$connect stores the WebSocket connection', async () => {
  const stored = [];
  const handler = createWebSocketHandler({
    rateLimiter: { consume: async () => ({ allowed: true }) },
    connectionStore: {
      putConnection: async (item) => stored.push(item),
      getConnection: async () => null,
      deleteConnection: async () => {},
    },
    requestPublisher: {
      publishChatRequest: async () => {
        throw new Error('should not publish on connect');
      },
    },
  });

  const response = await handler({
    requestContext: {
      routeKey: '$connect',
      connectionId: 'conn-001',
      domainName: 'example.execute-api.ap-northeast-1.amazonaws.com',
      stage: 'dev',
      authorizer: {
        claims: {
          sub: 'user-001',
        },
      },
    },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].connectionId, 'conn-001');
  assert.equal(stored[0].sub, 'user-001');
});

test('$default publishes a chat request to Core request queue', async () => {
  const published = [];
  const handler = createWebSocketHandler({
    rateLimiter: { consume: async () => ({ allowed: true }) },
    connectionStore: {
      putConnection: async () => {},
      getConnection: async () => null,
      deleteConnection: async () => {},
    },
    requestPublisher: {
      publishChatRequest: async (message) => {
        published.push(message);
        return message;
      },
    },
  });

  const response = await handler({
    requestContext: {
      routeKey: '$default',
      connectionId: 'conn-001',
      authorizer: {
        claims: {
          sub: 'user-001',
        },
      },
    },
    body: JSON.stringify({
      requestId: 'req-001',
      text: 'つまんないダジャレ言うぞ',
    }),
  });

  const body = JSON.parse(response.body);

  assert.equal(response.statusCode, 202);
  assert.equal(body.type, 'accepted');
  assert.equal(body.requestId, 'req-001');
  assert.equal(published.length, 1);
  assert.deepEqual(published[0], {
    requestId: 'req-001',
    connectionId: 'conn-001',
    sub: 'user-001',
    text: 'つまんないダジャレ言うぞ',
    images: [],
    threadId: '',
    features: [],
    location: null,
    speech: true,
  });
});

test('$default forwards features the client supports', async () => {
  const published = [];
  const handler = createWebSocketHandler({
    rateLimiter: { consume: async () => ({ allowed: true }) },
    connectionStore: {
      putConnection: async () => {},
      getConnection: async () => null,
      deleteConnection: async () => {},
    },
    requestPublisher: {
      publishChatRequest: async (message) => {
        published.push(message);
        return message;
      },
    },
  });

  await handler({
    requestContext: {
      routeKey: '$default',
      connectionId: 'conn-001',
      authorizer: { claims: { sub: 'user-001' } },
    },
    body: JSON.stringify({
      requestId: 'req-002',
      text: '新宿で起こして',
      features: ['station_alarm'],
    }),
  });

  assert.deepEqual(published[0].features, ['station_alarm']);
});

test('$disconnect deletes the WebSocket connection', async () => {
  const deleted = [];
  const handler = createWebSocketHandler({
    rateLimiter: { consume: async () => ({ allowed: true }) },
    connectionStore: {
      putConnection: async () => {},
      getConnection: async () => null,
      deleteConnection: async (connectionId) => deleted.push(connectionId),
    },
    requestPublisher: {
      publishChatRequest: async () => {
        throw new Error('should not publish on disconnect');
      },
    },
  });

  const response = await handler({
    requestContext: {
      routeKey: '$disconnect',
      connectionId: 'conn-001',
    },
  });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(deleted, ['conn-001']);
});

test('$default fills sub from the stored connection when authorizer context is absent', async () => {
  const published = [];
  const handler = createWebSocketHandler({
    rateLimiter: { consume: async () => ({ allowed: true }) },
    connectionStore: {
      putConnection: async () => {},
      getConnection: async () => ({ sub: 'user-from-store' }),
      deleteConnection: async () => {},
    },
    requestPublisher: {
      publishChatRequest: async (message) => {
        published.push(message);
        return message;
      },
    },
  });

  const response = await handler({
    requestContext: {
      routeKey: '$default',
      connectionId: 'conn-001',
    },
    body: JSON.stringify({
      requestId: 'req-001',
      text: 'こんにちは',
    }),
  });

  assert.equal(response.statusCode, 202);
  assert.equal(published[0].sub, 'user-from-store');
});

test('$default forwards a rounded location', async () => {
  const published = [];
  const handler = createWebSocketHandler({
    rateLimiter: { consume: async () => ({ allowed: true }) },
    connectionStore: {
      putConnection: async () => {},
      getConnection: async () => null,
      deleteConnection: async () => {},
    },
    requestPublisher: {
      publishChatRequest: async (message) => {
        published.push(message);
        return message;
      },
    },
  });

  await handler({
    requestContext: {
      routeKey: '$default',
      connectionId: 'conn-001',
      authorizer: { claims: { sub: 'user-001' } },
    },
    body: JSON.stringify({
      requestId: 'req-003',
      text: '今日の天気は？',
      location: { lat: 35.65584, lon: 139.33891 },
    }),
  });

  assert.deepEqual(published[0].location, { lat: 35.7, lon: 139.3 });
});

test('$default は声を消しているとき speech: false を Core へ渡す', async () => {
  const published = [];
  const handler = createWebSocketHandler({
    rateLimiter: { consume: async () => ({ allowed: true }) },
    connectionStore: {
      putConnection: async () => {},
      getConnection: async () => null,
      deleteConnection: async () => {},
    },
    requestPublisher: {
      publishChatRequest: async (message) => {
        published.push(message);
        return message;
      },
    },
  });

  await handler({
    requestContext: {
      routeKey: '$default',
      connectionId: 'conn-001',
      authorizer: { claims: { sub: 'user-001' } },
    },
    body: JSON.stringify({ requestId: 'req-004', text: 'こんにちは', speech: false }),
  });

  assert.equal(published[0].speech, false);
});

// ── 接続中のトークン期限 ─────────────────────

test('$connect stores the access token expiry from the authorizer', async () => {
  const stored = [];
  const handler = createWebSocketHandler({
    rateLimiter: { consume: async () => ({ allowed: true }) },
    connectionStore: {
      putConnection: async (item) => stored.push(item),
      getConnection: async () => null,
      deleteConnection: async () => {},
    },
  });

  await handler({
    requestContext: {
      routeKey: '$connect',
      connectionId: 'conn-001',
      // Lambda Authorizer の context は文字列で届くこともある
      authorizer: { sub: 'user-001', exp: '1700003600' },
    },
  });

  assert.equal(stored[0].tokenExpiresAt, 1700003600);
});

function expiryHandler({ tokenExpiresAt, nowMs }) {
  const posted = [];
  const disconnected = [];
  const published = [];

  const handler = createWebSocketHandler({
    rateLimiter: { consume: async () => ({ allowed: true }) },
    connectionStore: {
      putConnection: async () => {},
      getConnection: async () => ({ sub: 'user-001', tokenExpiresAt }),
      deleteConnection: async () => {},
    },
    requestPublisher: {
      publishChatRequest: async (message) => {
        published.push(message);
        return message;
      },
    },
    postback: {
      postJson: async (connectionId, payload) => {
        posted.push(payload);
        return { ok: true };
      },
      disconnect: async (connectionId) => {
        disconnected.push(connectionId);
        return { ok: true };
      },
    },
    now: () => nowMs,
  });

  const send = () => handler({
    requestContext: { routeKey: '$default', connectionId: 'conn-001' },
    body: JSON.stringify({ requestId: 'req-001', text: 'こんにちは' }),
  });

  return { send, posted, disconnected, published };
}

test('$default rejects and disconnects when the access token has expired', async () => {
  const { send, posted, disconnected, published } = expiryHandler({
    tokenExpiresAt: 1700000000,
    nowMs: 1700000001 * 1000,
  });

  const response = await send();

  assert.equal(response.statusCode, 401);
  assert.equal(published.length, 0);
  assert.equal(posted[0].type, 'error');
  assert.equal(posted[0].code, 'TOKEN_EXPIRED');
  assert.equal(posted[0].requestId, 'req-001');
  assert.deepEqual(disconnected, ['conn-001']);
});

test('$default accepts while the access token is still valid', async () => {
  const { send, posted, published } = expiryHandler({
    tokenExpiresAt: 1700000000,
    nowMs: 1699999999 * 1000,
  });

  const response = await send();

  assert.equal(response.statusCode, 202);
  assert.equal(published.length, 1);
  assert.equal(posted.length, 0);
});

test('$default accepts old connections that have no stored expiry', async () => {
  const { send, published } = expiryHandler({
    tokenExpiresAt: undefined,
    nowMs: 1800000000 * 1000,
  });

  const response = await send();

  assert.equal(response.statusCode, 202);
  assert.equal(published.length, 1);
});

test('$default uses the expiry from the authorizer context when it is there', async () => {
  const posted = [];
  const handler = createWebSocketHandler({
    rateLimiter: { consume: async () => ({ allowed: true }) },
    connectionStore: {
      putConnection: async () => {},
      // 接続テーブルに期限が無くても、context の期限で断る
      getConnection: async () => ({ sub: 'user-001' }),
      deleteConnection: async () => {},
    },
    requestPublisher: {
      publishChatRequest: async () => {
        throw new Error('should not publish');
      },
    },
    postback: {
      postJson: async (connectionId, payload) => {
        posted.push(payload);
        return { ok: true };
      },
      disconnect: async () => ({ ok: true }),
    },
    now: () => 1700000001 * 1000,
  });

  const response = await handler({
    requestContext: {
      routeKey: '$default',
      connectionId: 'conn-001',
      authorizer: { sub: 'user-001', exp: '1700000000' },
    },
    body: JSON.stringify({ requestId: 'req-001', text: 'こんにちは' }),
  });

  assert.equal(response.statusCode, 401);
  assert.equal(posted[0].code, 'TOKEN_EXPIRED');
});

test('$default answers with an error instead of crashing when the connection lookup fails', async () => {
  const handler = createWebSocketHandler({
    rateLimiter: { consume: async () => ({ allowed: true }) },
    connectionStore: {
      putConnection: async () => {},
      getConnection: async () => {
        throw new Error('DynamoDB down');
      },
      deleteConnection: async () => {},
    },
  });

  const response = await handler({
    requestContext: { routeKey: '$default', connectionId: 'conn-001' },
    body: JSON.stringify({ requestId: 'req-001', text: 'こんにちは' }),
  });

  assert.equal(response.statusCode, 500);
});
