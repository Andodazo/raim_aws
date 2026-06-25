'use strict';

// ==============================================================================
// API Gateway WebSocket Handler
// ==============================================================================
//
// API Gateway WebSocketから呼ばれるイベントを処理する。
//
// $connect:
//   Cognito Authorizerで認証済みのユーザーsubとconnectionIdをDynamoDBへ保存する。
//
// $disconnect:
//   connectionIdをDynamoDBから削除する。
//
// $default:
//   クライアントから送られたJSON本文をCore Lambda用Request Queueへ投入する。
//
// このLambdaではMantle/Titanは呼ばない。
// Edge Lambdaは入口として素早く受付応答を返し、重い処理はCore Lambdaへ任せる。

const { createConnectionStore } = require('./connection-store');
const { createRequestQueuePublisher } = require('./request-queue-publisher');
const { normalizeWebSocketEvent, WebSocketEventError } = require('./websocket-event');
const {
  createAcceptedResponse,
  createHttpResponse,
  createOkResponse,
} = require('./websocket-response');

function createWebSocketHandler({
  connectionStore,
  requestPublisher,
} = {}) {
  const getConnectionStore = () => connectionStore || createConnectionStore();
  const getRequestPublisher = () => requestPublisher || createRequestQueuePublisher();

  async function handleConnect(normalized) {
    await getConnectionStore().putConnection({
      connectionId: normalized.connectionId,
      sub: normalized.sub,
      domainName: normalized.domainName,
      stage: normalized.stage,
    });

    return createOkResponse({
      type: 'connected',
      connectionId: normalized.connectionId,
    });
  }

  async function handleDisconnect(normalized) {
    await getConnectionStore().deleteConnection(normalized.connectionId);

    return createOkResponse({
      type: 'disconnected',
    });
  }

  async function handleDefault(normalized) {
    let sub = normalized.sub;

    // WebSocket APIでは、認証情報が `$connect` には存在しても、
    // 後続の `$default` イベントに毎回含まれるとは限らない。
    // そのため `$connect` 時に保存した接続テーブルからsubを補完する。
    if (!sub) {
      const connection = await getConnectionStore().getConnection?.(normalized.connectionId);
      sub = String(connection?.sub || '').trim();
    }

    if (!sub) {
      return createHttpResponse(401, {
        code: 'UNAUTHORIZED',
        message: 'Cognito sub is required',
      });
    }

    // Core Lambdaが必要とする最小イベント形式に変換してRequest Queueへ送る。
    // Core側のcore-event.jsは、このpayloadを `source: websocket` として受け取る。
    const request = await getRequestPublisher().publishChatRequest({
      requestId: normalized.requestId,
      connectionId: normalized.connectionId,
      sub,
      text: normalized.text,
      images: normalized.images,
    });

    // WebSocketの入口では「受付完了」だけを返す。
    // 実際の生成結果は、Core Lambda -> Response Queue -> Edge Lambda -> WebSocketで後続送信される。
    return createAcceptedResponse({
      type: 'accepted',
      requestId: request.requestId,
    });
  }

  return async function handleWebSocketEvent(event, context = {}) {
    let normalized;

    try {
      normalized = normalizeWebSocketEvent(event, context);
    } catch (error) {
      if (error instanceof WebSocketEventError) {
        return createHttpResponse(400, {
          code: error.code,
          message: error.message,
          details: error.details,
        });
      }

      throw error;
    }

    switch (normalized.routeKey) {
      case '$connect':
        return handleConnect(normalized);

      case '$disconnect':
        return handleDisconnect(normalized);

      case '$default':
      default:
        return handleDefault(normalized);
    }
  };
}

function handleWebSocketEvent(event, context = {}) {
  return createWebSocketHandler()(event, context);
}

module.exports = {
  createWebSocketHandler,
  handleWebSocketEvent,
};
