'use strict';

// ==============================================================================
// Mantle Prompt Builder
// ==============================================================================
//
// 【このファイルの役割】
// Mantleへ渡す入力メッセージを組み立てる。
//
// 既存のローカル版 prompt-builder.js では、Ollama / Gemma向けに
// messages 配列を組み立てていた。
//
// 今回のAWS版では、以下の方針に変える。
//
// 旧:
// - Ollama / Gemma に messages を渡す
// - 固定プロンプトはこのファイル内に直接書く
// - 会話履歴は memory-store.js から渡す
// - 画像はOllama形式の images 配列で渡す
//
// 新:
// - Mantleへ渡す入力を組み立てる
// - 固定プロンプトは prompts/raim-system-prompt.js から読み込む
// - 会話継続は Mantle の previous_response_id を使う
// - previous_response_id が使えない場合は sessionSummary を渡して復旧する
// - Few-shot はDynamoDBのScene定義から取得したものを渡す
// - 画像Embeddingは行わず、CoreがS3から取得したdata URLをMantleへ渡す
//
// 【重要】
// このファイルではMantle APIを直接呼ばない。
// 実際の送信は mantle-client.js が担当する。
//
// このファイルはあくまで、Mantleへ渡すための「入力構造」を作るだけ。
//
// ==============================================================================

const {
  RAIM_SYSTEM_PROMPT_VERSION,
  RAIM_SYSTEM_PROMPT,
  PERSONA_DIGEST,
  TOOLS_DIGEST,
  SAFETY_RULE,
  MULTIMODAL_APPENDIX,
  getTimeContext,
  buildSystemPrompt,
} = require('./prompts/raim-system-prompt');

// ─────────────────────────────────────────────
// 内部ユーティリティ
// ─────────────────────────────────────────────

function toSafeString(value) {
  return String(value || '');
}

function hasText(value) {
  return toSafeString(value).trim().length > 0;
}

// ─────────────────────────────────────────────
// 継続会話の人格再注入設定
// ─────────────────────────────────────────────
//
// FOLLOWUP_PERSONA_MODE : 'digest'（既定）| 'full' | 'none'
// FOLLOWUP_FEW_SHOT_COUNT : 継続会話へ入れるfew-shot組数（既定1、0で無効）
//
// どちらも環境変数なので、デプロイし直さずに口調を実測比較できる。

const FOLLOWUP_PERSONA_MODE =
  String(process.env.FOLLOWUP_PERSONA_MODE || 'digest').trim().toLowerCase();

const FOLLOWUP_FEW_SHOT_COUNT = Math.max(
  0,
  Number(process.env.FOLLOWUP_FEW_SHOT_COUNT ?? 1)
);

function hasImages(images) {
  return Array.isArray(images) && images.length > 0;
}

function normalizeEmotionMap(emotions) {
  if (!emotions || typeof emotions !== 'object' || Array.isArray(emotions)) {
    return {};
  }

  const normalized = {};

  for (const [emotion, intensity] of Object.entries(emotions)) {
    const name = toSafeString(emotion).trim();
    const value = Number(intensity);

    if (!name || !Number.isFinite(value)) {
      continue;
    }

    normalized[name] = Math.min(1, Math.max(0, value));
  }

  return normalized;
}

function summarizeEmotionMap(emotions) {
  const normalized = normalizeEmotionMap(emotions);
  const entries = Object.entries(normalized);

  if (entries.length === 0) {
    return 'なし';
  }

  return entries
    .map(([emotion, intensity]) => `${emotion}:${intensity}`)
    .join(', ');
}

function pickPrimaryEmotion(emotions, fallbackEmotion = 'neutral') {
  const entries = Object.entries(normalizeEmotionMap(emotions));

  if (entries.length === 0) {
    return fallbackEmotion;
  }

  entries.sort((left, right) => right[1] - left[1]);
  return entries[0][0];
}

