'use strict';

// ==============================================================================
// WebSocket Postback Client
// ==============================================================================
//
// API Gateway WebSocketへサーバー側からメッセージを返すには、
// ApiGatewayManagementApiのPostToConnectionを使う。
//
// 注意:
// SQS Response Queueから呼ばれるLambdaイベントには、API GatewayのdomainName/stageが無い。
// そのため `WEBSOCKET_API_ENDPOINT` 環境変数で
// https://{api-id}.execute-api.{region}.amazonaws.com/{stage}
// を指定しておく。

const {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} = require('@aws-sdk/client-apigatewaymanagementapi');
const { getEdgeConfig } = require('./config');

function createPayloadTooLargeError(payload, payloadBytes, maximumBytes) {
  const error = new Error(
    `WebSocket payload exceeds limit: ${payloadBytes} bytes`
  );

  error.code = 'WEBSOCKET_PAYLOAD_TOO_LARGE';
  error.retriable = false;
  error.details = {
    payloadBytes,
    maximumBytes,
    type: payload?.type,
    requestId: payload?.requestId,
    chunkId: payload?.chunk_id,
    partIndex: payload?.part_index,
  };

  return error;
}

function createGoneErrorDetector(error) {
  return error?.name === 'GoneException' ||
    error?.$metadata?.httpStatusCode === 410;
}

function createWebSocketPostback({ client, env = process.env } = {}) {
  const config = getEdgeConfig(env);
  const apiClient = client || new ApiGatewayManagementApiClient({
    endpoint: config.websocketApiEndpoint,
    region: config.awsRegion,
  });

  async function postJson(connectionId, payload) {
    const data = Buffer.from(JSON.stringify(payload), 'utf8');

    if (data.byteLength > config.maxWebSocketMessageBytes) {
      throw createPayloadTooLargeError(
        payload,
        data.byteLength,
        config.maxWebSocketMessageBytes
      );
    }

    try {
      await apiClient.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: data,
      }));

      return {
        ok: true,
      };
    } catch (error) {
      if (createGoneErrorDetector(error)) {
        return {
          ok: false,
          gone: true,
          error,
        };
      }

      throw error;
    }
  }

  return {
    postJson,
  };
}

module.exports = {
  createGoneErrorDetector,
  createPayloadTooLargeError,
  createWebSocketPostback,
};
