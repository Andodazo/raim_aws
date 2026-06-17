'use strict';

// ==============================================================================
// Mantle Client
// ==============================================================================
//
// 【このファイルの役割】
// Mantle Responses API へアクセスするためのクライアント層。
//
// ただし、現時点ではBedrock / Mantle連携をまだ行わないため、
// まずはモック実装として動かす。
//
// 【現在の役割】
// - prompt-builder.js が作成した mantleInput を受け取る
// - 本物のMantleが返す想定に近い rawText を返す
// - fake response_id を生成して返す
// - index.js 側で updateMantleResponseState() を呼べるようにする
//
// 【将来の役割】
// - Mantle Responses API を実際に呼び出す
// - previous_response_id を付けて会話を継続する
// - Mantleから返った response.id を responseId として返す
// - Mantleから返った出力テキストを rawText として返す
//
// 【重要】
// response_id はLambda側で本来生成しない。
// 本番では Mantle が返した response.id を保存する。
// ただし、現在はMantle未接続のため、モック用に mock-resp-... を生成する。
//
// ==============================================================================

const crypto = require('crypto');

// ─────────────────────────────────────────────
// 実行モード
// ─────────────────────────────────────────────
//
// MANTLE_MODE:
//   mock: モック応答を返す
//   real: 将来の本物Mantle接続用
//
// 現時点では mock をデフォルトにする。

const MANTLE_MODE = process.env.MANTLE_MODE || 'mock';

// ─────────────────────────────────────────────
// モック response_id 生成
// ─────────────────────────────────────────────
//
// 本物のMantleでは、response_id はMantle側が生成する。
// 現時点ではDynamoDB保存処理を検証するために、
// fake response_id を生成する。
//
// 例:
//   mock-resp-550e8400-e29b-41d4-a716-446655440000

function createMockResponseId() {
  return `mock-resp-${crypto.randomUUID()}`;
}

// ─────────────────────────────────────────────
// mantleInput から現在のユーザー入力を取り出す
// ─────────────────────────────────────────────
//
// prompt-builder.js の mantleInput は以下のような構造を想定している:
//
// {
//   mode: "initial",
//   messages: [
//     { role: "system", content: "..." },
//     { role: "user", content: "..." },
//     ...
//   ],
//   hasImages: false,
//   sceneId: "default"
// }
//
// 画像ありの場合、最後のuser messageのcontentは配列になる:
//
// [
//   { type: "input_text", text: "この画像見て" },
//   { type: "input_image", image_url: "data:image/png;base64,..." }
// ]
//
// debugやモック返答で使うため、最後のuser発話のtextだけ取り出す。

function extractLatestUserText(mantleInput) {
  const messages = Array.isArray(mantleInput?.messages)
    ? mantleInput.messages
    : [];

  const userMessages = messages.filter((message) => message.role === 'user');

  if (userMessages.length === 0) {
    return '';
  }

  const latestUserMessage = userMessages[userMessages.length - 1];
  const content = latestUserMessage.content;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const textPart = content.find((part) => part.type === 'input_text');
    return String(textPart?.text || '');
  }

  return '';
}

// ─────────────────────────────────────────────
// Sceneに応じたモック応答
// ─────────────────────────────────────────────
//
// Mantle未接続でも、Scene選択が返答に反映されていることを確認するため、
// sceneIdごとに少しだけ返答の雰囲気を変える。
//
// 本物のMantle接続後は、この処理は使わなくなる。

