// lib/types.js
// ==============================================================================
// RAiM Core Lambda 用 JSON メッセージ定義・バリデーション
// ==============================================================================
//
// 【このファイルの役割】
// Edge Lambdaやキューから受け取る入力と、Core Lambdaが返す
// chat / error メッセージの基本形式を一元管理する。
//
// 現在の主な用途:
// - Core Lambdaへ渡される { text, images } の検証
// - Core Lambdaが返す chat / error JSON の作成
// - Bedrock / LLM が返したJSON文字列の正規化
//
// 【Core Lambdaで使う主な関数】
// - validateUpstream()
// - createChat()
// - createError()
// - normalizeLLMOutput()
// - clampIntensity()
//
// 【現時点では使わないもの】
// filler_audio / tool_call / proactive_message / session_start 関連の関数は、
// Edge Lambdaとの責務分離後に必要性を再検討するためコメントアウトして残している。
// 必要になったら MESSAGE_TYPES と exports も含めて復活させる。
//
// 【スキーマ仕様の正本】
// docs/json-schema.md, docs/multimodal-spec.md

'use strict';

// ─────────────────────────────────────────────
// スキーマバージョン（コード内のみ、JSON 出力には含めない）
// ─────────────────────────────────────────────
//
// 将来、破壊的変更が必要になった時に JSON 出力に含めるよう復活させる予定。
// その時は createXxx() 関数の戻り値オブジェクトに version: SCHEMA_VERSION を追加する。
const SCHEMA_VERSION = 1;

// ─────────────────────────────────────────────
// type 列挙
// ─────────────────────────────────────────────
//
// Core Lambdaでは chat / error を使用する。
// Edge側で扱う可能性があるtypeはコメントアウトして保持する。

const MESSAGE_TYPES = Object.freeze({
  CHAT: 'chat',
  ERROR: 'error',

  // 将来拡張・Edge Lambda向け
  // FILLER_AUDIO: 'filler_audio',
  // TOOL_CALL: 'tool_call',
  // PROACTIVE_MESSAGE: 'proactive_message',
  // SESSION_START: 'session_start',
});

// ─────────────────────────────────────────────
// emotion 列挙
// ─────────────────────────────────────────────
//
// Lambdaは text / emotion / intensity を返す。
// Flutter / Unity 側は emotion を見て表情制御に利用する。
// Unity側が未対応のemotionを受け取った場合は default / neutral にフォールバックする想定。

const EMOTIONS = Object.freeze({
  // 基本感情
  NEUTRAL: 'neutral',
  HAPPY: 'happy',
  SAD: 'sad',
  ANGRY: 'angry',
  SURPRISED: 'surprised',

  // 拡張感情
  CARING: 'caring',
  EMBARRASSED: 'embarrassed',
  EXCITED: 'excited',
});

// ─────────────────────────────────────────────
// error コード列挙
// ─────────────────────────────────────────────
//
// Lambda内で発生したエラーを、クライアントが扱いやすい形に分類する。
// 現時点では INVALID_INPUT / INTERNAL_ERROR を主に使用する。
// Bedrock Runtime / Embedding 実装で LLM_ERROR / EMBED_ERROR を使用する。

const ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // Bedrock Runtime / Embedding 呼び出し用
  LLM_TIMEOUT: 'LLM_TIMEOUT',
  LLM_ERROR: 'LLM_ERROR',
  EMBED_ERROR: 'EMBED_ERROR',

  // 将来拡張
  RATE_LIMIT: 'RATE_LIMIT',
  MAINTENANCE: 'MAINTENANCE',
});

// 将来のAction Group / 外部ツール通知用。
// 現時点のCore Lambdaでは未使用。
// const TOOLS = Object.freeze({
//   WEB_SEARCH: 'web_search',
// });

// ─────────────────────────────────────────────
// マルチモーダル制約値
// ─────────────────────────────────────────────
//
// images は、ユーザーが送信した画像をBedrock Runtimeへ渡すためのフィールド。
// 画像Embeddingや画像Scene選択には使用しない。
// Scene選択は text のEmbeddingのみで行う。
//
// Core Lambdaでは、Bedrock Runtimeへ渡す前に以下を検証する。
// - Base64文字列か
// - media_type が対応形式か
// - 画像枚数が上限以内か
// - 画像合計サイズが上限以内か
//
// textのみでも動作し、images は省略または空配列でもよい。

const SUPPORTED_IMAGE_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

