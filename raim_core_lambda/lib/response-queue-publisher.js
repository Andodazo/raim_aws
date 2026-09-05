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
  // TTS の再試行回数。0 にすると再試行しない。
  const audioRetryCount = Math.max(0, Number(env.TTS_RETRY_COUNT ?? 1));

  // Base64 を文字数で切るため、4の倍数でないと各パートが単独でデコードできない。
  // クライアントはパートごとに base64Decode するので、端数があると
  // FormatException になり音声が無言で消える。ここで必ず丸める。
  const audioFragmentBase64Characters = Math.max(
    4,
    Math.floor(Number(env.TTS_AUDIO_FRAGMENT_BASE64_CHARACTERS || 24000) / 4) * 4
  );
  let sequence = 0;
  let textChunkIndex = 0;
  let textBuffer = '';
  let audioDeliveryChain = Promise.resolve();
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

  /**
   * TTS を1回呼ぶ。
   */
  function synthesizeOnce(chunkId, text) {
    return Promise.resolve()
      .then(() => ttsClient.synthesize({
        requestId,
        chunkId,
        text,
        voiceParams: getVoiceParams() || undefined,
      }))
      .catch((error) => ({ error }));
  }

  /**
   * 失敗が再試行可能なら、もう1度だけ合成し直す。
   *
   * TTS Lambda は is_retriable() で AUDIO_QUERY_FAILED / SYNTHESIS_FAILED /
   * MODEL_LOAD_FAILED を retriable として返し、tts-client も
   * error.retriable に載せて渡している。にもかかわらず呼び出し側が
   * 見ずに捨てていたため、1文まるごと無音になることがあった。
   */
  async function synthesizeWithRetry(chunkId, text) {
    const first = await synthesizeOnce(chunkId, text);

    if (!isTtsFailure(first)) {
      return first;
    }

    const error = first.error || {};

    if (!error.retriable || audioRetryCount <= 0) {
      return first;
    }

    console.warn('TTS failed; retrying once:', {
      requestId,
      chunkId,
      code: error.code,
    });

    const second = await synthesizeOnce(chunkId, text);

    if (!isTtsFailure(second)) {
      console.log(`[TTS] retry succeeded: chunkId=${chunkId}`);
    }

    return second;
  }

  function isTtsFailure(result) {
    return Boolean(result?.error) || result?.ok === false;
  }

  function enqueueAudio({ chunkId, text }) {
    if (!ttsClient || !text.trim()) {
      return;
    }

    const ttsPromise = synthesizeWithRetry(chunkId, text);

    // 合成はenqueue時点で並列開始し、送信だけをenqueue順に直列化する。
    audioDeliveryChain = audioDeliveryChain.then(async () => {
      const result = await ttsPromise;

      if (isTtsFailure(result)) {
        const error = result.error || new Error(result.message || 'TTS failed');
        console.warn('TTS failed; continuing text stream:', {
          requestId,
          chunkId,
          code: error.code,
          message: error.message,
          // 何を喋らせようとして失敗したかを追えるようにする。
          // 本文そのものは残さず、長さと先頭1文字だけにする。
          textLength: text.length,
          textHead: text.slice(0, 1),
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
      // ツールの前置きセリフと本文を別吹き出しにする。
      await maybeSendBubbleBreak();
      lastMessage = await publishTextChunk(chunk);
      force = false;
    }

    return lastMessage;
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
      // threadId はこの時点では未確定（resolveThread は handleCoreChat の中で走る）。
      // クライアントへは stream.completed で返す。
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
      // 本文がdeltaで一度も流れなかった場合でも、introの後に区切りを入れる。
      await maybeSendBubbleBreak();
      await audioDeliveryChain;
      return send('stream.completed', {
        text: result.text,
        // 会話スレッドの識別子。クライアントはこれを保持し、次回の送信で送り返す。
        // 新規作成された場合も採番結果がここで分かる。
        threadId: result.threadId || '',
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
    async toolCall({ toolName, description, introText }) {
      if (introText) {
        // バッファを経由せず即時に送る。ツール実行の待ち時間より先に届かせたい。
        await flushText();

        // 前置きも本文と同じように chunkId を採番して TTS に回す。
        // 以前は send するだけで enqueueAudio を呼んでおらず、
        // 「調べるね」に相当するセリフだけ音声が鳴らなかった。
        // 待ち時間を埋めるための発話なので、ここが無音だと役割を果たさない。
        const chunkId = nextChunkId();

        await send('stream.delta', {
          textDelta: introText,
          chunkId,
          isFiller: true,
        });
        enqueueAudio({ chunkId, text: introText });

        // v14: introを送ったので、本文開始時にbubble_breakを挟む。
        bubbleBreakPending = true;
      }

      return send('stream.tool', {
        tool: toolName,
        description,
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
