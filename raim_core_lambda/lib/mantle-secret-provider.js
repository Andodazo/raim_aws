'use strict';

// ==============================================================================
// Bedrock Mantle APIキー取得処理（AWS Secrets Manager）
// ==============================================================================
//
// MantleのAPIキーはLambda環境変数へ直接保存せず、Secrets Managerから取得する。
// 環境変数には秘密値そのものではなく、次の「秘密値を探すための情報」だけを置く。
//
// 必須:
// - MANTLE_API_KEY_SECRET_ARN: APIキーを保存したSecretの完全なARN
// - MANTLE_API_KEY_SECRET_JSON_KEY: SecretString内でAPIキーを持つJSON項目名
// - MANTLE_SECRET_REGION: Secretを作成したAWSリージョン
//
// SecretStringは、たとえば次のJSON形式を想定する。
// {
//   "apiKey": "実際のBedrock Mantle APIキー"
// }
//
// Lambdaの実行ロールには、対象Secret ARNに対する
// secretsmanager:GetSecretValue権限が必要になる。
// Customer managed KMS keyでSecretを暗号化した場合は、そのKMS keyに対する
// kms:Decrypt権限も別途必要になる。
//
// 取得結果は同じLambda実行環境（warm container）内でキャッシュする。
// これにより、Mantleへのstreaming requestごとにSecrets Managerを呼び出さず、
// 通信遅延とAPI呼び出し回数を抑える。新しいLambda実行環境では再取得される。
// ==============================================================================

const {
  GetSecretValueCommand,
  SecretsManagerClient,
} = require('@aws-sdk/client-secrets-manager');

// Secret ARN、JSON key、リージョンの組み合わせ単位でPromiseを保存する。
// Promise自体を保存することで、同時に複数requestが来ても取得処理を一本化できる。
const secretPromiseCache = new Map();

function requiredSecretSetting(env, name) {
  const value = String(env[name] || '').trim();

  if (!value) {
    const error = new Error(`${name} is required for Mantle secret retrieval`);
    error.code = 'MANTLE_SECRET_CONFIG_ERROR';
    error.coreErrorCode = 'LLM_ERROR';
    error.retriable = false;
    throw error;
  }

  return value;
}

/**
 * SecretBinaryにも対応し、Secrets Managerの応答をUTF-8文字列へ揃える。
 * APIキーやSecret全体は、エラーmessageやログへ含めない。
 */
function decodeSecretValue(response) {
  if (typeof response?.SecretString === 'string') {
    return response.SecretString;
  }

  if (response?.SecretBinary) {
    return Buffer.from(response.SecretBinary).toString('utf8');
  }

  const error = new Error('Mantle API key secret has no SecretString or SecretBinary');
  error.code = 'MANTLE_SECRET_INVALID';
  error.coreErrorCode = 'LLM_ERROR';
  error.retriable = false;
  throw error;
}

/**
 * SecretのJSONから指定された項目を取り出し、空文字でないことを検証する。
 * JSON解析エラー時にもSecret本文はmessageへ出さない。
 */
function extractApiKey(secretText, jsonKey) {
  let secret;

  try {
    secret = JSON.parse(secretText);
  } catch (cause) {
    const error = new Error('Mantle API key secret must be a JSON object');
    error.code = 'MANTLE_SECRET_INVALID';
    error.coreErrorCode = 'LLM_ERROR';
    error.retriable = false;
    error.cause = cause;
    throw error;
  }

  const apiKey = String(secret?.[jsonKey] || '').trim();

  if (!apiKey) {
    const error = new Error(`Mantle API key secret does not contain JSON key: ${jsonKey}`);
    error.code = 'MANTLE_SECRET_INVALID';
    error.coreErrorCode = 'LLM_ERROR';
    error.retriable = false;
    throw error;
  }

  return apiKey;
}

/**
 * Mantle APIキーを取得する関数を作成する。
 * clientを注入できるため、単体テストではAWSへ接続せず挙動を確認できる。
 */
function createMantleApiKeyProvider({ client, env = process.env, cache = secretPromiseCache } = {}) {
  return async function getMantleApiKey() {
    const secretArn = requiredSecretSetting(env, 'MANTLE_API_KEY_SECRET_ARN');
    const jsonKey = requiredSecretSetting(env, 'MANTLE_API_KEY_SECRET_JSON_KEY');
    const region = requiredSecretSetting(env, 'MANTLE_SECRET_REGION');
    const cacheKey = `${region}\u0000${secretArn}\u0000${jsonKey}`;

    if (!cache.has(cacheKey)) {
      const secretsClient = client || new SecretsManagerClient({ region });
      const loadPromise = secretsClient.send(
        new GetSecretValueCommand({ SecretId: secretArn })
      ).then((response) => extractApiKey(decodeSecretValue(response), jsonKey));

      // 一時的なAWS障害などで取得に失敗したPromiseはキャッシュから除外する。
      // 次回requestで再取得できるようにし、warm containerが永久に失敗し続けるのを防ぐ。
      cache.set(cacheKey, loadPromise);
      loadPromise.catch(() => cache.delete(cacheKey));
    }

    try {
      return await cache.get(cacheKey);
    } catch (cause) {
      if (cause?.code?.startsWith?.('MANTLE_SECRET_')) {
        throw cause;
      }

      const error = new Error(`Failed to retrieve Mantle API key from Secrets Manager: ${cause.message}`);
      error.name = 'MantleSecretError';
      error.code = 'MANTLE_SECRET_GET_FAILED';
      error.coreErrorCode = 'LLM_ERROR';
      error.retriable = ![
        'AccessDeniedException',
        'ResourceNotFoundException',
        'InvalidRequestException',
      ].includes(cause.name);
      error.cause = cause;
      throw error;
    }
  };
}

const getMantleApiKey = createMantleApiKeyProvider();

module.exports = {
  createMantleApiKeyProvider,
  decodeSecretValue,
  extractApiKey,
  getMantleApiKey,
  requiredSecretSetting,
  secretPromiseCache,
};
