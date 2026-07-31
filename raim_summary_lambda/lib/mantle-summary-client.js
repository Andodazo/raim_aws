'use strict';

// ==============================================================================
// 要約用 Mantle クライアント（非ストリーミング）
// ==============================================================================
//
// Core Lambda の mantle-client.js は、会話用に SSE ストリーミング・ツール呼出・
// previous_response_id の失効リカバリなどを備えた700行超の実装になっている。
//
// 要約は次の点で条件が違うため、機能を絞った軽量版を用意する。
//
//   - 裏で走るのでユーザーを待たせない → ストリーミング不要
//   - ツールを使わない                → tools 不要
//   - 会話文脈に紐づけない            → previous_response_id 不要（store:false）
//
// 結果として「1回投げて本文を受け取るだけ」で済むため、
// Core のクライアントを丸ごと複製せずこの実装で足りる。

const { getMantleApiKey } = require('./mantle-secret-provider');

const DEFAULT_TIMEOUT_MS = 30000;

// ─────────────────────────────────────────────
// 設定
// ─────────────────────────────────────────────

function resolveBaseUrl(env) {
  const explicitUrl = String(env.OPENAI_BASE_URL || env.MANTLE_BASE_URL || '').trim();
  if (explicitUrl) {
    return explicitUrl;
  }
  const region = String(env.BEDROCK_MANTLE_REGION || 'us-east-1').trim();
  return `https://bedrock-mantle.${region}.api.aws/openai/v1`;
}

function buildUrl(baseUrl, path = '/responses') {
  return `${String(baseUrl).replace(/\/$/, '')}/${String(path).replace(/^\//, '')}`;
}

function requiredSetting(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) {
    const error = new Error(`${name} is not configured`);
    error.coreErrorCode = 'MANTLE_CONFIG_ERROR';
    throw error;
  }
  return value;
}

// ─────────────────────────────────────────────
// 本体
// ─────────────────────────────────────────────

/**
 * 要約用の Mantle クライアントを作る。
 *
 * @param {Object} [deps]
 * @param {Function} [deps.fetchImpl] テスト用の fetch 差し替え
 * @param {Object} [deps.env]
 * @param {Function} [deps.apiKeyProvider]
 */
function createSummaryMantleClient(deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const env = deps.env || process.env;
  const apiKeyProvider = deps.apiKeyProvider || getMantleApiKey;

  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation is required');
  }

  /**
   * 要約を1回生成する。
   *
   * @param {Object} params
   * @param {Array} params.messages [{ role, content }]
   * @param {string} params.model
   * @param {string} params.reasoningEffort 'none' | 'low' | 'medium' | 'high' | 'off'
   * @param {number} params.maxOutputTokens
   * @returns {Promise<{ text: string, usage: Object|null, responseId: string }>}
   */
  return async function createSummary({
    messages,
    model,
    reasoningEffort = 'medium',
    maxOutputTokens = 1024,
  }) {
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('messages are required');
    }

    const resolvedModel = model || requiredSetting(env, 'MANTLE_MODEL');
    const apiKey = await apiKeyProvider();
    const url = buildUrl(resolveBaseUrl(env), env.MANTLE_RESPONSES_PATH);

    const body = {
      model: resolvedModel,
      input: messages,
      max_output_tokens: Number(maxOutputTokens) || 1024,
      // 要約は会話文脈に紐づけない独立呼び出し。
      // Mantle 側へ履歴として残さないため store:false。
      store: false,
    };

    // 'off' のときだけ reasoning フィールド自体を送らずモデル既定に任せる。
    if (reasoningEffort && reasoningEffort !== 'off') {
      body.reasoning = { effort: reasoningEffort };
    }

    const timeoutMs = Number(env.SUMMARY_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const wrapped = new Error(`Mantle request failed: ${error.message}`);
      wrapped.coreErrorCode = 'MANTLE_ERROR';
      throw wrapped;
    } finally {
      clearTimeout(timer);
    }

    const rawBody = await response.text();

    if (!response.ok) {
      const error = new Error(
        `Mantle returned ${response.status}: ${rawBody.slice(0, 500)}`
      );
      error.coreErrorCode = 'MANTLE_ERROR';
      error.status = response.status;
      throw error;
    }

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      const error = new Error('Mantle returned a non-JSON body');
      error.coreErrorCode = 'MANTLE_ERROR';
      throw error;
    }

    return {
      text: extractOutputText(payload),
      usage: payload.usage || null,
      responseId: String(payload.id || ''),
    };
  };
}

/**
 * Responses API の output から本文テキストを取り出す。
 *
 * output は message / reasoning / function_call などが混在する配列。
 * 要約では message の output_text だけを拾う。
 */
function extractOutputText(payload) {
  if (!payload || !Array.isArray(payload.output)) {
    return '';
  }

  let text = '';

  for (const item of payload.output) {
    if (!item || item.type !== 'message') continue;
    for (const part of item.content || []) {
      if (part && typeof part.text === 'string') {
        text += part.text;
      }
    }
  }

  return text.trim();
}

module.exports = {
  createSummaryMantleClient,
  extractOutputText,
  resolveBaseUrl,
  buildUrl,
};
