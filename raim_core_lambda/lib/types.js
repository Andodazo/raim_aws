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

  // v14: tool intro の後に送り、Flutterが本文を別吹き出しに分離するための区切り。
  // Coreではストリーミングイベントとして stream.bubble_break を使う。
  BUBBLE_BREAK: 'bubble_break',

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

  // v13 追加感情（ライムの「クール + 素の反応」表現用）
  CURIOUS: 'curious',       // 好奇心、興味津々
  AMUSED: 'amused',         // くすっと笑い
  THOUGHTFUL: 'thoughtful', // 思案
  PLAYFUL: 'playful',       // からかい
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
// images は、ユーザーがS3へアップロードした画像をMantleへ渡すための参照。
// 画像Embeddingや画像Scene選択には使用しない。Scene選択は text のEmbeddingのみで行う。
//
// Core Lambdaでは、Mantleへ渡す前に以下を検証する。
// - S3 key / contentType / sizeBytes が存在するか
// - 画像枚数が上限以内か
//
// 実サイズ・実形式・S3のContent-Typeは、s3-image-service.jsがS3実体を再検証する。
//
// textのみでも動作し、images は省略または空配列でもよい。

const SUPPORTED_IMAGE_TYPES = Object.freeze([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
]);

// 既定値。実行時は環境変数 IMAGE_MAX_TOTAL_BYTES を優先する。
const MAX_TOTAL_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

// 既定値。実行時は環境変数 IMAGE_MAX_COUNT を優先する。
const MAX_IMAGES_PER_MESSAGE = 10;

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function getImageConstraints(env = process.env) {
  const configuredTypes = String(
    env.IMAGE_ALLOWED_CONTENT_TYPES || SUPPORTED_IMAGE_TYPES.join(',')
  )
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  return {
    maxCount: parsePositiveInteger(env.IMAGE_MAX_COUNT, MAX_IMAGES_PER_MESSAGE),
    maxTotalBytes: parsePositiveInteger(
      env.IMAGE_MAX_TOTAL_BYTES,
      MAX_TOTAL_IMAGE_SIZE
    ),
    allowedContentTypes: Object.freeze([...new Set(configuredTypes)]),
  };
}

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

// 感情比率は割り算の結果なので、そのままだと 0.5555555555555556 のような
// 17桁の値になる。WebSocketで毎回送るには冗長で、ログも読みにくい。
//
// Unityの表情制御に必要な精度は3桁で十分（BlendShapeの重みは
// emotions[key] × overall_intensity × 100 で百分率になるため、
// 3桁あれば 0.1% 単位で表現できる）。
//
// 丸めによって比率の合計が 1.0 から僅かにずれる場合があるが、
// 表情表現には影響しない範囲。
function roundRatio(v) {
  return Math.round(v * 1000) / 1000;
}

// ─────────────────────────────────────────────
// emotions 正規化（v13 仕様）
// ─────────────────────────────────────────────
//
// LLMは「各感情の強さ」を素のMapで返す。例: {"happy": 0.8}
// これを2つの値に分解する。
//
//   emotions          : 各感情の「比率」。合計 1.0 に正規化。
//   overall_intensity : 表情全体の「強さ」。0.0〜1.0。
//
// Unity側の BlendShape 重み = emotions[key] × overall_intensity
// こうすると重みの合計が 1.0 を超えず、顔が崩れない。
//
// 変換例:
//   {"happy":0.7,"caring":0.3} → emotions {happy:0.7, caring:0.3} / overall 1.0
//   {"happy":0.8}              → emotions {happy:1.0}             / overall 0.8
//   {"happy":1.0,"caring":0.5} → emotions {happy:0.667,caring:0.333} / overall 1.0
//
// 計算式:
//   sum               = Σ raw
//   overall_intensity = clamp(sum, 0, 1)
//   emotions[key]     = raw[key] / sum

const ALLOWED_EMOTION_VALUES = Object.freeze(Object.values(EMOTIONS));

/**
 * LLMが返した素のemotions Mapを、比率 + 全体強度へ正規化する。
 *
 * 未定義の感情キーは捨てる。
 * 有効な感情が1つも無い場合は neutral 1.0 / overall 0.5 へフォールバックする。
 *
 * 戻り値: { emotions, overallIntensity, emotion, intensity }
 *   emotion / intensity は後方互換用のドミナント感情。
 */
