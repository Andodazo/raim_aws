'use strict';

// ==============================================================================
// RAiM Core Lambda エントリポイント
// ==============================================================================
//
// 【このファイルの役割】
// Lambda Runtimeから最初に呼ばれる入口。
// 実際の会話処理は core-chat-service.js に任せ、このファイルでは以下だけを行う。
//
// 1. Lambdaの awsRequestId を予備の requestId として受け取る
// 2. Core Chat Serviceへeventを渡す
// 3. 想定外の例外を、Edge Lambdaが扱えるerrorレスポンスへ変換する
//
// 【返却形式】
// API Gateway用の { statusCode, headers, body } ではなく、Core Lambda固有の
// JSONオブジェクトをそのまま返す。HTTP/WebSocketへの変換はEdge側の責務。
//
// 成功例:
// {
//   ok: true,
//   type: "chat",
//   requestId: "req-001",
//   text: "こんにちは",
//   emotion: "happy",
//   intensity: 0.6
// }
//
// エラー例:
// {
//   ok: false,
//   type: "error",
//   requestId: "req-001",
//   code: "EMBED_ERROR",
//   message: "Titan embedding request failed",
//   retriable: true
// }
// ==============================================================================

const { handleCoreChat } = require('./lib/core-chat-service');
const { getCoreRequestId } = require('./lib/core-event');
const { createCoreError } = require('./lib/core-response');
const { handleSqsBatch, isSqsEvent } = require('./lib/sqs-core-handler');
const { ERROR_CODES } = require('./lib/types');

/**
 * 外部接続エラーをクライアントが扱えるRAiMのエラーコードへ分類する。
 *
 * Mantle/TitanのSDKエラーをそのまま返すと、AWS固有の例外名や内部情報が
 * Edge Lambda・クライアントへ漏れる。また、呼び出し元が再送可否を判断しづらい。
 * そのため、外部クライアントが付けたcoreErrorCodeをRAiMの定義済みコードへ変換する。
 *
 * Mantle/Titanクライアントが付けたcoreErrorCodeだけを採用し、
 * 未知の例外は安全側に倒してINTERNAL_ERRORにする。
 *
 * @param {Error} error - Core Chat Serviceから送出された例外。
 * @returns {{code: string, message: string, retriable: boolean}}
 */
function classifyCoreError(error) {
  const knownCodes = new Set(Object.values(ERROR_CODES));
  const code = knownCodes.has(error?.coreErrorCode)
    ? error.coreErrorCode
    : ERROR_CODES.INTERNAL_ERROR;
  const messages = {
    [ERROR_CODES.LLM_TIMEOUT]: 'Mantle request timed out',
    [ERROR_CODES.LLM_ERROR]: 'Mantle request failed',
    [ERROR_CODES.EMBED_ERROR]: 'Titan embedding request failed',
    [ERROR_CODES.INTERNAL_ERROR]: 'Internal server error',
  };

  return {
    code,
    message: messages[code] || 'Internal server error',
    retriable: typeof error?.retriable === 'boolean' ? error.retriable : true,
  };
}

exports.handler = async (event, context) => {
  // クライアントがrequestIdを送らなかった場合でも追跡可能にするため、
  // Lambda RuntimeがInvocationごとに発行するawsRequestIdを予備値として渡す。
  const fallbackRequestId = context && context.awsRequestId;

  // 本番のRequest Queue経路。
  // SQS Event Source MappingではbatchItemFailuresを返す必要があるため、
  // 直接呼び出し用のCore responseとは別のhandlerへ分岐する。
  if (isSqsEvent(event)) {
    return handleSqsBatch(event, context);
  }

  try {
    // 入力正規化、DynamoDB、Titan、Mantle、response_id保存までの本処理。
    return await handleCoreChat(event, { fallbackRequestId });
  } catch (error) {
    // CloudWatch Logsには原因調査用の例外を残す。
    // クライアントへは下で分類した安全な文言だけを返す。
    console.error('Unhandled Core Lambda error:', error);
    const classified = classifyCoreError(error);

    return createCoreError({
      requestId: getCoreRequestId(event, fallbackRequestId),
      code: classified.code,
      message: classified.message,
      retriable: classified.retriable,
      details: {
        errorMessage: error.message,
      },
    });
  }
};

module.exports.classifyCoreError = classifyCoreError;