function pickPrimaryIntensity(emotions, fallbackIntensity = 0.5) {
  const entries = Object.entries(normalizeEmotionMap(emotions));

  if (entries.length === 0) {
    return fallbackIntensity;
  }

  entries.sort((left, right) => right[1] - left[1]);
  return entries[0][1];
}

/**
 * Coreで検証済みのS3 URIをMantleへ渡す。
 *
 * s3-image-service.jsで、各画像は以下の形へ解決済みの想定。
 *
 * {
 *   key: "temporary/users/sub/request/image.png",
 *   contentType: "image/png",
 *   sizeBytes: 1234,
 *   s3Uri: "s3://bucket/temporary/users/sub/request/image.png",
 *   dataUrl: "data:image/png;base64,..."
 * }
 *
 */
function toImageDataUrl(image) {
  if (!image || typeof image.dataUrl !== 'string' || image.dataUrl.length === 0) {
    throw new Error('Resolved image data URL is missing');
  }

  return image.dataUrl;
}

// ─────────────────────────────────────────────
// Scene / Few-shot 整形
// ─────────────────────────────────────────────

/**
 * Sceneの説明文をMantleへ渡しやすいテキストにする。
 *
 * Sceneは、ユーザー発話の種類を表す補助情報。
 *
 * 例:
 * - default: 雑談・基本トーン
 * - gaming: ゲーム話・攻略
 * - tired: 疲労・不安
 * - joke: 軽口・冗談
 *
 * この情報は、Mantleに「今の会話の方向性」を伝えるために使う。
 */
function buildSceneContext(scene) {
  if (!scene) {
    return [
      '現在選択されているSceneはありません。',
      '通常の雑談として自然に返答してください。',
    ].join('\n');
  }

  return [
    '現在選択されているScene情報:',
    `- id: ${scene.id || 'unknown'}`,
    `- description: ${scene.description || ''}`,
    `- embedding_text: ${scene.embedding_text || ''}`,
    `- default_emotions: ${summarizeEmotionMap(scene.default_emotions)}`,
    '',
    'embedding_textは、ユーザー発話に近いSceneを選ぶための検索用テキストです。',
    'default_emotionsは、このSceneで出やすい感情の目安です。',
    'どちらもユーザーへそのまま説明せず、返答の雰囲気やemotion選択に自然に反映してください。',
  ].join('\n');
}

/**
 * Sceneに紐づいたFew-shotをMantle用メッセージに変換する。
 *
 * few_shots は「過去の会話履歴」ではなく「返答のお手本」。
 * そのため、初回会話やresponse_id復旧時に固定プロンプトの後へ入れる。
 *
 * Mantleに期待する出力は、Lambda側で type: "chat" を付与する前の形式。
 *
 * 期待するMantle出力:
 * {
 *   "text": "返答本文",
 *   "emotion": "neutral",
 *   "intensity": 0.5
 * }
 *
 * そのため、Few-shotのassistant側も type は含めない。
 */
function buildFewShotMessages(scene) {
  if (!scene || !Array.isArray(scene.few_shots)) {
    return [];
  }

  const messages = [];

  for (const fs of scene.few_shots) {
    if (!fs || typeof fs !== 'object') {
      continue;
    }

    const emotions = normalizeEmotionMap(fs.emotions);

    messages.push({
      role: 'user',
      content: toSafeString(fs.user),
    });

    // v13: Mantleへ要求する出力形式は emotions Map + overall_intensity。
    // few-shotの応答例も同じ形式で見せないと、モデルが旧形式を真似てしまう。
    //
    // few_shots が emotions Map を持たない旧形式の場合は、
    // 単一の emotion / intensity からMapを合成して形式を揃える。
    const hasEmotions = Object.keys(emotions).length > 0;

    const exampleEmotions = hasEmotions
      ? emotions
      : {
          [pickPrimaryEmotion(emotions, toSafeString(fs.emotion || 'neutral'))]:
            pickPrimaryIntensity(
              emotions,
              typeof fs.intensity === 'number' ? fs.intensity : 0.5
            ),
        };

    // overall_intensity が明示されていない場合は、
    // 感情強度の合計（最大1.0）を全体強度の目安として使う。
    const exampleOverall = typeof fs.overall_intensity === 'number'
      ? Math.max(0, Math.min(1, fs.overall_intensity))
      : Math.max(0, Math.min(1, Object.values(exampleEmotions).reduce((a, b) => a + b, 0)));

    messages.push({
      role: 'assistant',
      content: JSON.stringify({
        text: toSafeString(fs.raim),
        emotions: exampleEmotions,
        overall_intensity: exampleOverall,
      }),
    });
  }

  return messages;
}

