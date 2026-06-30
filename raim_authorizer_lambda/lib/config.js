'use strict';

// ==============================================================================
// Authorizer Environment Configuration
// ==============================================================================
//
// 検証対象のCognito User Pool / App Clientを環境変数から読み取る。
// 設定漏れは認証失敗の原因が分かりづらいため、明確なエラーに変換する。

function readRequiredString(env, name) {
  const value = String(env[name] || '').trim();

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function readOptionalString(env, name, fallback = '') {
  return String(env[name] || fallback).trim();
}

function getAuthorizerConfig(env = process.env) {
  const tokenUse = readOptionalString(env, 'COGNITO_TOKEN_USE', 'access').toLowerCase();

  if (!['access', 'id', 'any'].includes(tokenUse)) {
    throw new Error('COGNITO_TOKEN_USE must be access, id, or any');
  }

  return {
    userPoolId: readRequiredString(env, 'COGNITO_USER_POOL_ID'),
    clientId: readRequiredString(env, 'COGNITO_CLIENT_ID'),
    tokenUse,
  };
}

module.exports = {
  getAuthorizerConfig,
  readOptionalString,
  readRequiredString,
};
