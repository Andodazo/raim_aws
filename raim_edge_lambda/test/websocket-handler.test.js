'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWebSocketHandler } = require('../lib/websocket-handler');

test('$connect stores the WebSocket connection', async () => {
  const stored = [];
  const handler = createWebSocketHandler({
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
