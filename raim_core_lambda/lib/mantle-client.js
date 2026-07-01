'use strict';

// ==============================================================================
// Mantle Responses API Client
// ==============================================================================
//
// prompt-builder.js が作成したメッセージを、MantleのResponses APIへ送信する。
// このファイルにはmockや固定文応答を持たせず、必ず外部APIを呼び出す。
//
// Amazon Bedrock MantleはOpenAI Responses API互換のHTTP endpointを提供する。
// RAiMではGemma 4を利用するため、Mantleは米国東部（バージニア北部）へ接続する。
// LambdaやTitanの実行リージョンが東京でも、Mantle endpointは次へ固定する。
//   https://bedrock-mantle.us-east-1.api.aws/openai/v1
//
// 接続情報は環境ごとに異なるため、APIキーやmodel IDをコードへ埋め込まない。
// Lambdaでは次の環境変数を設定する。
//
// 必須:
// - MANTLE_API_KEY_SECRET_ARN: APIキーを保存したSecrets Manager Secret ARN
// - MANTLE_API_KEY_SECRET_JSON_KEY: Secret JSON内のAPIキー項目名
// - MANTLE_SECRET_REGION: Secretを作成したリージョン
// - MANTLE_MODEL: Responses API対応のBedrock model ID
//
// 任意:
// - BEDROCK_MANTLE_REGION: endpointのAWSリージョン。既定値 us-east-1
// - OPENAI_BASE_URL: 公式形式でendpointを明示する場合に設定
// - MANTLE_BASE_URL: endpoint設定名の後方互換用
// - MANTLE_RESPONSES_PATH: Responses APIのpath。既定値 /responses
// - MANTLE_API_KEY_HEADER: APIキーを入れるヘッダー。既定値 Authorization
// - MANTLE_API_KEY_PREFIX: APIキーのprefix。既定値 Bearer
// - MANTLE_TIMEOUT_MS: HTTPタイムアウト。既定値 30000ms
// - MANTLE_MAX_OUTPUT_TOKENS: 最大出力token数。既定値 1024
// - MANTLE_TEMPERATURE: temperature。既定値 0.7
//
// APIキーはログやエラーdetailsへ出さないこと。
//
// 【Mantleへ送る主なrequest】
// {
//   model: "設定したモデルID",
//   input: [{ role: "system", content: "..." }, ...],
//   store: true,
//   stream: true,
//   previous_response_id: "resp-...", // 継続会話時だけ
//   max_output_tokens: 1024,
//   temperature: 0.7
// }
//
// 【このファイルが返す内部形式】
// SSEで届くresponse.output_text.deltaを連結し、後続が扱いやすい形へ変換する。
// {
//   responseId: "resp-...",
//   rawText: "{\"text\":...}",
//   createdAt: "ISO-8601",
//   usedPreviousResponseId: true,
//   finishReason: "completed"
// }
//
// rawTextのJSON妥当性やemotion補正はresponse-validator.jsの責務。
// onTextDeltaを指定した呼び出し元には、各deltaを受信直後に通知する。
// このClientはHTTP/SSE通信とMantle responseの取り出しに専念する。
// ==============================================================================

const { getMantleApiKey } = require('./mantle-secret-provider');

/**
 * 必須環境変数を読み取る。
 * 空値のまま外部通信すると分かりにくい401や不正URLになるため、送信前に設定エラーにする。
 */
function requiredSetting(env, name) {
  const value = String(env[name] || '').trim();

  if (!value) {
    const error = new Error(`${name} is required for Mantle connection`);
    error.code = 'MANTLE_CONFIG_ERROR';
    throw error;
  }

  return value;
}

/**
 * 数値環境変数を読み取る。
 * Lambda環境変数はすべて文字列なので、ここでNumberへ変換して有限値か確認する。
 */
function numberSetting(env, name, fallback) {
  const value = Number(env[name] ?? fallback);

  if (!Number.isFinite(value)) {
    const error = new Error(`${name} must be a finite number`);
    error.code = 'MANTLE_CONFIG_ERROR';
    throw error;
  }

  return value;
}

