'use strict';

// ==============================================================================
// Core Response Queue Handler
// ==============================================================================
//
// Core LambdaはMantleの生成状況をResponse Queueへ送る。
// Edge LambdaはそのSQSイベントを受け取り、connectionId宛にWebSocket postする。
//
// SQS batchの一部だけ失敗した場合は、Lambdaのpartial batch response形式で
// `batchItemFailures` に失敗messageIdだけを返す。
// これにより成功済みメッセージの再配信を避けられる。

const { createConnectionStore } = require('./connection-store');
const { createWebSocketPostback } = require('./websocket-postback');
const { toClientMessage } = require('./client-message');

function parseRecordBody(record) {
  try {
    return JSON.parse(record.body);
  } catch (error) {
    const parseError = new Error('Response Queue message body must be valid JSON');
    parseError.cause = error;
    parseError.retriable = false;
    throw parseError;
  }
}

function createResponseQueueHandler({
  connectionStore,
  postback,
  logger = console,
} = {}) {
  const getConnectionStore = () => connectionStore || createConnectionStore();
  const getPostback = () => postback || createWebSocketPostback();

  async function handleRecord(record) {
    const coreEvent = parseRecordBody(record);
    const connectionId = String(coreEvent.connectionId || '').trim();

    if (!connectionId) {
      const error = new Error('Response Queue message is missing connectionId');
      error.retriable = false;
      throw error;
    }

    const clientMessage = toClientMessage(coreEvent);
    const result = await getPostback().postJson(connectionId, clientMessage);

    if (result.gone) {
      // クライアントが既に切断済みの場合、再試行しても成功しない。
      // SQSメッセージは成功扱いにし、接続管理テーブルだけ掃除する。
      await getConnectionStore().deleteConnection(connectionId);
    }
  }

  return async function handleResponseQueueEvent(event) {
    const failures = [];

    for (const record of event.Records || []) {
      try {
        await handleRecord(record);
      } catch (error) {
        logger.error('Failed to process response queue record', {
          messageId: record.messageId,
          name: error.name,
          message: error.message,
          retriable: error.retriable,
        });

        // JSON不正やconnectionId欠落は再試行しても直らないため成功扱いにする。
        // 一時的なWebSocket/API障害などは再試行対象にする。
        if (error.retriable !== false) {
          failures.push({
            itemIdentifier: record.messageId,
          });
        }
      }
    }

    return {
      batchItemFailures: failures,
    };
  };
}

function handleResponseQueueEvent(event) {
  return createResponseQueueHandler()(event);
}

module.exports = {
  createResponseQueueHandler,
  handleResponseQueueEvent,
  parseRecordBody,
};
