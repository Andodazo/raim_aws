'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WebSocketEventError,
  normalizeFeatures,
  normalizeWebSocketEvent,
} = require('../lib/websocket-event');

test('normalizeWebSocketEvent extracts Cognito sub and chat body', () => {
  const event = {
    requestContext: {
      routeKey: '$default',
      connectionId: 'conn-001',
      domainName: 'example.execute-api.ap-northeast-1.amazonaws.com',
      stage: 'dev',
      authorizer: {
        claims: {
          sub: 'user-001',
        },
      },
    },
    body: JSON.stringify({
      requestId: 'req-001',
      text: '笑わせて',
    }),
  };

  const normalized = normalizeWebSocketEvent(event);

  assert.equal(normalized.routeKey, '$default');
  assert.equal(normalized.connectionId, 'conn-001');
  assert.equal(normalized.sub, 'user-001');
  assert.equal(normalized.requestId, 'req-001');
  assert.equal(normalized.text, '笑わせて');
});

test('normalizeWebSocketEvent extracts sub from Lambda Authorizer context', () => {
  const event = {
    requestContext: {
      routeKey: '$default',
      connectionId: 'conn-001',
      authorizer: {
        sub: 'user-from-context',
      },
    },
    body: JSON.stringify({
      requestId: 'req-001',
      text: 'こんにちは',
    }),
  };

  const normalized = normalizeWebSocketEvent(event);

  assert.equal(normalized.sub, 'user-from-context');
});

test('normalizeWebSocketEvent rejects empty default message', () => {
  assert.throws(
    () => normalizeWebSocketEvent({
      requestContext: {
        routeKey: '$default',
        connectionId: 'conn-001',
      },
      body: JSON.stringify({}),
    }),
    WebSocketEventError
  );
});

test('normalizeWebSocketEvent requires sub on connect', () => {
  assert.throws(
    () => normalizeWebSocketEvent({
      requestContext: {
        routeKey: '$connect',
        connectionId: 'conn-001',
      },
    }),
    /Cognito sub is required/
  );
});

test('normalizeFeatures keeps only known feature names', () => {
  assert.deepEqual(normalizeFeatures(['station_alarm']), ['station_alarm']);
  assert.deepEqual(
    normalizeFeatures(['station_alarm', 'unknown', 'station_alarm', 3]),
    ['station_alarm']
  );
  assert.deepEqual(normalizeFeatures('station_alarm'), []);
  assert.deepEqual(normalizeFeatures(undefined), []);
});

test('normalizeWebSocketEvent reads features from the chat body', () => {
  const normalized = normalizeWebSocketEvent({
    requestContext: {
      routeKey: '$default',
      connectionId: 'conn-001',
      authorizer: { claims: { sub: 'user-001' } },
    },
    body: JSON.stringify({
      requestId: 'req-001',
      text: '新宿で起こして',
      features: ['station_alarm'],
    }),
  });

  assert.deepEqual(normalized.features, ['station_alarm']);
});

test('normalizeLocation rounds to about 10km and rejects bad values', () => {
  const { normalizeLocation } = require('../lib/websocket-event');

  assert.deepEqual(normalizeLocation({ lat: 35.65584, lon: 139.33891 }), { lat: 35.7, lon: 139.3 });
  assert.equal(normalizeLocation(null), null);
  assert.equal(normalizeLocation({ lat: 'x', lon: 139 }), null);
  assert.equal(normalizeLocation({ lat: 91, lon: 139 }), null);
  assert.equal(normalizeLocation({ lat: 35, lon: 181 }), null);
});
