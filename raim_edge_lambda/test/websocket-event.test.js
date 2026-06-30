'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  WebSocketEventError,
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
