'use strict';

// ==============================================================================
// Core Request Queue Publisher
// ==============================================================================
//
// Edge LambdaはCore Lambdaを直接invokeしない。
// ユーザー入力をSQS Request Queueへ入れ、Core LambdaはそのQueueをEvent Source Mappingで読む。
//
// こうすることで、Mantleのストリーミング生成が長くなってもWebSocket入口のLambdaを
// 長時間待たせずに済み、Core側の再試行・冪等性管理も行いやすくなる。

const crypto = require('crypto');
const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const { getEdgeConfig } = require('./config');

const REQUEST_SCHEMA_VERSION = 1;

function hashForFifo(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function createRequestQueuePublisher({ client, env = process.env } = {}) {
  const config = getEdgeConfig(env);
  const sqs = client || new SQSClient({ region: config.awsRegion });

  async function publishChatRequest({
    requestId,
    connectionId,
    sub,
    text,
    images = [],
  }) {
    const message = {
      schemaVersion: REQUEST_SCHEMA_VERSION,
      type: 'chat.request',
      requestId,
      connectionId,
      sub,
      source: 'websocket',
      text,
      images,
      createdAt: new Date().toISOString(),
    };

    // FIFO QueueではMessageGroupId単位で順序が保証される。
    // 同じ接続からの入力は順番にCoreへ渡したいため、connectionIdをgroupに使う。
    const messageGroupId = connectionId.length <= 128
      ? connectionId
      : hashForFifo(connectionId);

    // 同じrequestIdの再送は重複扱いにしたい。
    const deduplicationId = requestId.length <= 128
      ? requestId
      : hashForFifo(requestId);

    await sqs.send(new SendMessageCommand({
      QueueUrl: config.requestQueueUrl,
      MessageBody: JSON.stringify(message),
      MessageGroupId: messageGroupId,
      MessageDeduplicationId: deduplicationId,
    }));

    return message;
  }

  return {
    publishChatRequest,
  };
}

module.exports = {
  REQUEST_SCHEMA_VERSION,
  createRequestQueuePublisher,
};
