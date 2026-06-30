'use strict';

// ==============================================================================
// Cognito JWT Verifier
// ==============================================================================
//
// Cognito JWTの検証処理。
// 署名検証・期限検証・issuer検証・clientId検証は aws-jwt-verify に任せる。
//
// COGNITO_TOKEN_USE:
//   access : Access Tokenだけ許可
//   id     : ID Tokenだけ許可
//   any    : ID Token / Access Tokenのどちらでも許可
//
// wscat検証ではAccess Tokenを使うことが多いため、既定値は access。

const { CognitoJwtVerifier } = require('aws-jwt-verify');
const { getAuthorizerConfig } = require('./config');

const verifierCache = new Map();

function createVerifier({ userPoolId, clientId, tokenUse }) {
  const cacheKey = `${userPoolId}:${clientId}:${tokenUse}`;

  if (!verifierCache.has(cacheKey)) {
    verifierCache.set(cacheKey, CognitoJwtVerifier.create({
      userPoolId,
      clientId,
      tokenUse,
    }));
  }

  return verifierCache.get(cacheKey);
}

async function verifyCognitoJwt(token, { env = process.env } = {}) {
  const config = getAuthorizerConfig(env);

  if (config.tokenUse !== 'any') {
    const verifier = createVerifier(config);
    return verifier.verify(token);
  }

  const attempts = [
    { ...config, tokenUse: 'id' },
    { ...config, tokenUse: 'access' },
  ];

  let lastError;

  for (const attempt of attempts) {
    try {
      const verifier = createVerifier(attempt);
      return await verifier.verify(token);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

module.exports = {
  createVerifier,
  verifyCognitoJwt,
};