/**
 * Amazon Bedrock Mantleのbase URLを決める。
 *
 * RAiMの既定値はGemma 4を利用するus-east-1。
 * LambdaのAWS_REGIONは参照しないため、Core Lambdaが東京で動いていても
 * Mantleだけが誤ってap-northeast-1へ向くことはない。
 * ローカルテストや将来のendpoint変更時だけMANTLE_BASE_URLで上書きできる。
 */
function resolveMantleBaseUrl(env = process.env) {
  const explicitUrl = String(
    env.OPENAI_BASE_URL || env.MANTLE_BASE_URL || ''
  ).trim();

  if (explicitUrl) {
    return explicitUrl;
  }

  const region = String(
    env.BEDROCK_MANTLE_REGION || 'us-east-1'
  ).trim();

  return `https://bedrock-mantle.${region}.api.aws/openai/v1`;
}

/**
 * BASE URLとpathのslashを揃え、実際にPOSTするURLを作る。
 *
 * 例:
 * baseUrl="https://bedrock-mantle.us-east-1.api.aws/openai/v1", path="/responses"
 * → "https://bedrock-mantle.us-east-1.api.aws/openai/v1/responses"
 */
function buildMantleUrl(baseUrl, responsesPath = '/responses') {
  return `${String(baseUrl).replace(/\/$/, '')}/${String(responsesPath).replace(/^\//, '')}`;
}

/**
 * prompt-builderの内部表現をResponses APIのinputへ変換する。
 * 現在の内部表現はResponses API互換のrole/content構造なので、
 * 不要な内部フィールドを除きながらコピーするだけでよい。
 *
 * previousResponseId:
 * - あり: Mantle側に保存された直前までの会話へ今回のinputを接続する
 * - なし: system promptやFew-shotを含む新しい会話として開始する
 *
 * store=trueにより、今回の応答もMantle側へ保存され、返されたidを次回利用できる。
 */
function buildMantleRequest({ mantleInput, previousResponseId, store }, env) {
  const messages = Array.isArray(mantleInput?.messages)
    ? mantleInput.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }))
    : [];

  if (messages.length === 0) {
    const error = new Error('mantleInput.messages is required');
    error.code = 'MANTLE_INPUT_ERROR';
    throw error;
  }

  const request = {
    model: requiredSetting(env, 'MANTLE_MODEL'),
    input: messages,
    store: store !== false,
    // Bedrock MantleからSSEイベントを逐次受信するため、常にstreamを有効にする。
    stream: true,
    max_output_tokens: numberSetting(env, 'MANTLE_MAX_OUTPUT_TOKENS', 1024),
    temperature: numberSetting(env, 'MANTLE_TEMPERATURE', 0.7),
  };

  // response_idが有効なときだけ指定する。
  // 初回や期限切れ後の再試行では、このフィールド自体を送らない。
  if (previousResponseId) {
    request.previous_response_id = previousResponseId;
  }

  return request;
}

/**
 * Mantle Responses APIのoutputから、アシスタントが生成した本文を取り出す。
 * output_text集約フィールドと、output[].content[]の両形式に対応する。
 */
function extractMantleOutputText(response) {
  if (typeof response?.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const textParts = [];

  for (const item of Array.isArray(response?.output) ? response.output : []) {
    for (const content of Array.isArray(item?.content) ? item.content : []) {
      if (typeof content?.text === 'string') {
        textParts.push(content.text);
      } else if (typeof content?.text?.value === 'string') {
        textParts.push(content.text.value);
      }
    }
  }

  // Mantle環境によってChat Completions互換形式を返す場合にも、
  // 応答本文を失わないよう最後の互換経路として扱う。
  if (textParts.length === 0) {
    const choiceContent = response?.choices?.[0]?.message?.content;
    if (typeof choiceContent === 'string') {
      textParts.push(choiceContent);
    }
  }

  return textParts.join('\n').trim();
}

function normalizeCreatedAt(value) {
  // Responses API系ではUnix秒、互換APIではISO文字列の場合があるため両方を受け付ける。
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }

  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }

  return new Date().toISOString();
}

