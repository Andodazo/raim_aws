'use strict';

// ==============================================================================
// RAiM Edge Lambda Entry Point
// ==============================================================================
//
// Edge Lambdaは、クライアントとCore Lambdaの間に立つ「入口/出口」のLambda。
//
// 入口:
//   API Gateway WebSocketから `$connect` / `$disconnect` / `$default` が呼ばれる。
//   `$default` で受け取ったユーザー発話を、Core Lambda用のRequest Queueへ送る。
//
// 出口:
//   Core LambdaがResponse Queueへ流した `stream.start` / `stream.delta` /
//   `stream.completed` / `stream.error` を受け取り、WebSocket接続へpostする。
//
// つまり、このファイルはイベントの種類を見分け、実処理を専用Handlerへ振り分ける。

const { handleWebSocketEvent } = require('./lib/websocket-handler');
const { handleResponseQueueEvent } = require('./lib/response-queue-handler');
const { createHttpResponse } = require('./lib/websocket-response');

function isSqsEvent(event) {
  return Array.isArray(event?.Records) &&
    event.Records.length > 0 &&
    event.Records.every((record) => record.eventSource === 'aws:sqs');
}

function isWebSocketEvent(event) {
  return Boolean(event?.requestContext?.connectionId);
}

async function handler(event, context = {}) {
  try {
    if (isSqsEvent(event)) {
      return handleResponseQueueEvent(event);
    }

    if (isWebSocketEvent(event)) {
      return handleWebSocketEvent(event, context);
    }

    return createHttpResponse(400, {
      code: 'UNSUPPORTED_EVENT',
      message: 'Edge Lambda supports API Gateway WebSocket events and SQS events only.',
    });
  } catch (error) {
    console.error('Edge Lambda unhandled error', {
      name: error.name,
      message: error.message,
      code: error.code,
    });

    return createHttpResponse(500, {
      code: error.code || 'INTERNAL_ERROR',
      message: 'Internal server error',
    });
  }
}

module.exports = {
  handler,
  isSqsEvent,
  isWebSocketEvent,
};