function normalizeEmotions(rawEmotions) {
  const valid = {};
  let sum = 0;

  if (rawEmotions && typeof rawEmotions === 'object' && !Array.isArray(rawEmotions)) {
    for (const [key, value] of Object.entries(rawEmotions)) {
      const name = String(key).trim();

      if (!ALLOWED_EMOTION_VALUES.includes(name)) continue;

      const num = Number(value);
      if (!Number.isFinite(num) || num <= 0) continue;

      valid[name] = num;
      sum += num;
    }
  }

  // 有効な感情が無い場合のフォールバック
  if (sum <= 0) {
    return {
      emotions: { [EMOTIONS.NEUTRAL]: 1.0 },
      overallIntensity: 0.5,
      emotion: EMOTIONS.NEUTRAL,
      intensity: 0.5,
    };
  }

  // 比率へ正規化（合計 1.0）
  const emotions = {};
  for (const [name, value] of Object.entries(valid)) {
    emotions[name] = roundRatio(value / sum);
  }

  // 全体強度は素の合計をクランプしたもの
  const overallIntensity = roundRatio(clampIntensity(sum));

  // ドミナント感情（後方互換用）
  let emotion = EMOTIONS.NEUTRAL;
  let topRatio = 0;
  for (const [name, ratio] of Object.entries(emotions)) {
    if (ratio > topRatio) {
      topRatio = ratio;
      emotion = name;
    }
  }

  return {
    emotions,
    overallIntensity,
    emotion,
    intensity: roundRatio(clampIntensity(topRatio * overallIntensity)),
  };
}

/**
 * chat レスポンスを作成する。
 *
 * Core Lambdaの正常応答として、Edge Lambdaへ返す基本形式。
 * Flutter側は text をチャットUIに表示し、
 * emotions / overall_intensity をUnity表情制御に利用する想定。
 *
 * emotion / intensity は後方互換フィールド。
 * emotions を渡さない旧呼び出しでも動くよう、単一emotionからMapを組み立てる。
 */
function createChat({
  text,
  emotion = EMOTIONS.NEUTRAL,
  intensity = 0.5,
  emotions,
  overallIntensity,
}) {
  // 呼び出し元がemotions Mapを渡していない場合は、
  // 旧形式の emotion + intensity からMapを合成する。
  const source = (emotions && typeof emotions === 'object' && !Array.isArray(emotions))
    ? emotions
    : { [String(emotion)]: clampIntensity(intensity) };

  const normalized = normalizeEmotions(source);

  // overallIntensity が明示指定されている場合はそちらを優先する。
  // （LLMが overall_intensity を直接返してきたケース）
  const finalOverall = typeof overallIntensity === 'number' && !isNaN(overallIntensity)
    ? roundRatio(clampIntensity(overallIntensity))
    : normalized.overallIntensity;

  const dominantRatio = normalized.emotions[normalized.emotion] || 0;

  return {
    type: MESSAGE_TYPES.CHAT,
    text: String(text || ''),

    // v13: 比率 + 全体強度
    emotions: normalized.emotions,
    overall_intensity: finalOverall,

    // 後方互換: ドミナント感情 × 全体強度
    emotion: normalized.emotion,
    intensity: roundRatio(clampIntensity(dominantRatio * finalOverall)),
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

function createToolCall({ tool, description }) {
  return {
    type: MESSAGE_TYPES.TOOL_CALL,
    tool: String(tool),
    description: String(description),
  };
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
 * 画像はS3参照形式を検証した後、s3-image-service.jsで実体を再検証し、
 * Mantle用S3 URIへ変換してprompt-builderへ渡す。
 *
 * ただし、以下はNG:
 * - bodyがオブジェクトではない
 * - textが文字列ではない
 * - textが空、かつ images もない/空
 * - imagesが配列ではない
 * - 画像数が上限を超える
 * - S3参照形式ではない
 */
function validateUpstream(data, { env = process.env } = {}) {
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

  const constraints = getImageConstraints(env);

  if (data.images.length > constraints.maxCount) {
    return {
      valid: false,
      error: `Too many images (max ${constraints.maxCount})`,
    };
  }

  for (let i = 0; i < data.images.length; i++) {
    const img = data.images[i];

    if (!img || typeof img !== 'object') {
      return { valid: false, error: `images[${i}] must be an object` };
    }

    if (typeof img.key !== 'string' || img.key.trim().length === 0) {
      return {
        valid: false,
        error: `images[${i}].key must be a non-empty S3 object key`,
      };
    }

    if (typeof img.contentType !== 'string' || img.contentType.trim().length === 0) {
      return {
        valid: false,
        error: `images[${i}].contentType must be a non-empty MIME type`,
      };
    }

    const contentType = img.contentType.trim().toLowerCase();
    if (!constraints.allowedContentTypes.includes(contentType)) {
      return {
        valid: false,
        error: `Unsupported contentType: ${contentType}. Supported: ${constraints.allowedContentTypes.join(', ')}`,
      };
    }

    if (!Number.isSafeInteger(img.sizeBytes) || img.sizeBytes < 0) {
      return {
        valid: false,
        error: `images[${i}].sizeBytes must be a non-negative integer`,
      };
    }

    // 画像本体やBase64がpayloadに残っていないことを早期に検知する。
    if (Object.prototype.hasOwnProperty.call(img, 'data') ||
        Object.prototype.hasOwnProperty.call(img, 'media_type')) {
      return {
        valid: false,
        error: `images[${i}] must use S3 reference fields only`,
      };
    }
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
  getImageConstraints,

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
  normalizeEmotions,
};