/**
 * HTTPエラーを、mantle-session-policy.jsが判定できる形へ揃える。
 *
 * statusCode/code/messageを例外へ付けることで、上位層は次を判別できる。
 * - previous_response_id失効 → 状態をクリアして1回再試行
 * - 429/5xx → 一時障害としてretriable=true
 * - その他4xx → 設定・入力問題としてretriable=false
 */
function createMantleHttpError(statusCode, payload, requestId) {
  const apiError = payload?.error || payload || {};
  const message = apiError.message || `Mantle request failed with HTTP ${statusCode}`;
  const error = new Error(String(message));
  error.name = 'MantleHttpError';
  error.statusCode = statusCode;
  error.code = apiError.code || 'MANTLE_HTTP_ERROR';
  error.requestId = requestId || '';
  error.coreErrorCode = 'LLM_ERROR';
  error.retriable = statusCode === 429 || statusCode >= 500;
  return error;
}

/**
 * SSEの1イベント分をJavaScript Objectへ変換する。
 *
 * Bedrock Mantleのstream responseは次のようなブロックを空行区切りで返す。
 *
 * event: response.output_text.delta
 * data: {"type":"response.output_text.delta","delta":"こん"}
 *
 * dataが[DONE]の場合はstream終端なのでnullを返す。
 */
function parseSseEventBlock(block) {
  const dataLines = [];
  let eventName = '';

  for (const line of String(block || '').split(/\r?\n/)) {
    if (!line || line.startsWith(':')) {
      continue;
    }

    const separatorIndex = line.indexOf(':');
    const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
    const value = separatorIndex === -1
      ? ''
      : line.slice(separatorIndex + 1).replace(/^ /, '');

    if (field === 'event') {
      eventName = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
  }

  const data = dataLines.join('\n').trim();

  if (!data || data === '[DONE]') {
    return null;
  }

  try {
    const event = JSON.parse(data);

    // APIがpayload.typeを省略した場合でも、SSEのevent fieldを使って判定できるようにする。
    if (eventName && !event.type) {
      event.type = eventName;
    }

    return event;
  } catch (error) {
    const parseError = new Error('Mantle returned an invalid SSE event');
    parseError.code = 'MANTLE_STREAM_PARSE_ERROR';
    parseError.coreErrorCode = 'LLM_ERROR';
    parseError.retriable = true;
    parseError.cause = error;
    throw parseError;
  }
}

/**
 * fetchのReadableStreamを読み、SSEイベントを1件ずつyieldする。
 *
 * ネットワークchunkの境界とSSEイベント境界は一致しない。
 * JSONの途中でchunkが切れても処理できるようbufferへ貯め、空行が来た時だけparseする。
 */
async function* iterateMantleSseEvents(body) {
  if (!body || typeof body.getReader !== 'function') {
    const error = new Error('Mantle streaming response body is missing');
    error.code = 'MANTLE_STREAM_MISSING';
    error.coreErrorCode = 'LLM_ERROR';
    error.retriable = true;
    throw error;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

      // CRLFとLFを同じ区切りとして扱う。
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundaryIndex = buffer.indexOf('\n\n');

      while (boundaryIndex !== -1) {
        const block = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + 2);
        const event = parseSseEventBlock(block);

        if (event) {
          yield event;
        }

        boundaryIndex = buffer.indexOf('\n\n');
      }

      if (done) {
        break;
      }
    }

    // 最後のイベント直後に空行がない実装もあるため、残りbufferも確認する。
    const finalEvent = parseSseEventBlock(buffer);
    if (finalEvent) {
      yield finalEvent;
    }
  } finally {
    reader.releaseLock?.();
  }
}

/**
 * MantleのSSEイベントを最後まで消費し、Core内部responseを組み立てる。
 *
 * onStreamEvent:
 *   response.created/completedを含む全イベントを通知する。監視・中継用途。
 *
 * onTextDelta:
 *   response.output_text.deltaだけを通知する。Edge/Response Queueへ文字列chunkを
 *   転送する場合はこちらを使う。Promiseを返した場合は完了まで待ち、順序を保つ。
 */