// ─────────────────────────────────────────────
// SessionSummary 整形
// ─────────────────────────────────────────────

/**
 * sessionSummaryをMantleへ渡すテキストにする。
 *
 * sessionSummaryは、previous_response_id が使えない場合の復旧用コンテキスト。
 *
 * 例:
 * - response_idが期限切れ
 * - response_idがMantle側で削除済み
 * - 初回アクセスでまだresponse_idがない
 *
 * この場合、Mantleは過去の会話状態を参照できないため、
 * DynamoDBに保存済みの sessionSummary を固定プロンプトと一緒に渡す。
 */
/**
 * スレッドを跨いだユーザー記憶をMantleへ渡すテキストにする。
 *
 * sessionSummary が「このスレッドで何を話したか」なのに対し、
 * userMemory は「この人はどんな人か」。別スレッドで得た情報を
 * 持ち込むためのもので、週次バッチが各スレッドの要約から作る。
 */
function buildUserMemoryContext(userMemory) {
  if (!hasText(userMemory)) {
    return '';
  }

  return [
    '【ユーザーについて覚えていること】',
    '過去の会話から分かっていること。今回の話題と関係なければ無理に持ち出さない。',
    '',
    String(userMemory).trim(),
  ].join('\n');
}

function buildSessionSummaryContext(sessionSummary) {
  if (!hasText(sessionSummary)) {
    return [
      '過去会話の要約はまだありません。',
      '現在のユーザー発話をもとに自然に返答してください。',
    ].join('\n');
  }

  return [
    '以下は過去会話の要約です。',
    '必要な場合だけ、現在の会話の文脈として自然に利用してください。',
    '要約の内容をそのままユーザーに説明し直す必要はありません。',
    '',
    sessionSummary,
  ].join('\n');
}

// ─────────────────────────────────────────────
// 画像付きユーザー入力の整形
// ─────────────────────────────────────────────

/**
 * ユーザー入力をMantleへ渡すcontent形式に変換する。
 *
 * テキストのみ:
 *   content: "こんにちは"
 *
 * 画像あり:
 *   content: [
 *     { type: "input_text", text: "この画像を見て" },
 *     { type: "input_image", image_url: "data:image/png;base64,..." }
 *   ]
 *
 * 実際のMantle APIが要求する細部の形式は mantle-client.js 側で調整できるようにする。
 * prompt-builder.js では「画像とテキストを分離して保持する」ことを優先する。
 */
function buildUserContent({ userText, images = [] }) {
  const text = toSafeString(userText);
  const imageList = Array.isArray(images) ? images : [];

  if (!hasImages(imageList)) {
    return text;
  }

  const content = [];

  if (hasText(text)) {
    content.push({
      type: 'input_text',
      text,
    });
  } else {
    content.push({
      type: 'input_text',
      text: 'ユーザーは画像のみを送信しました。画像の内容を踏まえて返答してください。',
    });
  }

  for (const image of imageList) {
    content.push({
      type: 'input_image',
      image_url: toImageDataUrl(image),
    });
  }

  return content;
}

/**
 * 今回のユーザー発話をMantle用messageにする。
 */
function buildUserMessage({ userText, images = [] }) {
  return {
    role: 'user',
    content: buildUserContent({ userText, images }),
  };
}

// ─────────────────────────────────────────────
// 初回 / 復旧時 input 作成
// ─────────────────────────────────────────────

