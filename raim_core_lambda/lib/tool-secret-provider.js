'use strict';

// ==============================================================================
// 外部ツールAPIキーの取得（Secrets Manager）
// ==============================================================================
//
// 【このファイルの役割】
// Tavily / OpenWeatherMap のAPIキーをSecrets Managerから取得する。
//
// 【なぜ環境変数に置かないか】
// Lambdaの環境変数は、コンソールやAPI（GetFunctionConfiguration）で平文のまま
// 読めてしまう。Mantle API Keyと同じ方針で、外部APIキーもSecrets Managerへ置く。
// mantle-secret-provider.js と同じキャッシュ戦略を採る。
//
// 【Secretの形式】
// 1つのSecretへJSONでまとめて保存する。
//
//   {
//     "tavilyApiKey": "tvly-...",
//     "openWeatherMapApiKey": "..."
//   }
//
// 【環境変数】
// - TOOL_API_KEY_SECRET_ARN : 上記SecretのARN（必須。未設定ならツール無効）
// - TOOL_SECRET_REGION      : Secretのリージョン（省略時はMANTLE_SECRET_REGION → AWS_REGION）
//
// 【ツールを無効化したい場合】
// TOOL_API_KEY_SECRET_ARN を設定しなければ、getToolSecrets() は null を返す。
// 呼出側はツールなしで会話を続行する。段階的リリースのための逃げ道。
//
// ==============================================================================

const {
  GetSecretValueCommand,
  SecretsManagerClient,
} = require('@aws-sdk/client-secrets-manager');

// Lambda実行環境が生きている間はSecretを再取得しない。
// Promiseごとキャッシュし、同時実行時の多重取得も防ぐ。
const secretPromiseCache = new Map();

function decodeSecretValue(response) {
  if (response.SecretString) {
    return response.SecretString;
  }

  if (response.SecretBinary) {
    return Buffer.from(response.SecretBinary).toString('utf8');
  }

  const error = new Error('Tool API key secret has no value');
  error.code = 'TOOL_SECRET_ERROR';
  throw error;
}

function extractToolKeys(secretText) {
  let parsed;

  try {
    parsed = JSON.parse(secretText);
  } catch {
    const error = new Error('Tool API key secret is not valid JSON');
    error.code = 'TOOL_SECRET_ERROR';
    throw error;
  }

  if (!parsed || typeof parsed !== 'object') {
    const error = new Error('Tool API key secret is not a JSON object');
    error.code = 'TOOL_SECRET_ERROR';
    throw error;
  }

  return {
    tavilyApiKey: String(parsed.tavilyApiKey || '').trim(),
    openWeatherMapApiKey: String(parsed.openWeatherMapApiKey || '').trim(),
  };
}

/**
 * ツールAPIキーの取得関数を作る。
 *
 * 戻り値の関数は次を返す。
 * - Secret未設定（TOOL_API_KEY_SECRET_ARN なし） → null（ツール無効）
 * - 取得成功 → { tavilyApiKey, openWeatherMapApiKey }
 */
function createToolSecretProvider({ client, env = process.env, cache = secretPromiseCache } = {}) {
  return async function getToolSecrets() {
    const secretArn = String(env.TOOL_API_KEY_SECRET_ARN || '').trim();

    // ツールを使わない構成では未設定でよい。
    // ここでthrowすると会話自体が止まるため、nullを返して呼出側に判断させる。
    if (!secretArn) {
      return null;
    }

    const region = String(
      env.TOOL_SECRET_REGION || env.MANTLE_SECRET_REGION || env.AWS_REGION || ''
    ).trim();

    const cacheKey = `${region}\u0000${secretArn}`;

    if (!cache.has(cacheKey)) {
      const secretsClient = client || new SecretsManagerClient(region ? { region } : {});

      const loadPromise = secretsClient
        .send(new GetSecretValueCommand({ SecretId: secretArn }))
        .then((response) => extractToolKeys(decodeSecretValue(response)));

      cache.set(cacheKey, loadPromise);

      // 失敗はキャッシュしない。次回リトライできるようにする。
      loadPromise.catch(() => cache.delete(cacheKey));
    }

    return cache.get(cacheKey);
  };
}

const getToolSecrets = createToolSecretProvider();

module.exports = {
  createToolSecretProvider,
  getToolSecrets,
  extractToolKeys,
};
