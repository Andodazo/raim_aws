'use strict';

const crypto = require('crypto');

class WebSocketEventError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'WebSocketEventError';
    this.code = 'INVALID_INPUT';
    this.retriable = false;
    this.details = details;
  }
}

function parseJsonBody(body) {
  if (body === undefined || body === null || body === '') {
    return {};
  }

  if (typeof body !== 'string') {
    throw new WebSocketEventError('WebSocket body must be a JSON string');
  }

  try {
    return JSON.parse(body);
  } catch (error) {
    throw new WebSocketEventError('WebSocket body must be valid JSON', {
      parseError: error.message,
    });
  }
}

function extractSub(event) {
  const authorizer = event?.requestContext?.authorizer || {};

  return String(
    authorizer?.sub ||
    authorizer?.claims?.sub ||
    authorizer?.jwt?.claims?.sub ||
    authorizer?.principalId ||
    ''
  ).trim();
}

function createRequestId(context, payload) {
  const provided = String(payload.requestId || '').trim();

  if (provided) {
    return provided;
  }

  const apiRequestId = String(context?.requestId || '').trim();
  return apiRequestId || `req-${crypto.randomUUID()}`;
}

function normalizeImages(images) {
  if (images === undefined || images === null) {
    return [];
  }

  if (!Array.isArray(images)) {
    throw new WebSocketEventError('images must be an array');
  }

  return images;
}

function normalizeWebSocketEvent(event, lambdaContext = {}) {
  const requestContext = event?.requestContext || {};
  const connectionId = String(requestContext.connectionId || '').trim();
  const routeKey = String(requestContext.routeKey || '$default').trim();
  const domainName = String(requestContext.domainName || '').trim();
  const stage = String(requestContext.stage || '').trim();

  if (!connectionId) {
    throw new WebSocketEventError('connectionId is required');
  }

  const payload = parseJsonBody(event.body);
  const sub = extractSub(event);
  const requestId = createRequestId(lambdaContext, payload);

  // $connect時点ではAPI GatewayのCognito Authorizerが通っている想定。
  // ただしテストや設定ミスを早く見つけるため、subが無い場合は明示的に拒否する。
  if (routeKey === '$connect' && !sub) {
    throw new WebSocketEventError('Cognito sub is required on $connect');
  }

  const text = String(payload.text || payload.message || '').trim();
  const images = normalizeImages(payload.images);

  if (routeKey === '$default' && !text && images.length === 0) {
    throw new WebSocketEventError('text or images is required');
  }

  return {
    routeKey,
    connectionId,
    domainName,
    stage,
    sub,
    requestId,
    text,
    images,
    rawPayload: payload,
  };
}

module.exports = {
  WebSocketEventError,
  normalizeWebSocketEvent,
  parseJsonBody,
  extractSub,
};
