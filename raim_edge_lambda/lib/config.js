'use strict';

// ==============================================================================
// Environment Configuration
// ==============================================================================
//
// Edge Lambdaで使う環境変数を読み取る補助関数。
// 必須値を読み忘れたままAWSへ接続すると原因が分かりづらくなるため、
// 起動直後に明確なエラーへ変換する。

function readOptionalString(env, name, fallback = '') {
  return String(env[name] || fallback).trim();
}

function readRequiredString(env, name) {
  const value = readOptionalString(env, name);

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function readPositiveInteger(env, name, fallback) {
  const value = Number(env[name] || fallback);

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function getEdgeConfig(env = process.env) {
  return {
    awsRegion: readOptionalString(env, 'AWS_REGION', 'ap-northeast-1'),

    // Core Lambdaへユーザー入力を渡すFIFO Request Queue。
    requestQueueUrl: readRequiredString(env, 'REQUEST_QUEUE_URL'),

    // WebSocket connectionIdとCognito subの対応を保存するDynamoDBテーブル。
    connectionTableName: readRequiredString(env, 'CONNECTION_TABLE_NAME'),

    // Response QueueのSQSイベントにはAPI GatewayのdomainName/stageが入らないため、
    // WebSocketへpostするためのManagement API endpointを環境変数で持つ。
    // 例: https://abc123.execute-api.ap-northeast-1.amazonaws.com/dev
    websocketApiEndpoint: readRequiredString(env, 'WEBSOCKET_API_ENDPOINT'),

    // 接続管理テーブルのTTL秒数。切断イベントが取りこぼされた場合の掃除用。
    connectionTtlSeconds: readPositiveInteger(env, 'CONNECTION_TTL_SECONDS', 86400),
  };
}

module.exports = {
  getEdgeConfig,
  readOptionalString,
  readRequiredString,
  readPositiveInteger,
};
