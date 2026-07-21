'use strict';

// ==============================================================================
// Client Message Mapper
// ==============================================================================
//
// Core LambdaからResponse Queueへ流れてくる内部イベントを、
// Flutter/Unityクライアントへ送りやすいWebSocketメッセージへ変換する。
//
// Core Lambda / Response Queue側の内部イベント:
//   stream.start
//   stream.delta
//   stream.bubble_break
//   stream.tool
//   stream.completed
//   stream.error
//
// stream.audio はTTS連携時に追加される将来イベントとして、下記の変換処理だけ
// 先に用意している。現在のCore Lambdaはstream.audioを送信しない。
//
// クライアントへ送る外部イベント:
//   metadata   : ストリーミング表示の開始と感情メタ情報
//   text_chunk : 画面へ追記する本文断片
//   audio_chunk: TTS音声Base64の分割パーツ
//   bubble_break: 表示上の吹き出し区切り
//   tool_call  : ツール実行中であることを示すローディング用イベント
//   chat_end   : 最終本文と最終感情
//   error      : エラー通知
//
// 変換境界をEdge Lambdaに置くことで、Core Lambdaの内部プロトコルを保ったまま、
// Flutter/Unity側のクライアント統合仕様へ合わせる。

const DEFAULT_EMOTION = 'neutral';
const DEFAULT_INTENSITY = 0.5;
const ERROR_EMOTION = 'sad';
const ALL_EMOTIONS = Object.freeze([
  'neutral',
  'happy',
  'sad',
  'angry',
  'surprised',
  'caring',
  'embarrassed',
  'excited',
  'curious',
  'amused',
  'thoughtful',
  'playful',
]);

function toFiniteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);

    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function clamp01(value, fallback = DEFAULT_INTENSITY) {
  const number = toFiniteNumber(value);

  if (number === null) {
    return fallback;
  }

  return Math.max(0, Math.min(1, number));
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function normalizeEmotionName(value, fallback = DEFAULT_EMOTION) {
  const emotion = String(value || '').trim();

  if (!emotion) {
    return fallback;
  }

  return ALL_EMOTIONS.includes(emotion)
    ? emotion
    : fallback;
}

function normalizeEmotionMap(emotions, fallbackEmotion) {
  if (!emotions || typeof emotions !== 'object' || Array.isArray(emotions)) {
    return {
      [normalizeEmotionName(fallbackEmotion)]: 1.0,
    };
  }

  const entries = Object.entries(emotions)
    .map(([emotion, value]) => {
      const number = toFiniteNumber(value);

      return [
        normalizeEmotionName(emotion, ''),
        number === null ? 0 : clamp01(number, 0),
      ];
    })
    .filter(([emotion, value]) => emotion && value > 0);

  if (entries.length === 0) {
    return {
      [normalizeEmotionName(fallbackEmotion)]: 1.0,
    };
  }

  const total = entries.reduce((sum, [, value]) => sum + value, 0);

  if (total <= 0) {
    return {
      [normalizeEmotionName(fallbackEmotion)]: 1.0,
    };
  }

  return Object.fromEntries(
    entries.map(([emotion, value]) => [emotion, round3(value / total)])
  );
}

function pickPrimaryEmotion(emotions, fallbackEmotion = DEFAULT_EMOTION) {
  let primaryEmotion = normalizeEmotionName(fallbackEmotion);
  let primaryValue = -Infinity;

  for (const [emotion, value] of Object.entries(emotions || {})) {
    const number = toFiniteNumber(value);

    if (number !== null && number > primaryValue) {
      primaryEmotion = emotion;
      primaryValue = number;
    }
  }

  return primaryEmotion;
}

function createEmotionPayload(coreEvent, {
  fallbackEmotion = DEFAULT_EMOTION,
  fallbackIntensity = DEFAULT_INTENSITY,
} = {}) {
  const eventEmotion = normalizeEmotionName(coreEvent.emotion, fallbackEmotion);
  const eventIntensity = clamp01(coreEvent.intensity, fallbackIntensity);
  const emotions = normalizeEmotionMap(coreEvent.emotions, eventEmotion);
  const overallIntensity = clamp01(
    coreEvent.overall_intensity,
    eventIntensity
  );
  const primaryEmotion = pickPrimaryEmotion(emotions, eventEmotion);
  const primaryIntensity = clamp01(
    emotions[primaryEmotion] * overallIntensity,
    eventIntensity
  );

  return {
    emotions,
    overall_intensity: overallIntensity,
    emotion: primaryEmotion,
    intensity: round3(primaryIntensity),
  };
}

function createChunkId(coreEvent) {
  const requestId = String(coreEvent.requestId || 'request');
  const sequence = Number.isInteger(coreEvent.sequence)
    ? coreEvent.sequence
    : 0;

  return `${requestId}_chunk_${sequence}`;
}

function resolveChunkId(coreEvent) {
  const provided = String(coreEvent.chunkId || '').trim();

  if (provided) {
    return provided;
  }

  return createChunkId(coreEvent);
}

function createNonRetriableError(message) {
  const error = new Error(message);
  error.retriable = false;

  return error;
}

function createAudioChunkMessage(coreEvent, base) {
  const chunkId = String(coreEvent.chunkId || '').trim();
  const format = String(coreEvent.format || 'wav').trim();
  const audio = String(coreEvent.audio || '');
  const partIndex = Number(coreEvent.partIndex ?? 0);
  const partCount = Number(coreEvent.partCount ?? 1);

  if (!chunkId) {
    throw createNonRetriableError('stream.audio is missing chunkId');
  }

  if (!format) {
    throw createNonRetriableError('stream.audio is missing format');
  }

  if (!audio) {
    throw createNonRetriableError('stream.audio is missing audio');
  }

  if (
    !Number.isInteger(partIndex) ||
    !Number.isInteger(partCount) ||
    partIndex < 0 ||
    partCount < 1 ||
    partIndex >= partCount
  ) {
    throw createNonRetriableError('stream.audio has invalid multipart metadata');
  }

  return {
    ...base,
    type: 'audio_chunk',
    chunk_id: chunkId,
    format,
    part_index: partIndex,
    part_count: partCount,
    is_first: partIndex === 0,
    is_last: partIndex === partCount - 1,
    audio,
  };
}

function createToolCallMessage(coreEvent, base) {
  const tool = String(coreEvent.tool || '').trim();
  const description = String(coreEvent.description || '').trim();
  const estimatedSeconds = toFiniteNumber(
    coreEvent.estimatedSeconds ?? coreEvent.estimated_seconds
  );

  return {
    ...base,
    type: 'tool_call',
    tool,
    description,
    estimated_seconds: estimatedSeconds === null
      ? 3
      : Math.max(0, estimatedSeconds),
  };
}

function toClientMessage(coreEvent) {
  const base = {
    type: coreEvent.type,
    requestId: coreEvent.requestId,
    sequence: coreEvent.sequence,
  };

  switch (coreEvent.type) {
    case 'stream.start':
      return {
        ...base,
        type: 'metadata',
        ...createEmotionPayload(coreEvent),
      };

    case 'stream.delta':
      return {
        ...base,
        type: 'text_chunk',
        text: String(coreEvent.textDelta || ''),
        chunk_id: resolveChunkId(coreEvent),
        is_first: Boolean(coreEvent.isFirst ?? coreEvent.sequence === 1),
        // CoreからisFiller/is_fillerが届いても、現在のクライアント仕様では使用しない。
        // 待機メッセージと通常本文の区別は、tool_callやbubble_breakで表現する。
      };

    // ツール intro の後に届く区切り。
    // クライアントは現在の吹き出しを確定し、次の text_chunk を新しい吹き出しにする。
    case 'stream.bubble_break':
      return {
        ...base,
        type: 'bubble_break',
      };

    case 'stream.audio':
      return createAudioChunkMessage(coreEvent, base);

    case 'stream.bubble_break':
      return {
        ...base,
        type: 'bubble_break',
      };

    case 'stream.tool':
      return createToolCallMessage(coreEvent, base);

    case 'stream.completed':
      return {
        ...base,
        type: 'chat_end',
        full_text: String(coreEvent.text || ''),
        ...createEmotionPayload(coreEvent),
      };

    case 'stream.error': {
      const message = String(coreEvent.message || 'Internal server error');

      return {
        ...base,
        type: 'error',
        code: String(coreEvent.code || 'INTERNAL_ERROR'),
        message,
        text: message,
        ...createEmotionPayload(coreEvent, {
          fallbackEmotion: ERROR_EMOTION,
          fallbackIntensity: DEFAULT_INTENSITY,
        }),
        retriable: Boolean(coreEvent.retriable),
      };
    }

    default:
      return {
        ...base,
        payload: coreEvent,
      };
  }
}

module.exports = {
  createAudioChunkMessage,
  createToolCallMessage,
  createEmotionPayload,
  createNonRetriableError,
  resolveChunkId,
  toClientMessage,
};