/**
 * previous_response_id を使わない場合のMantle入力を作る。
 *
 * 使う場面:
 * - 初回会話
 * - lastResponseId が空
 * - lastResponseId が期限切れ
 * - Mantle側で previous_response_id が無効になった
 *
 * この場合、Mantle側には過去文脈がないため、以下をまとめて渡す。
 *
 * 1. RAiM固定プロンプト
 * 2. sessionSummary
 * 3. Scene情報
 * 4. Few-shot
 * 5. 今回のユーザー発話
 */
function buildInitialMantleInput({
  userText,
  images = [],
  sessionSummary = '',
  userMemory = '',
  scene = null,
  withTools = false,
}) {
  const messages = [];

  // ツール有効時はsystemプロンプトにツールの使い方と、
  // ツール結果の扱い方（結果を無視して挨拶を始めない）を含める。
  // 画像がある場合はimage_descriptionの指示も追加する。
  const systemPrompt = buildSystemPrompt({
    withTools,
    hasImages: hasImages(images),
  });

  messages.push({
    role: 'system',
    content: [
      systemPrompt,
      '',
      '---',
      '',
      buildUserMemoryContext(userMemory),
      '',
      '---',
      '',
      buildSessionSummaryContext(sessionSummary),
      '',
      '---',
      '',
      buildSceneContext(scene),
    ].join('\n'),
  });

  messages.push(...buildFewShotMessages(scene));

  messages.push(
    buildUserMessage({
      userText,
      images,
    })
  );

  return {
    mode: 'initial',
    promptVersion: RAIM_SYSTEM_PROMPT_VERSION,
    messages,
    hasImages: hasImages(images),
    sceneId: scene?.id || '',
  };
}

// ─────────────────────────────────────────────
// 継続会話 input 作成
// ─────────────────────────────────────────────

/**
 * previous_response_id を使う場合のMantle入力を作る。
 *
 * 使う場面:
 * - DynamoDBに lastResponseId が保存されている
 * - lastResponseExpiresAt がまだ未来
 * - Mantle側で previous_response_id を使える見込みがある
 *
 * この場合、Mantle側が過去文脈を保持している想定なので、
 * 固定プロンプト全文やsessionSummaryは基本的に毎回送らない。
 *
 * ただし、現在のSceneだけは軽く伝える。
 * これにより、話題が変わったときにも返答スタイルを調整しやすくする。
 */