function createMockAssistantPayload({ mantleInput, previousResponseId }) {
  const userText = extractLatestUserText(mantleInput);
  const sceneId = mantleInput?.sceneId || 'default';
  const hasImages = Boolean(mantleInput?.hasImages);
  const mode = mantleInput?.mode || 'initial';

  if (sceneId === 'gaming') {
    return {
      text: hasImages
        ? `画像も受け取ったよ。ゲームの話として見るね。まずは「${userText}」について一緒に考えよう。`
        : `ゲームの話だね。「${userText}」について、一緒に整理して考えよう。`,
      emotion: 'excited',
      intensity: 0.65,
    };
  }

  if (sceneId === 'tired') {
    return {
      text: hasImages
        ? `画像も含めて受け取ったよ。今は少し疲れている感じかな。無理しすぎないようにしよう。`
        : `そっか、「${userText}」って感じなんだね。ちょっと疲れが出てるのかも。無理しすぎないでね。`,
      emotion: 'caring',
      intensity: 0.75,
    };
  }

  if (sceneId === 'joke') {
    return {
      text: hasImages
        ? `画像まで添えてくるの、ちょっと面白いね。ふふっ、ちゃんと見てるよ。`
        : `ふふっ、「${userText}」って、ちょっと軽口っぽくていいね。`,
      emotion: 'happy',
      intensity: 0.6,
    };
  }

  return {
    text: hasImages
      ? `画像も受け取ったよ。「${userText || '画像'}」について、ちゃんと確認するね。`
      : `「${userText}」って送ってくれたんだね。ちゃんと届いてるよ。`,
    emotion: mode === 'followup' && previousResponseId ? 'happy' : 'neutral',
    intensity: mode === 'followup' && previousResponseId ? 0.6 : 0.5,
  };
}

// ─────────────────────────────────────────────
// モックMantle呼び出し
// ─────────────────────────────────────────────
//
// 本物のMantle Responses APIを呼んだ場合に近い形で、以下を返す。
//
// responseId:
//   本物ではMantleの response.id。
//   現在は mock-resp-...。
//
// rawText:
//   Mantleが生成したテキスト応答を想定。
//   response-validator / normalizeLLMOutput 側でJSONとして解釈する。
//
// createdAt:
//   response_id を受け取った時刻。
//   UserSessionの lastResponseCreatedAt に保存する。
//
// usedPreviousResponseId:
//   previous_response_id を使った呼び出しだったかどうか。

async function createMockMantleResponse({
  mantleInput,
  previousResponseId = '',
  store = true,
}) {
  const responseId = createMockResponseId();
  const createdAt = new Date().toISOString();

  const payload = createMockAssistantPayload({
    mantleInput,
    previousResponseId,
  });

  return {
    responseId,
    rawText: JSON.stringify(payload),
    createdAt,
    store,
    mode: mantleInput?.mode || 'initial',
    usedPreviousResponseId: Boolean(previousResponseId),
    finishReason: 'mock',
  };
}

// ─────────────────────────────────────────────
// 本物Mantle呼び出し予定地
// ─────────────────────────────────────────────
//
// 将来的にはここに実際のMantle Responses API呼び出しを実装する。
//
// 実装予定:
// - mantleInput.messages をMantleのinput形式に変換
// - previousResponseId があれば previous_response_id に設定
// - store: true を指定
// - Mantleレスポンスから id と出力テキストを取り出す
//
// 現時点では誤って real mode で動かした場合に分かるように例外を投げる。

async function createRealMantleResponse() {
  throw new Error('Real Mantle client is not implemented yet');
}

// ─────────────────────────────────────────────
// 外部公開関数
// ─────────────────────────────────────────────
//
// index.js からは基本的に createMantleResponse() だけを呼ぶ。
// MANTLE_MODE=mock の間はモック応答。
// MANTLE_MODE=real に切り替えたら本物Mantle呼び出しに移行する。

async function createMantleResponse({
  mantleInput,
  previousResponseId = '',
  store = true,
}) {
  if (!mantleInput || typeof mantleInput !== 'object') {
    throw new Error('mantleInput is required');
  }

  if (MANTLE_MODE === 'real') {
    return createRealMantleResponse({
      mantleInput,
      previousResponseId,
      store,
    });
  }

  return createMockMantleResponse({
    mantleInput,
    previousResponseId,
    store,
  });
}

// ─────────────────────────────────────────────
// デバッグ表示用サマリ
// ─────────────────────────────────────────────
//
// rawText全文をdebugに返してもよいが、今後長くなる可能性があるため、
// レスポンス確認用には概要だけ返せるようにする。

function summarizeMantleResponse(response) {
  if (!response || typeof response !== 'object') {
    return null;
  }

  return {
    responseId: response.responseId || '',
    createdAt: response.createdAt || '',
    mode: response.mode || '',
    usedPreviousResponseId: Boolean(response.usedPreviousResponseId),
    finishReason: response.finishReason || '',
  };
}

module.exports = {
  MANTLE_MODE,
  createMantleResponse,
  summarizeMantleResponse,

  // テスト・デバッグ用
  createMockResponseId,
  extractLatestUserText,
};