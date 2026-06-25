'use strict';

// ==============================================================================
// WebSocket Connection Store
// ==============================================================================
//
// API Gateway WebSocketのconnectionIdは、接続中のクライアントへ返信するための宛先。
// `$connect` で保存し、`$disconnect` で削除する。
//
// Response Queueから来るメッセージにはconnectionIdが含まれるが、
// GoneExceptionが起きた時に接続情報を掃除できるよう、このStoreに処理を集約する。

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
} = require('@aws-sdk/lib-dynamodb');
const { getEdgeConfig } = require('./config');

function createConnectionStore({ client, env = process.env } = {}) {
  const config = getEdgeConfig(env);
  const ddb = client || DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: config.awsRegion })
  );

  async function putConnection({ connectionId, sub, domainName, stage }) {
    const now = new Date().toISOString();
    const expiresAt = Math.floor(Date.now() / 1000) + config.connectionTtlSeconds;

    await ddb.send(new PutCommand({
      TableName: config.connectionTableName,
      Item: {
        connectionId,
        sub,
        domainName,
        stage,
        connectedAt: now,
        updatedAt: now,
        expiresAt,
      },
    }));
  }

  async function deleteConnection(connectionId) {
    if (!connectionId) {
      return;
    }

    await ddb.send(new DeleteCommand({
      TableName: config.connectionTableName,
      Key: { connectionId },
    }));
  }

  async function getConnection(connectionId) {
    if (!connectionId) {
      return null;
    }

    const result = await ddb.send(new GetCommand({
      TableName: config.connectionTableName,
      Key: { connectionId },
    }));

    return result.Item || null;
  }

  return {
    getConnection,
    putConnection,
    deleteConnection,
  };
}

module.exports = {
  createConnectionStore,
};