function buildFollowupMantleInput({
  userText,
  images = [],
  scene = null,
  includeSceneHint = true,
  personaMode = FOLLOWUP_PERSONA_MODE,
  fewShotCount = FOLLOWUP_FEW_SHOT_COUNT,
  withTools = false,
  now = new Date(),
}) {
  const messages = [];

  // ─────────────────────────────────────────────
  // 人格の再注入
  // ─────────────────────────────────────────────
  //
  // previous_response_id があってもGemmaは人格から乖離するため、
  // 継続会話でも人格を毎回送り直す。
  //
  // personaMode:
  //   'digest' 口調・禁止事項・出力形式だけの圧縮版（約470文字、既定）
  //   'full'   初回と同じ固定プロンプト全文（約2200文字）
  //   'none'   送らない（当初の設計。人格が崩れるため非推奨）
  //
  // 環境変数 FOLLOWUP_PERSONA_MODE で切り替えられるので、
  // デプロイし直さずに実測比較できる。
  if (personaMode === 'full') {
    messages.push({
      role: 'system',
      content: buildSystemPrompt({ hasImages: hasImages(images) }),
    });
  } else if (personaMode !== 'none') {
    messages.push({
      role: 'system',
      content: PERSONA_DIGEST,
    });
  }

  // personaMode が 'full' のときは buildSystemPrompt() が
  // 以下をすべて含むので、二重に送らない。
  if (personaMode !== 'full') {
    // 継続会話では初回の system プロンプトが届かないため、
    // 状況に依存するルールをここで補う。
    //
    // 以前はこれらが2ターン目以降に一切届いておらず、
    //   - 今日が何月何日か分からないまま日付の話をする
    //   - ツールのルールを知らないままツールを呼べる
    //   - 画像が複数あっても image_description の書き方を知らない
    // という状態だった。継続モードが実際に動き出すまで表面化しなかった。
    const situational = [`【現在の状況】\n${getTimeContext(now)}`];

    if (withTools) {
      situational.push(TOOLS_DIGEST);
    }

    if (hasImages(images)) {
      situational.push(MULTIMODAL_APPENDIX.trim());
    }

    situational.push(SAFETY_RULE.trim());

    messages.push({
      role: 'system',
      content: situational.join('\n\n'),
    });
  }

  if (includeSceneHint && scene) {
    messages.push({
      role: 'system',
      content: [
        '今回のユーザー発話に対するSceneヒント:',
        `- id: ${scene.id || 'unknown'}`,
        `- description: ${scene.description || ''}`,
        `- embedding_text: ${scene.embedding_text || ''}`,
        `- default_emotions: ${summarizeEmotionMap(scene.default_emotions)}`,
        '',
        'この情報は返答の雰囲気調整とemotion選択用です。',
        'ユーザーにScene名やembedding_textを説明する必要はありません。',
      ].join('\n'),
    });
  }

  // few-shotは口調のアンカーとして強力なので、継続会話でも少しだけ入れる。
  // 全部入れると文脈が膨らむため、既定は1組だけ。
  // FOLLOWUP_FEW_SHOT_COUNT=0 で無効にできる。
  if (fewShotCount > 0 && scene) {
    const limitedScene = {
      ...scene,
      few_shots: Array.isArray(scene.few_shots)
        ? scene.few_shots.slice(0, fewShotCount)
        : [],
    };
    messages.push(...buildFewShotMessages(limitedScene));
  }

  messages.push(
    buildUserMessage({
      userText,
      images,
    })
  );

  return {
    mode: 'followup',
    promptVersion: RAIM_SYSTEM_PROMPT_VERSION,
    messages,
    hasImages: hasImages(images),
    sceneId: scene?.id || '',
  };
}

// ─────────────────────────────────────────────
// 自動切り替え用ビルダー
// ─────────────────────────────────────────────

/**
 * Mantleへ渡す入力を、response_id利用可否に応じて組み立てる。
 *
 * usePreviousResponseId が true:
 *   buildFollowupMantleInput()
 *
 * usePreviousResponseId が false:
 *   buildInitialMantleInput()
 *
 * index.js からは基本的にこの関数を使う。
 */
function buildMantleInput({
  userText,
  images = [],
  sessionSummary = '',
  userMemory = '',
  scene = null,
  usePreviousResponseId = false,
  withTools = false,
}) {
  if (usePreviousResponseId) {
    // 継続モードでは Mantle 側が文脈を保持しているため、
    // 要約や記憶を毎回送り直す必要はない。
    return buildFollowupMantleInput({
      userText,
      images,
      scene,
      withTools,
    });
  }

  return buildInitialMantleInput({
    userText,
    images,
    sessionSummary,
    userMemory,
    scene,
    withTools,
  });
}

// ─────────────────────────────────────────────
// デバッグ表示用サマリ
// ─────────────────────────────────────────────

/**
 * prompt inputの概要をdebug用に整形する。
 *
 * messagesの全文や画像参照情報をレスポンスへ返すと大きすぎるため、
 * 件数やモードだけを返す。
 */
function summarizeMantleInput(input) {
  if (!input || typeof input !== 'object') {
    return null;
  }

  return {
    mode: input.mode,
    promptVersion: input.promptVersion,
    messageCount: Array.isArray(input.messages) ? input.messages.length : 0,
    hasImages: Boolean(input.hasImages),
    sceneId: input.sceneId || '',
  };
}

module.exports = {
  buildSceneContext,
  buildFewShotMessages,
  buildSessionSummaryContext,
  buildUserMemoryContext,
  buildUserContent,
  buildUserMessage,
  buildInitialMantleInput,
  buildFollowupMantleInput,
  buildMantleInput,
  summarizeMantleInput,
};
