'use strict';

// ==============================================================================
// Mantle Response Validator
// ==============================================================================
//
// 【このファイルの役割】
// Mantle / LLM から返ってきた応答を、RAiMクライアント向けの形式に正規化する。
//
// Mantleには、固定プロンプトで以下のJSON形式を返すよう指示している。
//
// 期待するMantle出力:
// {
//   "text": "返答本文",
//   "emotion": "neutral",
//   "intensity": 0.5
// }
//
// ただし、LLMの出力は常に完全に安定するとは限らない。
// 例えば、以下のような崩れ方があり得る。
//
// - Markdownコードブロックで囲まれる
// - JSONの前後に説明文が混ざる
// - emotion が未定義の値になる
// - intensity が文字列になる
// - intensity が 0.0〜1.0 の範囲外になる
// - text が空になる
//
// このファイルでは、そうした出力をできるだけ安全に補正し、
// 最終的に以下の形式へ揃える。
//
// Lambdaからクライアントへ返す形式:
// {
//   "type": "chat",
//   "text": "返答本文",
//   "emotion": "neutral",
//   "intensity": 0.5
// }
//
// 【types.js との役割分担】
// types.js:
//   - API全体で使う基本定数
//   - createChat()
//   - createError()
//   - validateUpstream()
//
// response-validator.js:
//   - Mantle / LLM 応答のパース
//   - Mantle / LLM 応答の補正
//   - RAiM形式への変換
//
// ==============================================================================

const {
  createChat,
  createError,
  ERROR_CODES,
  EMOTIONS,
  MESSAGE_TYPES,
  clampIntensity,
} = require('./types');

// ─────────────────────────────────────────────
// 許可するemotion一覧
// ─────────────────────────────────────────────
//
// types.js の EMOTIONS から許可値を作る。
// これに含まれないemotionがMantleから返ってきた場合は neutral に補正する。

const ALLOWED_EMOTIONS = Object.freeze(
  Object.values(EMOTIONS)
);

// ─────────────────────────────────────────────
// 文字列ユーティリティ
// ─────────────────────────────────────────────

function toSafeString(value) {
  return String(value || '');
}

function hasText(value) {
  return toSafeString(value).trim().length > 0;
}

// ─────────────────────────────────────────────
// Markdownコードフェンス除去
// ─────────────────────────────────────────────
//
// LLMは指示していても、以下のような形式で返すことがある。
//
// ```json
// {"text":"こんにちは","emotion":"neutral","intensity":0.5}
// ```
//
// このままだと JSON.parse() に失敗するため、前後のコードフェンスを取り除く。

function stripMarkdownCodeFence(rawText) {
  return toSafeString(rawText)
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

// ─────────────────────────────────────────────
// JSON部分の抽出
// ─────────────────────────────────────────────
//
// Mantle / LLM が理想通りJSONだけを返さず、前後に文章を混ぜる可能性がある。
//
// 例:
//   以下のJSONで返します。
//   {"text":"こんにちは","emotion":"happy","intensity":0.6}
//
// この場合でも、最初の { から最後の } までを抜き出してJSON parseを試みる。
// 完全なJSONだけが返ってきた場合も、そのまま処理できる。

function extractJsonLikeText(rawText) {
  const cleaned = stripMarkdownCodeFence(rawText);

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return cleaned;
  }

  return cleaned.slice(firstBrace, lastBrace + 1);
}

// ─────────────────────────────────────────────
// Mantle rawText のJSON parse
// ─────────────────────────────────────────────
//
// rawText が文字列ならJSONとしてparseする。
// すでにObjectの場合は、そのまま扱う。
// これは、将来 mantle-client.js 側の実装を変えても壊れにくくするため。

function parseMantleOutput(rawOutput) {
  if (!rawOutput) {
    return {
      ok: false,
      error: 'Mantle response is empty',
      parsed: null,
    };
  }

  if (typeof rawOutput === 'object') {
    return {
      ok: true,
      error: '',
      parsed: rawOutput,
    };
  }

  if (typeof rawOutput !== 'string') {
    return {
      ok: false,
      error: 'Mantle response is not a string or object',
      parsed: null,
    };
  }

  const jsonText = extractJsonLikeText(rawOutput);

  try {
    return {
      ok: true,
      error: '',
      parsed: JSON.parse(jsonText),
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
      parsed: null,
      rawText: rawOutput,
    };
  }
}

