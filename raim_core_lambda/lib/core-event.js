'use strict';

// ==============================================================================
// Core Lambda Event Normalizer
// ==============================================================================
//
// 【このファイルの役割】
// 呼び出し元ごとに形が異なるeventを、Core Chat Serviceが扱う1つの形式へ揃える。
// Core Chat Serviceは「どこから呼ばれたか」を意識せず、正規化後の値だけを使う。
//
// 【受け付ける入力】
// 1. Edge Lambdaなどからの直接呼び出し
//    { sub, requestId, connectionId, text, images, source }
//
// 2. SQS Event Source Mapping
//    { Records: [{ body: "{...JSON...}" }] }
//
// 3. Lambdaコンソール等でbodyを使ったテスト
//    { body: "{...JSON...}" }
//
// 【正規化後の形式】
// {
//   sub: "cognito-user-sub",
//   requestId: "req-001",
//   connectionId: "websocket-connection-id", // 任意
//   source: "websocket",
//   text: "こんにちは",
//   images: []
// }
//
// JSON解釈や入力検証に失敗した場合はCoreEventErrorを投げる。
// core-chat-service.jsがこれをINVALID_INPUTレスポンスへ変換する。
// ==============================================================================

const crypto = require('crypto');
const { ERROR_CODES, validateUpstream } = require('./types');

class CoreEventError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'CoreEventError';
    this.code = ERROR_CODES.INVALID_INPUT;
    this.retriable = false;
    this.details = details;
  }
}

/**
 * JSON文字列ならObjectへ変換し、すでにObjectならそのまま返す。
 * labelは「SQS bodyの失敗か、event.bodyの失敗か」をエラーで判別するために使う。
 */
function parseJson(value, label) {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    throw new CoreEventError(`${label} must be valid JSON`, {
      parseError: error.message,
    });
  }
}

/**
 * 呼び出し元固有の外側の包みを外し、会話payloadを取り出す。
 *
 * SQSの複数recordを暗黙に先頭1件だけ処理すると、残りを処理済みとして
 * 失う危険がある。そのため現構成では「1 Invocation = 1 record」を明示し、
 * 2件以上なら設定不備として拒否する。
 *
 * @returns {{payload: object, source: string}}
 */
function unwrapCorePayload(event) {
  if (!event || typeof event !== 'object') {
    throw new CoreEventError('Core event must be an object');
  }

  if (Array.isArray(event.Records)) {
    if (event.Records.length !== 1) {
      throw new CoreEventError('Core Lambda expects exactly one SQS record', {
        recordCount: event.Records.length,
      });
    }

    const record = event.Records[0];
    const payload = parseJson(record && record.body, 'SQS record body');

    if (!payload || typeof payload !== 'object') {
      throw new CoreEventError('SQS record body must contain a JSON object');
    }

    return {
      payload,
      source: 'sqs',
    };
  }

  if (Object.prototype.hasOwnProperty.call(event, 'body') && !event.sub) {
    const payload = parseJson(event.body, 'event.body');

    if (!payload || typeof payload !== 'object') {
      throw new CoreEventError('event.body must contain a JSON object');
    }

    return {
      payload,
      source: event.source || 'lambda',
    };
  }

  return {
    payload: event,
    source: event.source || 'lambda',
  };
}

/**
 * requestIdが省略された時の追跡IDを作る。
 * LambdaのawsRequestIdがあればそれを優先し、単体実行時はUUIDを生成する。
 */
function createRequestId(fallbackRequestId) {
  const fallback = String(fallbackRequestId || '').trim();
  return fallback || `req-${crypto.randomUUID()}`;
}

/**
 * 任意文字列フィールドを安全にtrimする。
 * 値が未指定なら空文字、文字列以外なら入力不正として扱う。
 */
function optionalString(value, fieldName) {
  if (value === undefined || value === null || value === '') {
    return '';
  }

  if (typeof value !== 'string') {
    throw new CoreEventError(`${fieldName} must be a string`);
  }

  return value.trim();
}

/**
 * 本処理が失敗した場合でもレスポンスへrequestIdを含めるための補助関数。
 * eventの解釈自体に失敗した時はfallbackまたは新しいUUIDを返す。
 */
function getCoreRequestId(event, fallbackRequestId) {
  try {
    const { payload } = unwrapCorePayload(event);
    return optionalString(payload.requestId, 'requestId') || createRequestId(fallbackRequestId);
  } catch (error) {
    return createRequestId(fallbackRequestId);
  }
}

/**
 * eventをCore Lambda標準形式へ変換し、text/imagesの既存制約も検証する。
 *
 * text未指定は空文字へ補正する。これにより画像だけの会話を許可しつつ、
 * textもimagesも空の場合はvalidateUpstream()がINVALID_INPUTにできる。
 */
function normalizeCoreEvent(event, { fallbackRequestId } = {}) {
  const { payload, source } = unwrapCorePayload(event);
  const sub = optionalString(payload.sub, 'sub');

  if (!sub) {
    throw new CoreEventError('sub is required');
  }

  const requestId = optionalString(payload.requestId, 'requestId') ||
    createRequestId(fallbackRequestId);
  const connectionId = optionalString(payload.connectionId, 'connectionId');
  const normalizedSource = optionalString(payload.source, 'source') || source;
  // types.jsへ入力制約を集約し、Edge/SQS経路で検証内容がずれないようにする。
  const validation = validateUpstream({
    text: payload.text === undefined ? '' : payload.text,
    images: payload.images,
  });

  if (!validation.valid) {
    throw new CoreEventError(validation.error);
  }

  return {
    sub,
    requestId,
    connectionId,
    source: normalizedSource,
    text: validation.message.text,
    images: Array.isArray(validation.message.images)
      ? validation.message.images
      : [],
  };
}

module.exports = {
  CoreEventError,
  getCoreRequestId,
  normalizeCoreEvent,
  unwrapCorePayload,
};
