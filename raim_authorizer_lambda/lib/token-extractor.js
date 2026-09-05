'use strict';

// ==============================================================================
// Token Extractor
// ==============================================================================
//
// API Gateway WebSocketのLambda AuthorizerイベントからJWTを取り出す。
//
// 基本:
//   Authorization: Bearer <JWT>
//
// wscat検証用:
//   wss://.../dev?access_token=<JWT>
//
// Header名はAPI Gatewayやクライアント実装によって大小文字が揺れるため、
// 小文字化して検索する。

class TokenExtractorError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TokenExtractorError';
    this.code = 'UNAUTHORIZED';
  }
}

function normalizeHeaders(headers = {}) {
  const normalized = {};

  for (const [key, value] of Object.entries(headers || {})) {
    normalized[String(key).toLowerCase()] = value;
  }

  return normalized;
}

function stripBearer(value) {
  const text = String(value || '').trim();

  if (!text) {
    return '';
  }

  const match = text.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : text;
}

/**
 * クエリ文字列からのトークン受け取りを許すか。
 *
 * 既定は無効。URL は API Gateway のアクセスログ、CloudWatch、
 * 経路上のプロキシに残るため、資格情報を載せる場所として適さない。
 * wscat での検証時だけ ALLOW_QUERY_TOKEN=true を立てる。
 */
function isQueryTokenAllowed(env) {
  return String(env.ALLOW_QUERY_TOKEN || '').toLowerCase() === 'true';
}

function extractToken(event, { env = process.env } = {}) {
  const headers = normalizeHeaders(event?.headers);
  const fromHeader = stripBearer(headers.authorization || headers.Authorization);

  if (fromHeader) {
    return fromHeader;
  }

  if (isQueryTokenAllowed(env)) {
    const query = event?.queryStringParameters || {};
    const fromQuery = stripBearer(
      query.access_token ||
      query.token ||
      query.Authorization ||
      query.authorization
    );

    if (fromQuery) {
      return fromQuery;
    }
  }

  // 一部のAPI Gateway Authorizer設定では identitySource 由来の値が
  // identitySource配列に入る。Authorizationヘッダーを指定した場合の保険。
  if (Array.isArray(event?.identitySource)) {
    for (const candidate of event.identitySource) {
      const token = stripBearer(candidate);

      if (token) {
        return token;
      }
    }
  }

  throw new TokenExtractorError('Authorization token is required');
}

module.exports = {
  TokenExtractorError,
  extractToken,
  isQueryTokenAllowed,
  normalizeHeaders,
  stripBearer,
};
