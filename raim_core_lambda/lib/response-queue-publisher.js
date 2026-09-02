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
// - stream.delta     : ユーザーに表示する回答本文の文・チャンク
// - stream.audio     : 文・チャンクに対応するBase64 WAV音声
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
  ttsClient = null,
  getVoiceParams = () => null,
} = {}) {
  const queueUrl = requiredEnvironmentValue(env, 'RESPONSE_QUEUE_URL');
  const sqsClient = client || new SQSClient({
    region: env.AWS_REGION || 'ap-northeast-1',
  });
  const minimumChunkCharacters = Math.max(
    1,
    Number(env.STREAM_CHUNK_MIN_CHARACTERS || 12)
  );
  const maximumChunkCharacters = Math.max(
    minimumChunkCharacters,
    Number(env.STREAM_CHUNK_MAX_CHARACTERS || 30)
  );
  const audioFragmentBase64Characters = Math.max(
    4,
    Number(env.TTS_AUDIO_FRAGMENT_BASE64_CHARACTERS || 24000)
  );
  let sequence = 0;
  let textChunkIndex = 0;
  let textBuffer = '';
  let audioDeliveryChain = Promise.resolve();
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

  function nextChunkId() {
    const chunkId = `${requestId}_chunk_${textChunkIndex}`;
    textChunkIndex += 1;
    return chunkId;
  }

  function findSentenceEnd(value) {
    return value.search(/[。！？!?、,\n]/);
  }

  function takeNextTextChunk(force = false) {
    if (!textBuffer) {
      return null;
    }

    const sentenceEnd = findSentenceEnd(textBuffer);
    const sentenceLength = sentenceEnd >= 0 ? sentenceEnd + 1 : 0;

    if (sentenceLength > 0 && sentenceLength <= maximumChunkCharacters) {
      const chunk = textBuffer.slice(0, sentenceLength);
      textBuffer = textBuffer.slice(sentenceLength);
      return chunk;
    }

    if (textBuffer.length >= maximumChunkCharacters) {
      const chunk = textBuffer.slice(0, maximumChunkCharacters);
      textBuffer = textBuffer.slice(maximumChunkCharacters);
      return chunk;
    }

    if (force || (sentenceEnd < 0 && textBuffer.length >= minimumChunkCharacters)) {
      const chunk = textBuffer;
      textBuffer = '';
      return chunk;
    }

    return null;
  }

  function enqueueAudio({ chunkId, text }) {
    if (!ttsClient || !text.trim()) {
      return;
    }

    const ttsPromise = Promise.resolve()
      .then(() => ttsClient.synthesize({
        requestId,
        chunkId,
        text,
        voiceParams: getVoiceParams() || undefined,
      }))
      .catch((error) => ({ error }));

    // 合成はenqueue時点で並列開始し、送信だけをenqueue順に直列化する。
    audioDeliveryChain = audioDeliveryChain.then(async () => {
      const result = await ttsPromise;

      if (result?.error || result?.ok === false) {
        const error = result.error || new Error(result.message || 'TTS failed');
        console.warn('TTS failed; continuing text stream:', {
          requestId,
          chunkId,
          code: error.code,
          message: error.message,
        });
        return;
      }

      const audio = String(result.audio || '');

      if (!audio) {
        return;
      }

      const parts = [];
      for (let offset = 0; offset < audio.length; offset += audioFragmentBase64Characters) {
        parts.push(audio.slice(offset, offset + audioFragmentBase64Characters));
      }

      for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
        await send('stream.audio', {
          chunkId,
          format: result.format || 'wav',
          contentType: result.contentType || 'audio/wav',
          audio: parts[partIndex],
          audioByteLength: result.audioByteLength,
          partIndex,
          partCount: parts.length,
          isLast: partIndex === parts.length - 1,
        });
      }
    }).catch((error) => {
      // 音声送信エラーでCore全体を再実行しない。テキストは既に送信済み。
      console.warn('TTS audio event publish failed; continuing text stream:', {
        requestId,
        message: error.message,
      });
    });
  }

  async function publishTextChunk(text) {
    const chunkId = nextChunkId();
    await send('stream.delta', { textDelta: text, chunkId });
    enqueueAudio({ chunkId, text });
  }

  async function flushText(force = true) {
    let lastMessage = null;
    let chunk;

    while ((chunk = takeNextTextChunk(force)) !== null) {
      lastMessage = await publishTextChunk(chunk);
      force = false;
    }

    return lastMessage;
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
      return flushText(false);
    },

    flushText: () => flushText(true),

    async drainAudio() {
      await audioDeliveryChain;
    },

    async completed(result) {
      await flushText(true);
      await audioDeliveryChain;
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
