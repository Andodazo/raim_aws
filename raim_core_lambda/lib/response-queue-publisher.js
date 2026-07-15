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
  // v14: tool intro を送ったら true。本文の最初のdeltaで bubble_break を発火して false に戻す。
  let bubbleBreakPending = false;
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

    // v14: tool intro を送っていた場合、本文の最初のdeltaを送る直前に
    // bubble_breakを1回だけ挟む。これでFlutterがintroと本文を別吹き出しに分ける。
    await maybeSendBubbleBreak();

    const textDelta = textBuffer;
    textBuffer = '';
    return send('stream.delta', { textDelta });
  }

  // v14: tool intro 送信後にtrueになり、本文開始時にfalseへ戻る。
  async function maybeSendBubbleBreak() {
    if (!bubbleBreakPending) {
      return null;
    }
    bubbleBreakPending = false;
    return send('stream.bubble_break');
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
      // v14: 本文がdeltaで一度も流れなかった場合（全文がcompletedのtextに乗る等）でも、
      // introの後に区切りを入れる。flushTextで既に発火済みならここは何もしない。
      await maybeSendBubbleBreak();
      return send('stream.completed', {
        text: result.text,
        // v13: Unity BlendShape 用の比率Mapと全体強度。
        // 重み = emotions[key] × overall_intensity
        emotions: result.emotions,
        overall_intensity: result.overall_intensity,
        // 後方互換: 旧Flutter/Unity実装はこの2つだけ見ていても動く。
        emotion: result.emotion,
        intensity: result.intensity,
      });
    },

    // ─────────────────────────────────────────────
    // ツール呼出の通知
    // ─────────────────────────────────────────────
    //
    // Gemmaはツール呼出時に本文を返せないため、
    // 「調べるね」に相当する発話はサーバー側の固定セリフを送る。
    //
    //   1. stream.delta   前置きセリフ（ライムの発話としてUIに出す）
    //   2. stream.tool    ツール実行中であることの通知（UIのローディング表示用）
    //
    // 前置きセリフを通常のtextとして流すことで、
    // クライアントは特別な処理をしなくても発話として表示できる。
    async toolCall({ toolName, description, introText, estimatedSeconds = 3 }) {
      if (introText) {
        // バッファを経由せず即時に送る。ツール実行の待ち時間より先に届かせたい。
        await flushText();
        await send('stream.delta', {
          textDelta: introText,
          isFiller: true,
        });
        // v14: introを送ったので、本文開始時にbubble_breakを挟む。
        bubbleBreakPending = true;
      }

      return send('stream.tool', {
        tool: toolName,
        description,
        estimatedSeconds,
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
