'use strict';

// ==============================================================================
// Scene Selector
// ==============================================================================
//
// 【このファイルの役割】
// ユーザーの入力文から、どのSceneを使うかを選択する。
//
// 本来の完成形では、Titan Text Embeddings V2でユーザー発話をEmbeddingし、
// DynamoDBに保存した各Sceneの textCentroid と類似度比較してSceneを選ぶ。
//
// ただし、現時点ではBedrock / Titan連携を後回しにするため、
// 暫定的にキーワードベースでSceneを選択する。
//
// 後でTitanを使えるようになったら、このファイルの中身を
// Embedding類似度方式に差し替える想定。
//
// 【現在の仮仕様】
// - ゲーム系の単語が含まれる → gaming
// - 疲労・不安系の単語が含まれる → tired
// - 冗談・軽口系の単語が含まれる → joke
// - どれにも当てはまらない → default
//
// ==============================================================================

const DEFAULT_SCENE_ID = process.env.DEFAULT_SCENE_ID || 'default';

// ─────────────────────────────────────────────
// キーワード定義
// ─────────────────────────────────────────────
//
// ここでは暫定的に、Sceneごとに代表的なキーワードを並べる。
// 完成版ではTitan Embeddingによる意味的な類似度判定に置き換えるため、
// このキーワード定義はあくまでPoC用。

const SCENE_KEYWORDS = Object.freeze({
  gaming: [
    'lol',
    'LoL',
    'リーグ',
    'レーン',
    '対面',
    'チャンプ',
    'チャンピオン',
    'ビルド',
    'ルーン',
    'ダリウス',
    'パンテオン',
    'ランク',
    '試合',
    'ゲーム',
    '攻略',
    '勝てない',
  ],

  tired: [
    '疲れた',
    'つかれた',
    'しんどい',
    'きつい',
    '眠い',
    '寝不足',
    '不安',
    'つらい',
    '落ち込ん',
    'やる気',
    'だるい',
    '休みたい',
  ],

  joke: [
    '冗談',
    'ネタ',
    '笑',
    '草',
    'w',
    'からか',
    'ふざけ',
    'ボケ',
    'ツッコミ',
  ],
});

// ─────────────────────────────────────────────
// キーワード一致スコア計算
// ─────────────────────────────────────────────
//
// userText にキーワードが含まれていたら加点する。
// 現時点では単純な contains 判定で十分。
// 大文字小文字を吸収するため、比較用に小文字化する。

function calculateKeywordScore(userText, keywords) {
  if (!userText || !Array.isArray(keywords)) {
    return 0;
  }

  const normalizedText = String(userText).toLowerCase();

  let score = 0;

  for (const keyword of keywords) {
    const normalizedKeyword = String(keyword).toLowerCase();

    if (normalizedKeyword && normalizedText.includes(normalizedKeyword)) {
      score += 1;
    }
  }

  return score;
}

// ─────────────────────────────────────────────
// Scene ID選択
// ─────────────────────────────────────────────
//
// ユーザー入力からScene IDだけを選ぶ。
// DynamoDBから取得したScene一覧がまだ手元にない段階でも使える。
//
// 戻り値:
// {
//   sceneId: "gaming",
//   score: 2,
//   reason: "keyword"
// }

function selectSceneIdByKeyword(userText) {
  let bestSceneId = DEFAULT_SCENE_ID;
  let bestScore = 0;

  for (const [sceneId, keywords] of Object.entries(SCENE_KEYWORDS)) {
    const score = calculateKeywordScore(userText, keywords);

    if (score > bestScore) {
      bestSceneId = sceneId;
      bestScore = score;
    }
  }

  return {
    sceneId: bestSceneId,
    score: bestScore,
    reason: bestScore > 0 ? 'keyword' : 'default',
  };
}

// ─────────────────────────────────────────────
// Scene本体選択
// ─────────────────────────────────────────────
//
// scene-repository.js の listScenes() で取得したScene一覧から、
// 選択された sceneId に一致するScene本体を取り出す。
//
// 一致するSceneがDynamoDBに存在しない場合は default Scene にフォールバックする。
// default Sceneもない場合は null を返す。

function selectScene({ userText, scenes }) {
  const selection = selectSceneIdByKeyword(userText);

  if (!Array.isArray(scenes) || scenes.length === 0) {
    return {
      ...selection,
      scene: null,
      fallbackUsed: true,
    };
  }

  const selectedScene =
    scenes.find((scene) => scene.id === selection.sceneId) ||
    scenes.find((scene) => scene.id === DEFAULT_SCENE_ID) ||
    null;

  return {
    ...selection,
    sceneId: selectedScene?.id || selection.sceneId,
    scene: selectedScene,
    fallbackUsed: selectedScene?.id !== selection.sceneId,
  };
}

// ─────────────────────────────────────────────
// デバッグ表示用サマリ
// ─────────────────────────────────────────────
//
// APIレスポンスのdebugに入れやすい形へ整形する。
// few_shotsの中身は大きくなる可能性があるため、件数だけ返す。

function summarizeSceneSelection(selection) {
  if (!selection) {
    return null;
  }

  return {
    sceneId: selection.sceneId,
    score: selection.score,
    reason: selection.reason,
    fallbackUsed: Boolean(selection.fallbackUsed),
    description: selection.scene?.description || '',
    fewShotsCount: Array.isArray(selection.scene?.few_shots)
      ? selection.scene.few_shots.length
      : 0,
    textExamplesCount: Array.isArray(selection.scene?.text_examples)
      ? selection.scene.text_examples.length
      : 0,
  };
}

module.exports = {
  DEFAULT_SCENE_ID,
  SCENE_KEYWORDS,
  calculateKeywordScore,
  selectSceneIdByKeyword,
  selectScene,
  summarizeSceneSelection,
};