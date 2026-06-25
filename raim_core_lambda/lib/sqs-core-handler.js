'use strict';

// ==============================================================================
// SQS Request Queue Handler
// ==============================================================================
//
// Request Queueから受け取ったメッセージをCore Chat Serviceへ渡し、Mantleの回答を
// Response Queueへストリーミングする、キュー駆動部分のオーケストレーター。
//
// CloudFormationではBatchSize=1にするが、コード側も複数recordを安全に扱い、
// 失敗したmessageIdだけをbatchItemFailuresで返す。これにより、将来BatchSizeを
// 変更しても成功済みメッセージまで再処理されにくい。
// ==============================================================================

const { handleCoreChat } = require('./core-chat-service');
const { normalizeCoreEvent } = require('./core-event');
const {
  claimRequest,
  markRequestCompleted,
  markRequestFailed,
} = require('./request-state-store');
const { createResponseQueuePublisher } = require('./response-queue-publisher');
const { StreamingChatJsonExtractor } = require('./streaming-chat-json-extractor');

function isSqsEvent(event) {
  return Array.isArray(event?.Records) &&
    event.Records.every((record) => record?.eventSource === 'aws:sqs');
}

function createSqsCoreHandler(dependencyOverrides = {}) {
  const dependencies = {
    handleCoreChat,
    normalizeCoreEvent,
    claimRequest,
    markRequestCompleted,
    markRequestFailed,
    createResponseQueuePublisher,
    ...dependencyOverrides,
  };

  async function processRecord(record, context) {
    // SQS record bodyをCore標準入力へ変換する。
    // messageIdはクライアントrequestId欠落時の追跡用fallbackとして使う。
    const input = dependencies.normalizeCoreEvent({ Records: [record] }, {
      fallbackRequestId: record.messageId,
    });

    // Response Queueを受け取るEdge LambdaがWebSocketへ返送するために必須。
    if (!input.connectionId) {
      throw new Error('connectionId is required for Request Queue messages');
    }

    const ownerId = context?.awsRequestId || `local-${record.messageId}`;
    const claim = await dependencies.claimRequest({
      sub: input.sub,
      requestId: input.requestId,
      connectionId: input.connectionId,
      ownerId,
    });

    // COMPLETEDまたは有効leaseを持つPROCESSINGは重複配信なので何もしない。
    if (!claim.claimed) {
      return { duplicate: true, status: claim.status };
    }

    const attempt = Number(record.attributes?.ApproximateReceiveCount || 1);
    let publisher;
    let terminalEventPublished = false;

    try {
      publisher = dependencies.createResponseQueuePublisher({
        requestId: input.requestId,
        connectionId: input.connectionId,
        sub: input.sub,
        source: input.source,
        attempt,
      });
      const extractor = new StreamingChatJsonExtractor({
        onText: (text) => publisher.appendText(text),
      });

      await publisher.start();

      // Mantleのraw JSON deltaからtext値だけを抽出し、Response Queueへ順次送る。
      const result = await dependencies.handleCoreChat(input, {
        fallbackRequestId: record.messageId,
        onMantleTextDelta: (delta) => extractor.push(delta),
      });

      if (result.ok) {
        await publisher.completed(result);
      } else {
        await publisher.error(result);
      }
      terminalEventPublished = true;

      // 最終イベント送信後にCOMPLETEDを記録する。
      // Edge側はrequestId/sequenceで万一の重複を除去する。
      await dependencies.markRequestCompleted({
        requestKey: claim.requestKey,
        ownerId,
        details: {
          ok: result.ok,
          code: result.code || '',
        },
      });

      return result;
    } catch (error) {
      // 可能ならクライアントへ失敗を通知する。ただし通知自体の失敗で元例外を失わない。
      if (publisher && !terminalEventPublished) {
        try {
          await publisher.error({
            code: error.coreErrorCode || 'INTERNAL_ERROR',
            message: 'Core Lambda processing failed',
            retriable: error.retriable !== false,
          });
        } catch (publishError) {
          console.error('Failed to publish stream.error:', publishError);
        }
      }

      try {
        await dependencies.markRequestFailed({
          requestKey: claim.requestKey,
          ownerId,
          details: {
            errorName: error.name,
            errorCode: error.code || '',
          },
        });
      } catch (stateError) {
        console.error('Failed to mark request as FAILED:', stateError);
      }

      throw error;
    }
  }

  return async function handleSqsBatch(event, context) {
    const batchItemFailures = [];
    const failedMessageGroups = new Set();

    // FIFO Queueでは順番を崩さないよう、recordを並列ではなく受信順に処理する。
    for (const record of event.Records || []) {
      const messageGroupId = record.attributes?.MessageGroupId || '';

      // 同じFIFO MessageGroup内で前のrecordが失敗した場合、後続を先に処理しない。
      // 未処理recordもfailureとして返し、次回同じ順序で再配信させる。
      if (messageGroupId && failedMessageGroups.has(messageGroupId)) {
        batchItemFailures.push({ itemIdentifier: record.messageId });
        continue;
      }

      try {
        await processRecord(record, context);
      } catch (error) {
        console.error(`Failed to process SQS record ${record.messageId}:`, error);
        batchItemFailures.push({ itemIdentifier: record.messageId });

        if (messageGroupId) {
          failedMessageGroups.add(messageGroupId);
        }
      }
    }

    return { batchItemFailures };
  };
}

const handleSqsBatch = createSqsCoreHandler();

module.exports = {
  createSqsCoreHandler,
  handleSqsBatch,
  isSqsEvent,
};