async function consumeMantleStream(body, {
  onStreamEvent,
  onTextDelta,
} = {}) {
  let responseId = '';
  let createdAt = '';
  let finishReason = '';
  let rawText = '';
  let completedResponse = null;

  for await (const event of iterateMantleSseEvents(body)) {
    if (typeof onStreamEvent === 'function') {
      await onStreamEvent(event);
    }

    if (event.type === 'response.output_text.delta') {
      const delta = String(event.delta || '');
      rawText += delta;

      if (delta && typeof onTextDelta === 'function') {
        await onTextDelta(delta, event);
      }
    }

    if (event.type === 'response.output_text.done' && !rawText) {
      rawText = String(event.text || '');
    }

    if (event.response && typeof event.response === 'object') {
      responseId = String(event.response.id || responseId || '');
      createdAt = normalizeCreatedAt(
        event.response.created_at || event.response.createdAt || createdAt
      );

      if (event.type === 'response.completed') {
        completedResponse = event.response;
        finishReason = event.response.status || 'completed';
      }
    }

    if (event.type === 'response.failed' || event.type === 'error') {
      const payload = event.response?.error || event.error || event;
      const error = new Error(payload.message || 'Mantle streaming response failed');
      error.name = 'MantleStreamError';
      error.code = payload.code || 'MANTLE_STREAM_ERROR';
      error.coreErrorCode = 'LLM_ERROR';
      error.retriable = true;
      throw error;
    }
  }

  // deltaが送られない互換実装では、completed eventの完全responseから本文を取り出す。
  if (!rawText && completedResponse) {
    rawText = extractMantleOutputText(completedResponse);
  }

  return {
    responseId,
    rawText,
    createdAt: createdAt || new Date().toISOString(),
    finishReason,
  };
}

/**
 * fetchを注入可能にして、単体テストでは外部通信なしでrequest/responseを検証する。
 * 本番ではNode.js 24のglobal fetchを使用する。
 *
 * @param {Function} fetchImpl - HTTP送信関数。通常はglobalThis.fetch。
 * @param {object} env - Lambda環境変数。テスト時だけ専用Objectを渡せる。
 * @param {Function} apiKeyProvider - Secrets ManagerからAPIキーを返す非同期関数。
 * @returns {Function} createMantleResponse関数。
 */