// 全画像合計の上限（Base64化前のバイト数換算）
const MAX_TOTAL_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

// 1リクエストあたりの最大画像数
const MAX_IMAGES_PER_MESSAGE = 10;

// ─────────────────────────────────────────────
// ファクトリ関数
// ─────────────────────────────────────────────

/**
 * intensity を 0.0〜1.0 にクランプする。
 * NaN / undefined / number以外が来た場合は 0.5 を返す。
 */
function clampIntensity(v) {
  if (typeof v !== 'number' || isNaN(v)) return 0.5;
  return Math.max(0, Math.min(1, v));
}

/**
 * chat レスポンスを作成する。
 *
 * Core Lambdaの正常応答として、Edge Lambdaへ返す基本形式。
 * Flutter側は text をチャットUIに表示し、
 * emotion / intensity をUnity表情制御に利用する想定。
 */
function createChat({ text, emotion = EMOTIONS.NEUTRAL, intensity = 0.5 }) {
  return {
    type: MESSAGE_TYPES.CHAT,
    text: String(text || ''),
    emotion: String(emotion),
    intensity: clampIntensity(intensity),
  };
}

/**
 * error レスポンスを作成する。
 *
 * retriable:
 *   同じリクエストを再送してよいかどうか。
 *
 * details:
 *   開発時のデバッグ情報。
 *   NODE_ENV=production の場合はレスポンスに含めない。
 */
function createError({ code, message, retriable, details }) {
  const msg = {
    type: MESSAGE_TYPES.ERROR,
    code: String(code),
    message: String(message),
  };

  if (typeof retriable === 'boolean') {
    msg.retriable = retriable;
  }

  if (details && process.env.NODE_ENV !== 'production') {
    msg.details = details;
  }

  return msg;
}

// ─────────────────────────────────────────────
// 現時点では未使用のEdge Lambda向けファクトリ関数
// ─────────────────────────────────────────────
//
// 以下はCore Lambdaの会話生成では使わないためコメントアウトしている。
// Edge Lambdaとのメッセージ仕様で必要になった場合に戻す。

/*
function createFiller({ text, emotion = EMOTIONS.NEUTRAL, intensity = 0.5 }) {
  return {
    type: MESSAGE_TYPES.FILLER_AUDIO,
    text: String(text || ''),
    emotion: String(emotion),
    intensity: clampIntensity(intensity),
  };
}

function createToolCall({ tool, description, estimatedSeconds }) {
  const msg = {
    type: MESSAGE_TYPES.TOOL_CALL,
    tool: String(tool),
    description: String(description),
  };

  if (typeof estimatedSeconds === 'number') {
    msg.estimated_seconds = estimatedSeconds;
  }

  return msg;
}

function createProactive({ text, emotion = EMOTIONS.NEUTRAL, intensity = 0.5, trigger }) {
  const msg = {
    type: MESSAGE_TYPES.PROACTIVE_MESSAGE,
    text: String(text || ''),
    emotion: String(emotion),
    intensity: clampIntensity(intensity),
  };

  if (trigger) {
    msg.trigger = String(trigger);
  }

  return msg;
}

function createSessionStart({ sessionId }) {
  return {
    type: MESSAGE_TYPES.SESSION_START,
    session_id: String(sessionId),
  };
}
*/

// ─────────────────────────────────────────────
// Bedrock / LLM 応答の正規化ユーティリティ
// ─────────────────────────────────────────────

/**
 * Bedrock / LLM が返す生の応答文字列を chat メッセージに整える。
 *
 * 想定するLLM応答:
 * {
 *   "text": "返答本文",
 *   "emotion": "neutral",
 *   "intensity": 0.5
 * }
 *
 * 処理内容:
 * 1. Markdownコードフェンスを剥がす
 * 2. JSON.parseする
 * 3. text / emotion / intensity を取り出して chat に変換する
 * 4. image_description があれば内部用フィールド _imageDescription として保持する
 *
 * _imageDescription は将来、画像説明の履歴保存などに使う可能性がある。
 * クライアントへ返す前に不要なら削除する。
 *
 * @param {string} rawLLMOutput
 * @returns {Object} chat メッセージ or error メッセージ
 */
