'use strict';

// ==============================================================================
// Response Queue Stream Publisher
// ==============================================================================
//
// Mantleから受信した回答を、Edge LambdaがWebSocketへ中継できる小さなイベントへ
// 変換し、Response Queueへ送信する。
//
// Response QueueはFIFOを前提とする。sequenceを付けるだけでなく、SQS側でも
// MessageGroupId=requestIdとして順序を保証する。Edge LambdaはrequestIdとsequenceを
// 使って重複排除・欠落検知を行える。
//
// 送信イベント:
// - stream.start     : Mantle処理開始
// - stream.delta     : ユーザーに表示する回答本文の差分
// - stream.completed : 最終text/emotion/intensity
// - stream.error     : 入力不正または処理失敗
// ==============================================================================

const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const crypto = require('crypto');

const RESPONSE_SCHEMA_VERSION = 1;

function requiredEnvironmentValue(env, name) {
  const value = String(env[name] || '').trim();

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function createResponseQueuePublisher({
  requestId,
  connectionId,
  sub,
  source,
  attempt = 1,
}, {
  client,
  env = process.env,
} = {}) {
  const queueUrl = requiredEnvironmentValue(env, 'RESPONSE_QUEUE_URL');
  const sqsClient = client || new SQSClient({
    region: env.AWS_REGION || 'ap-northeast-1',
  });
  const minimumChunkCharacters = Math.max(
    1,
    Number(env.STREAM_CHUNK_MIN_CHARACTERS || 12)
  );
  let sequence = 0;
  let textBuffer = '';
  const messageGroupId = requestId.length <= 128
    ? requestId
    : crypto.createHash('sha256').update(requestId).digest('hex');

  /**
   * 共通envelopeを作り、FIFO Response Queueへ1イベント送信する。
   */
  async function send(type, payload = {}) {
    const currentSequence = sequence;
    sequence += 1;
    const message = {
      schemaVersion: RESPONSE_SCHEMA_VERSION,
      type,
      requestId,
      connectionId,
      sub,
      source,
      sequence: currentSequence,
      attempt,
      createdAt: new Date().toISOString(),
      ...payload,
    };

    const deduplicationId = crypto
      .createHash('sha256')
      .update(`${requestId}:${attempt}:${currentSequence}:${type}`)
      .digest('hex');

    await sqsClient.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
      MessageGroupId: messageGroupId,
      MessageDeduplicationId: deduplicationId,
    }));

    return message;
  }

  async function flushText() {
    if (!textBuffer) {
      return null;
    }

    const textDelta = textBuffer;
    textBuffer = '';
    return send('stream.delta', { textDelta });
  }

  return {
    start() {
      return send('stream.start');
    },

    /**
     * token単位でSQS SendMessageを呼ぶとメッセージ数が増えすぎるため、
     * 一定文字数までまとめてからdeltaとして送る。
     */
    async appendText(text) {
      textBuffer += String(text || '');

      if (textBuffer.length >= minimumChunkCharacters) {
        return flushText();
      }

      return null;
    },

    flushText,

    async completed(result) {
      await flushText();
      return send('stream.completed', {
        text: result.text,
        emotion: result.emotion,
        intensity: result.intensity,
      });
    },

    async error(result) {
      await flushText();
      return send('stream.error', {
        code: result.code || 'INTERNAL_ERROR',
        message: result.message || 'Internal server error',
        retriable: Boolean(result.retriable),
      });
    },
  };
}

module.exports = {
  RESPONSE_SCHEMA_VERSION,
  createResponseQueuePublisher,
};
