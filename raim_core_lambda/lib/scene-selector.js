'use strict';

// ==============================================================================
// Titan Embedding Scene Selector
// ==============================================================================
//
// 1. Titan Text Embeddings V2でユーザー発話をベクトル化する。
// 2. DynamoDBから取得した各SceneのtextCentroidとコサイン類似度を計算する。
// 3. 類似度が最も高く、閾値以上のSceneを採用する。
// 4. centroid未登録・閾値未満・画像のみの場合はdefault Sceneを採用する。
//
// Titan呼び出しに失敗した場合はdefaultへ黙って落とさず例外を上位へ返す。
// 外部サービス障害を通常のScene選択として隠さず、再試行可能なエラーにするため。
//
// 【Sceneデータ例】
// {
//   id: "gaming",
//   description: "ゲームの相談",
//   textCentroid: [0.01, -0.02, ...],
//   few_shots: [...]
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

function findDefaultScene(scenes) {
  return scenes.find((scene) => scene.id === DEFAULT_SCENE_ID) || null;
}

/**
 * Sceneを確定できない場合の戻り値を統一する。
 * default Scene自体が未登録でもsceneIdはdefaultを返し、scene本体はnullとする。
 */
function createFallbackSelection(scenes, reason, score = null) {
  const scene = findDefaultScene(scenes);

  return {
    sceneId: scene?.id || DEFAULT_SCENE_ID,
    score,
    reason,
    scene,
    fallbackUsed: true,
  };
}

/**
 * ユーザー発話に最も近いSceneを選ぶ。
 *
 * @param {string} userText - 今回のユーザー発話。画像内容は含めない。
 * @param {Array<object>} scenes - DynamoDBから取得・正規化済みのScene一覧。
 * @param {Function} embeddingProvider - 通常はTitan Client。テスト時に差し替え可能。
 * @returns {Promise<object>} Scene本体、類似度、選択理由を含む結果。
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
    return createFallbackSelection(sceneList, 'empty-text');
  }

  // centroidが正しい配列になっているSceneだけを比較対象にする。
  // 次元不一致はTitan呼び出し後に除外し、古いcentroidとの混在を許容する。
  const candidates = sceneList.filter((scene) => isFiniteVector(scene.textCentroid));

  if (candidates.length === 0) {
    return createFallbackSelection(sceneList, 'no-centroid');
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
    return createFallbackSelection(sceneList, 'dimension-mismatch');
  }

  // 最高得点でも閾値未満なら、無理に専門Sceneへ寄せずdefaultを使う。
  if (bestScore < SCENE_SIMILARITY_THRESHOLD) {
    return createFallbackSelection(sceneList, 'below-threshold', bestScore);
  }

  return {
    sceneId: bestScene.id,
    score: bestScore,
    reason: 'titan-cosine',
    scene: bestScene,
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
    description: selection.scene?.description || '',
    fewShotsCount: Array.isArray(selection.scene?.few_shots)
      ? selection.scene.few_shots.length
      : 0,
    // 新形式では `embedding_text` をEmbeddingした結果が `textCentroid` に入る。
    // このフラグで、Scene定義が新形式の代表テキストを持っているか確認できる。
    hasEmbeddingText: typeof selection.scene?.embedding_text === 'string' &&
      selection.scene.embedding_text.trim().length > 0,
    textExamplesCount: Array.isArray(selection.scene?.text_examples)
      ? selection.scene.text_examples.length
      : 0,
  };
}

module.exports = {
  DEFAULT_SCENE_ID,
  SCENE_SIMILARITY_THRESHOLD,
  cosineSimilarity,
  isFiniteVector,
  selectScene,
  summarizeSceneSelection,
};
