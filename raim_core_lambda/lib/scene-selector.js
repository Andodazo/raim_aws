'use strict';

// ==============================================================================
// Titan Embedding Scene Selector
// ==============================================================================
//
// 1. Titan Text Embeddings V2でユーザー発話をベクトル化する。
// 2. DynamoDBから取得した軽量Scene候補のtextCentroidとコサイン類似度を計算する。
// 3. 類似度が最も高く、閾値以上のsceneIdを採用する。
// 4. centroid未登録・閾値未満・画像のみの場合はdefaultのsceneIdを採用する。
//
// Titan呼び出しに失敗した場合はdefaultへ黙って落とさず例外を上位へ返す。
// 外部サービス障害を通常のScene選択として隠さず、再試行可能なエラーにするため。
//
// 【Scene候補データ例】
// {
//   id: "gaming",
//   textCentroid: [0.01, -0.02, ...]
// }
//
// textCentroidは、FewShotテーブルの `embedding_text` をTitanでEmbeddingした代表ベクトル。
// ユーザー発話も同じmodel/dimensionsでEmbeddingしないと比較できない。
//
// 【fallback reason】
// - empty-text: 画像だけで、Scene判定に使うテキストがない
// - no-centroid: 比較可能なcentroidが1件も登録されていない
// - dimension-mismatch: Titan出力とcentroidの次元が一致しない
// - below-threshold: 最良Sceneでも類似度が採用閾値に届かない
// ==============================================================================

const { createTitanEmbedding } = require('./titan-embedding-client');

const DEFAULT_SCENE_ID = process.env.DEFAULT_SCENE_ID || 'default';
const QUESTION_SCENE_ID = process.env.QUESTION_SCENE_ID || 'question';

// 質問の形の発話。閾値に届かなかったときだけ question Scene に寄せる。
//
// Titan のベクトルは「何の話題か」で近さが決まるため、「ブラックホールって何？」と
// 「光合成ってどういう仕組み？」は形が同じ質問でも遠くなり、例文を足しても
// question Scene の類似度が上がらない（2026-10 実測で 0.14〜0.17）。
// 形で判断する方が確実なので、ここだけルールで拾う。
// raim_test/test_scene_selection.js にも同じパターンがある（変えるときは両方直す）。
const QUESTION_PATTERN = /(って(何|なに)|とは[？?]?$|なんで|なぜ|どうして|どういう(意味|こと|仕組み)|の意味|(何|なん)て言う|どれくらい|いくつ|何(キロ|メートル|グラム|年|人|時)|教えて)/;
const QUESTION_EXCLUDE_PATTERN = /天気|気温/;

function isQuestionForm(text) {
  const value = String(text || '');
  return QUESTION_PATTERN.test(value) && !QUESTION_EXCLUDE_PATTERN.test(value);
}
const SCENE_SIMILARITY_THRESHOLD = Number(
  process.env.SCENE_SIMILARITY_THRESHOLD || 0.25
);

if (!Number.isFinite(SCENE_SIMILARITY_THRESHOLD) ||
    SCENE_SIMILARITY_THRESHOLD < -1 ||
    SCENE_SIMILARITY_THRESHOLD > 1) {
  throw new Error('SCENE_SIMILARITY_THRESHOLD must be between -1 and 1');
}

function isFiniteVector(vector) {
  return Array.isArray(vector) &&
    vector.length > 0 &&
    vector.every((value) => Number.isFinite(value));
}

/**
 * ベクトルの大きさに左右されず意味方向の近さを比較する。
 * 1に近いほど類似、0付近は無関係、負数は反対方向を示す。
 */