// ─────────────────────────────────────────────
// emotion補正
// ─────────────────────────────────────────────
//
// Mantleが未定義のemotionを返した場合、Unity側で扱えない可能性がある。
// そのため、許可値以外は neutral に補正する。

function normalizeEmotion(emotion) {
  const value = toSafeString(emotion).trim();

  if (ALLOWED_EMOTIONS.includes(value)) {
    return value;
  }

  return EMOTIONS.NEUTRAL;
}

// ─────────────────────────────────────────────
// intensity補正
// ─────────────────────────────────────────────
//
// intensityは 0.0〜1.0 の数値として扱う。
// Mantleが "0.7" のような文字列を返す可能性もあるため、
// 数値に変換できる場合は変換してから clamp する。

function normalizeIntensity(intensity) {
  if (typeof intensity === 'number') {
    return clampIntensity(intensity);
  }

  if (typeof intensity === 'string' && intensity.trim() !== '') {
    const parsed = Number(intensity);

    if (!Number.isNaN(parsed)) {
      return clampIntensity(parsed);
    }
  }

  return 0.5;
}

// ─────────────────────────────────────────────
// text補正
// ─────────────────────────────────────────────
//
// textが空だと、クライアント側で表示する内容がなくなる。
// 原則としてMantleにはtextを必ず返すよう指示するが、
// 念のため空の場合はフォールバック文を入れる。

function normalizeText(text) {
  if (hasText(text)) {
    return toSafeString(text).trim();
  }

  return 'うまく返答を作れなかったみたい。もう一度送ってくれる？';
}

// ─────────────────────────────────────────────
// Mantle payload の正規化
// ─────────────────────────────────────────────
//
// parsed payload をRAiMのchat形式に変換する。
// parsed.type が含まれていても、Mantle出力では基本使わない。
// 最終的な type: "chat" は createChat() で付与する。

function normalizeMantlePayload(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    return createError({
      code: ERROR_CODES.LLM_ERROR,
      message: 'Mantle応答がJSONオブジェクトではありません',
      retriable: true,
    });
  }

  const chat = createChat({
    text: normalizeText(parsed.text),
    emotion: normalizeEmotion(parsed.emotion),
    intensity: normalizeIntensity(parsed.intensity),
  });

  // 画像が含まれる場合、Mantleが image_description を返す可能性がある。
  // これはクライアントへ表示するためではなく、将来の履歴保存用の内部情報。
  // そのため _ prefix を付けて内部フィールドとして保持する。
  if (hasText(parsed.image_description)) {
    chat._imageDescription = toSafeString(parsed.image_description).trim();
  }

  return chat;
}

// ─────────────────────────────────────────────
// 外部公開: Mantle出力の正規化
// ─────────────────────────────────────────────
//
// index.js から基本的にこの関数を呼ぶ。
// rawOutput は mantleResponse.rawText を想定する。
//
// 戻り値:
// - 成功時: type: "chat"
// - 失敗時: type: "error"

function normalizeMantleOutput(rawOutput) {
  const parseResult = parseMantleOutput(rawOutput);

  if (!parseResult.ok) {
    return createError({
      code: ERROR_CODES.LLM_ERROR,
      message: 'Mantle応答のJSONパースに失敗しました',
      retriable: true,
      details: {
        parseError: parseResult.error,
        rawOutput: parseResult.rawText || rawOutput,
      },
    });
  }

  return normalizeMantlePayload(parseResult.parsed);
}

// ─────────────────────────────────────────────
// デバッグ表示用サマリ
// ─────────────────────────────────────────────
//
// normalize後の出力をdebugに入れやすい形へ整形する。
// text全文をdebugに含めると長くなることがあるため、長さだけ返す。

function summarizeValidatedResponse(output) {
  if (!output || typeof output !== 'object') {
    return null;
  }

  return {
    type: output.type || '',
    isChat: output.type === MESSAGE_TYPES.CHAT,
    isError: output.type === MESSAGE_TYPES.ERROR,
    emotion: output.emotion || '',
    intensity: typeof output.intensity === 'number' ? output.intensity : null,
    textLength: typeof output.text === 'string' ? output.text.length : 0,
    hasImageDescription: Boolean(output._imageDescription),
  };
}

module.exports = {
  ALLOWED_EMOTIONS,
  stripMarkdownCodeFence,
  extractJsonLikeText,
  parseMantleOutput,
  normalizeEmotion,
  normalizeIntensity,
  normalizeText,
  normalizeMantlePayload,
  normalizeMantleOutput,
  summarizeValidatedResponse,
};