function normalizeLLMOutput(rawLLMOutput) {
  if (typeof rawLLMOutput !== 'string') {
    return createError({
      code: ERROR_CODES.LLM_ERROR,
      message: 'LLM応答が文字列ではありません',
      retriable: true,
    });
  }

  const cleaned = rawLLMOutput
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    return createError({
      code: ERROR_CODES.LLM_ERROR,
      message: 'LLM応答のJSONパースに失敗しました',
      retriable: true,
      details: {
        rawOutput: rawLLMOutput,
        parseError: e.message,
      },
    });
  }

  const chat = createChat({
    text: parsed.text || '',
    emotion: parsed.emotion || EMOTIONS.NEUTRAL,
    intensity: parsed.intensity ?? 0.5,
  });

  if (parsed.image_description && typeof parsed.image_description === 'string') {
    chat._imageDescription = String(parsed.image_description);
  }

  return chat;
}

// ─────────────────────────────────────────────
// 上りリクエストのバリデーション
// ─────────────────────────────────────────────

/**
 * Core Lambdaへ渡される会話入力を検証する。
 *
 * 期待する入力:
 * {
 *   "text": "こんにちは",
 *   "images": []
 * }
 *
 * images は省略可能。
 * textのみのリクエストはOK。
 * 画像のみのリクエストも許容する。
 *
 * 画像が含まれる場合、Core Lambdaでは画像Embeddingを行わない。
 * 画像は validateUpstream() で形式・サイズを検証した後、
 * prompt-builder / Bedrock Runtime client 側でモデルへ渡す。
 *
 * ただし、以下はNG:
 * - bodyがオブジェクトではない
 * - textが文字列ではない
 * - textが空、かつ images もない/空
 * - imagesが配列ではない
 * - 画像数が上限を超える
 * - 画像形式が未対応
 * - 画像合計サイズが上限を超える
 */
function validateUpstream(data) {
  if (!data || typeof data !== 'object') {
    return { valid: false, error: 'Message is not an object' };
  }

  if (typeof data.text !== 'string') {
    return { valid: false, error: 'text field is required and must be a string' };
  }

  const hasText = data.text.trim().length > 0;

  if (data.images === undefined || data.images === null) {
    if (!hasText) {
      return { valid: false, error: 'text or images is required' };
    }

    return { valid: true, message: data };
  }

  if (!Array.isArray(data.images)) {
    return { valid: false, error: 'images must be an array' };
  }

  if (data.images.length === 0) {
    if (!hasText) {
      return { valid: false, error: 'text or images is required' };
    }

    return { valid: true, message: data };
  }

  if (data.images.length > MAX_IMAGES_PER_MESSAGE) {
    return {
      valid: false,
      error: `Too many images (max ${MAX_IMAGES_PER_MESSAGE})`,
    };
  }

  let totalSize = 0;

  for (let i = 0; i < data.images.length; i++) {
    const img = data.images[i];

    if (!img || typeof img !== 'object') {
      return { valid: false, error: `images[${i}] must be an object` };
    }

    if (typeof img.data !== 'string' || img.data.length === 0) {
      return {
        valid: false,
        error: `images[${i}].data must be a non-empty Base64 string`,
      };
    }

    if (!SUPPORTED_IMAGE_TYPES.includes(img.media_type)) {
      return {
        valid: false,
        error: `Unsupported media_type: ${img.media_type}. Supported: ${SUPPORTED_IMAGE_TYPES.join(', ')}`,
      };
    }

    // Base64文字列のおおよそのバイト数。
    // Base64は元データの約4/3になるため、0.75倍で概算する。
    totalSize += Math.floor(img.data.length * 0.75);
  }

  if (totalSize > MAX_TOTAL_IMAGE_SIZE) {
    return {
      valid: false,
      error: `Total image size exceeds limit (${Math.floor(totalSize / 1024)}KB > ${MAX_TOTAL_IMAGE_SIZE / 1024 / 1024}MB)`,
    };
  }

  return { valid: true, message: data };
}

// ─────────────────────────────────────────────
// エクスポート
// ─────────────────────────────────────────────

module.exports = {
  // 定数
  SCHEMA_VERSION,
  MESSAGE_TYPES,
  EMOTIONS,
  ERROR_CODES,
  // TOOLS,
  SUPPORTED_IMAGE_TYPES,
  MAX_TOTAL_IMAGE_SIZE,
  MAX_IMAGES_PER_MESSAGE,

  // ファクトリ関数
  createChat,
  createError,

  // 現時点では未使用
  // createFiller,
  // createToolCall,
  // createProactive,
  // createSessionStart,

  // ユーティリティ
  normalizeLLMOutput,
  validateUpstream,
  clampIntensity,
};