function cosineSimilarity(left, right) {
  if (!isFiniteVector(left) || !isFiniteVector(right) || left.length !== right.length) {
    return null;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return null;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

/**
 * Sceneを確定できない場合の戻り値を統一する。
 * ここではDynamoDBからScene詳細を取得しない。
 * 選択結果としてsceneIdだけを返し、詳細取得はscene-repository.jsに任せる。
 */
function createFallbackSelection(reason, score = null) {
  return {
    sceneId: DEFAULT_SCENE_ID,
    score,
    reason,
    fallbackUsed: true,
  };
}

/**
 * ユーザー発話に最も近いsceneIdを選ぶ。
 *
 * @param {string} userText - 今回のユーザー発話。画像内容は含めない。
 * @param {Array<object>} scenes - DynamoDBから取得した軽量Scene候補一覧。
 * @param {Function} embeddingProvider - 通常はTitan Client。テスト時に差し替え可能。
 * @returns {Promise<object>} sceneId、類似度、選択理由を含む結果。
 */
async function selectScene({
  userText,
  scenes,
  embeddingProvider = createTitanEmbedding,
}) {
  const sceneList = Array.isArray(scenes) ? scenes : [];
  const text = String(userText || '').trim();

  // 1. 画像のみの入力ではテキストEmbeddingを行わず、defaultを使用する。
  if (!text) {
    return createFallbackSelection('empty-text');
  }

  // centroidが正しい配列になっているSceneだけを比較対象にする。
  // 次元不一致はTitan呼び出し後に除外し、古いcentroidとの混在を許容する。
  const candidates = sceneList.filter((scene) => isFiniteVector(scene.textCentroid));

  if (candidates.length === 0) {
    return createFallbackSelection('no-centroid');
  }

  // 2. ユーザー発話をTitanで1回だけEmbeddingする。
  // Sceneごとに呼ぶ必要はなく、保存済みcentroidとローカル計算で比較する。
  const embeddingResult = await embeddingProvider(text);
  const queryEmbedding = Array.isArray(embeddingResult)
    ? embeddingResult
    : embeddingResult?.embedding;

  if (!isFiniteVector(queryEmbedding)) {
    throw new Error('Titan embedding provider returned an invalid vector');
  }

  // 3. 次元が一致する全候補とコサイン類似度を計算し、最高得点を保持する。
  let bestScene = null;
  let bestScore = -Infinity;

  for (const scene of candidates) {
    const score = cosineSimilarity(queryEmbedding, scene.textCentroid);

    if (score !== null && score > bestScore) {
      bestScene = scene;
      bestScore = score;
    }
  }

  // 全centroidが古い次元だった場合。誤比較せずdefaultへ戻す。
  if (!bestScene) {
    return createFallbackSelection('dimension-mismatch');
  }

  // 最高得点でも閾値未満なら、無理に専門Sceneへ寄せずdefaultを使う。
  // ただし質問の形なら question Scene にする（上の QUESTION_PATTERN を参照）。
  if (bestScore < SCENE_SIMILARITY_THRESHOLD) {
    const hasQuestionScene = candidates.some((scene) => scene.id === QUESTION_SCENE_ID);
    if (hasQuestionScene && isQuestionForm(text)) {
      return {
        sceneId: QUESTION_SCENE_ID,
        score: bestScore,
        reason: 'question-form',
        fallbackUsed: false,
      };
    }
    return createFallbackSelection('below-threshold', bestScore);
  }

  return {
    sceneId: bestScene.id,
    score: bestScore,
    reason: 'titan-cosine',
    fallbackUsed: false,
  };
}

function summarizeSceneSelection(selection) {
  if (!selection) {
    return null;
  }

  return {
    sceneId: selection.sceneId,
    score: Number.isFinite(selection.score) ? selection.score : null,
    reason: selection.reason,
    fallbackUsed: Boolean(selection.fallbackUsed),
  };
}

module.exports = {
  DEFAULT_SCENE_ID,
  QUESTION_SCENE_ID,
  QUESTION_PATTERN,
  isQuestionForm,
  SCENE_SIMILARITY_THRESHOLD,
  cosineSimilarity,
  isFiniteVector,
  selectScene,
  summarizeSceneSelection,
};