function createMantleClient({
  fetchImpl = globalThis.fetch,
  env = process.env,
  apiKeyProvider = getMantleApiKey,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch implementation is required');
  }

  if (typeof apiKeyProvider !== 'function') {
    throw new Error('Mantle API key provider is required');
  }

  return async function createMantleResponse({
    mantleInput,
    previousResponseId = '',
    store = true,
    onStreamEvent,
    onTextDelta,
  }) {
    if (!mantleInput || typeof mantleInput !== 'object') {
      throw new Error('mantleInput is required');
    }

    // 1. Mantle endpointを確定し、Secrets ManagerからAPIキーを取得する。
    // 環境変数にはAPIキー本体を置かず、Secret ARNなどの参照情報だけを置く。
    // provider側でwarm container内キャッシュを使うため、通常は初回だけAWSへ問い合わせる。
    const baseUrl = resolveMantleBaseUrl(env);
    const apiKey = String(await apiKeyProvider()).trim();

    if (!apiKey) {
      const error = new Error('Mantle API key provider returned an empty value');
      error.code = 'MANTLE_SECRET_INVALID';
      throw error;
    }

    const apiKeyHeader = String(env.MANTLE_API_KEY_HEADER || 'Authorization').trim();
    const apiKeyPrefix = String(env.MANTLE_API_KEY_PREFIX ?? 'Bearer').trim();
    const timeoutMs = numberSetting(env, 'MANTLE_TIMEOUT_MS', 30000);
    // 2. Mantleが応答しない場合にLambda実行時間を使い切らないよう、
    // AbortControllerでHTTP通信単体のタイムアウトを設ける。
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    // 3. 認証headerはMantle環境差を吸収できるよう、header名とprefixも設定可能にする。
    // 既定値は Authorization: Bearer <API_KEY>。
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      [apiKeyHeader]: apiKeyPrefix ? `${apiKeyPrefix} ${apiKey}` : apiKey,
    };

    if (env.MANTLE_ORGANIZATION) {
      headers['OpenAI-Organization'] = String(env.MANTLE_ORGANIZATION);
    }

    try {
      // 4. stream=trueを含むResponses API requestをJSONでPOSTする。
      const response = await fetchImpl(
        buildMantleUrl(baseUrl, env.MANTLE_RESPONSES_PATH),
        {
          method: 'POST',
          headers,
          body: JSON.stringify(buildMantleRequest({
            mantleInput,
            previousResponseId,
            store,
          }, env)),
          signal: controller.signal,
        }
      );
      // 5. HTTPエラー時だけbody全体をJSONとして読む。
      // 成功時のbodyはSSE streamなのでtext()で一括取得しない。
      if (!response.ok) {
        const responseText = await response.text();
        let payload = {};

        try {
          payload = responseText ? JSON.parse(responseText) : {};
        } catch (error) {
          payload = { message: `Mantle request failed with HTTP ${response.status}` };
        }

        throw createMantleHttpError(
          response.status,
          payload,
          response.headers?.get?.('x-request-id')
        );
      }

      // 6. SSEを逐次読み、delta callbackを呼びながら最終responseも組み立てる。
      const streamed = await consumeMantleStream(response.body, {
        onStreamEvent,
        onTextDelta,
      });
      const responseId = String(streamed.responseId || '').trim();
      const rawText = streamed.rawText;

      if (!responseId) {
        const error = new Error('Mantle response id is missing');
        error.code = 'MANTLE_RESPONSE_INVALID';
        error.coreErrorCode = 'LLM_ERROR';
        error.retriable = true;
        throw error;
      }

      if (!rawText) {
        const error = new Error('Mantle response text is missing');
        error.code = 'MANTLE_RESPONSE_INVALID';
        error.coreErrorCode = 'LLM_ERROR';
        error.retriable = true;
        throw error;
      }

      return {
        responseId,
        rawText,
        createdAt: streamed.createdAt,
        store: store !== false,
        mode: mantleInput.mode || 'initial',
        usedPreviousResponseId: Boolean(previousResponseId),
        finishReason: streamed.finishReason,
      };
    } catch (error) {
      // AbortControllerによる中断だけは明示的なtimeoutエラーへ変換する。
      if (error.name === 'AbortError') {
        const timeoutError = new Error(`Mantle request timed out after ${timeoutMs}ms`);
        timeoutError.name = 'MantleTimeoutError';
        timeoutError.code = 'MANTLE_TIMEOUT';
        timeoutError.coreErrorCode = 'LLM_TIMEOUT';
        timeoutError.retriable = true;
        throw timeoutError;
      }

      // DNS障害や接続拒否などfetch由来のエラーもLLM呼び出し失敗として分類する。
      if (!error.coreErrorCode) {
        error.coreErrorCode = 'LLM_ERROR';
        error.retriable = true;
      }

      throw error;
    } finally {
      // 正常終了・例外のどちらでもtimerを解放し、Lambdaコンテナへ不要なhandleを残さない。
      clearTimeout(timeout);
    }
  };
}

const createMantleResponse = createMantleClient();

/**
 * CloudWatchや診断用に、巨大なrawTextを除いた応答概要を作る。
 * APIキー、prompt、モデル出力本文は含めない。
 */
function summarizeMantleResponse(response) {
  if (!response || typeof response !== 'object') {
    return null;
  }

  return {
    responseId: response.responseId || '',
    createdAt: response.createdAt || '',
    mode: response.mode || '',
    usedPreviousResponseId: Boolean(response.usedPreviousResponseId),
    finishReason: response.finishReason || '',
  };
}

module.exports = {
  buildMantleRequest,
  buildMantleUrl,
  consumeMantleStream,
  createMantleClient,
  createMantleResponse,
  extractMantleOutputText,
  iterateMantleSseEvents,
  normalizeCreatedAt,
  parseSseEventBlock,
  resolveMantleBaseUrl,
  summarizeMantleResponse,
};
