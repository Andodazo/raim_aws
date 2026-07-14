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
//   stream.completed
//   stream.error
//
// クライアントへ送る外部イベント:
//   metadata   : ストリーミング表示の開始と感情メタ情報
//   text_chunk : 画面へ追記する本文断片
//   chat_end   : 最終本文と最終感情
//   error      : エラー通知
//
// 変換境界をEdge Lambdaに置くことで、Core Lambdaの内部プロトコルを保ったまま、
// Flutter/Unity側のクライアント統合仕様へ合わせる。

const DEFAULT_EMOTION = 'neutral';
const DEFAULT_INTENSITY = 0.5;
const ERROR_EMOTION = 'sad';

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

function normalizeEmotionName(value, fallback = DEFAULT_EMOTION) {
  const emotion = String(value || '').trim();

  return emotion || fallback;
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
        number === null ? 0 : number,
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
    entries.map(([emotion, value]) => [emotion, value / total])
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
    intensity: primaryIntensity,
  };
}

function createChunkId(coreEvent) {
  const requestId = String(coreEvent.requestId || 'request');
  const sequence = Number.isInteger(coreEvent.sequence)
    ? coreEvent.sequence
    : 0;

  return `${requestId}_chunk_${sequence}`;
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
        chunk_id: createChunkId(coreEvent),
        is_first: coreEvent.sequence === 1,
        is_filler: false,
      };

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
  createEmotionPayload,
  toClientMessage,
};
