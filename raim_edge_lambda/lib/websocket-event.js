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

/**
 * クライアントが指定した threadId を検証する。
 *
 * DynamoDB のソートキーになるため、想定外の値は未指定扱いにする。
 * 未指定なら Core 側で activeThreadId が使われるか、新規スレッドが作られる。
 */
function normalizeThreadId(value) {
  if (typeof value !== 'string') {
    return '';
  }

  const trimmed = value.trim();

  if (!trimmed || trimmed.length > 128) {
    return '';
  }

  return trimmed;
}

/**
 * クライアント要求の種別を取り出す。
 *
 * 従来のチャット送信は type を持たないため、未指定は 'chat' 扱いにする。
 * これにより既存クライアントの送信形式を壊さずに新しい要求を足せる。
 */
function normalizeAction(value) {
  const action = String(value || '').trim().toLowerCase();
  return action || 'chat';
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
  const action = normalizeAction(payload.type);
  const threadId = normalizeThreadId(payload.threadId);

  // text/images が要るのはチャット送信のときだけ。
  // thread.list のような読み取り要求は本文を持たない。
  if (routeKey === '$default' && action === 'chat' && !text && images.length === 0) {
    throw new WebSocketEventError('text or images is required');
  }

  return {
    routeKey,
    connectionId,
    domainName,
    stage,
    sub,
    requestId,
    action,
    text,
    images,
    threadId,
    rawPayload: payload,
  };
}

module.exports = {
  WebSocketEventError,
  normalizeThreadId,
  normalizeAction,
  normalizeWebSocketEvent,
  parseJsonBody,
  extractSub,
};
