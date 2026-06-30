'use strict';

// ==============================================================================
// Authorizer Service
// ==============================================================================
//
// Lambda Authorizerの本体処理。
// ここでは例外を外へ投げず、API Gatewayが理解できるAllow/Deny policyへ変換する。
//
// 認証失敗時にthrowしても401相当にはできるが、検証中はCloudWatch Logsと
// API Gatewayの挙動を追いやすいよう、Deny policyを返す方式にしている。

const { extractToken } = require('./token-extractor');
const { verifyCognitoJwt } = require('./jwt-verifier');
const { createAllowPolicy, createDenyPolicy } = require('./policy');

async function authorize(event, {
  tokenVerifier = verifyCognitoJwt,
  logger = console,
} = {}) {
  const methodArn = event?.methodArn || event?.routeArn || '*';

  try {
    const token = extractToken(event);
    const claims = await tokenVerifier(token);
    const sub = String(claims.sub || '').trim();

    if (!sub) {
      return createDenyPolicy({
        methodArn,
        reason: 'JWT sub is missing',
      });
    }

    return createAllowPolicy({
      sub,
      methodArn,
      claims,
    });
  } catch (error) {
    logger.warn('Authorizer denied request', {
      name: error.name,
      message: error.message,
      code: error.code,
    });

    return createDenyPolicy({
      methodArn,
      reason: 'Unauthorized',
    });
  }
}

module.exports = {
  authorize,
};
