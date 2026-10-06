'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cosineSimilarity,
  selectScene,
} = require('../lib/scene-selector');

test('cosineSimilarity compares vector direction', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([1, 0], [1]), null);
});

test('selectScene uses Titan embedding and chooses the nearest centroid', async () => {
  const scenes = [
    { id: 'default', textCentroid: [0, 1] },
    { id: 'gaming', textCentroid: [1, 0] },
  ];
  const result = await selectScene({
    userText: 'ゲームの相談',
    scenes,
    embeddingProvider: async () => ({ embedding: [0.9, 0.1] }),
  });

  assert.equal(result.sceneId, 'gaming');
  assert.equal(result.reason, 'titan-cosine');
  assert.equal(result.fallbackUsed, false);
});

test('selectScene falls back to default when centroids are not registered', async () => {
  const result = await selectScene({
    userText: 'hello',
    scenes: [{ id: 'default', textCentroid: null }],
    embeddingProvider: async () => {
      throw new Error('must not be called');
    },
  });

  assert.equal(result.sceneId, 'default');
  assert.equal(result.reason, 'no-centroid');
});

// ─────────────────────────────────────────────
// 閾値未満でも質問の形なら question Scene
// ─────────────────────────────────────────────

const fsForQuestion = require('node:fs');
const pathForQuestion = require('node:path');
const { isQuestionForm, QUESTION_PATTERN } = require('../lib/scene-selector');

test('question form is detected for knowledge questions', () => {
  for (const text of ['ブラックホールって何？', 'なんで空は青いの？', 'サブスクってどういう意味？', 'りんごって英語で何て言う？']) {
    assert.ok(isQuestionForm(text), text);
  }
  for (const text of ['こんにちは', '今日バイトで疲れた', '明日の天気教えて']) {
    assert.ok(!isQuestionForm(text), text);
  }
});

test('below-threshold question goes to the question scene', async () => {
  const scenes = [
    { id: 'default', textCentroid: [0, 1] },
    { id: 'question', textCentroid: [0.1, 0.995] },
  ];
  // どちらとも遠い（類似度が閾値未満）ベクトル
  const embeddingProvider = async () => [1, -0.05];

  const question = await selectScene({ userText: 'ブラックホールって何？', scenes, embeddingProvider });
  assert.equal(question.sceneId, 'question');
  assert.equal(question.reason, 'question-form');

  const chat = await selectScene({ userText: 'ねえねえ', scenes, embeddingProvider });
  assert.equal(chat.sceneId, 'default');
  assert.equal(chat.reason, 'below-threshold');
});

test('without a question scene the rule is skipped', async () => {
  const scenes = [{ id: 'default', textCentroid: [0, 1] }];
  const result = await selectScene({
    userText: 'ブラックホールって何？',
    scenes,
    embeddingProvider: async () => [1, -0.05],
  });
  assert.equal(result.sceneId, 'default');
});

test('the CloudShell tester uses the same question pattern', () => {
  const tester = fsForQuestion.readFileSync(
    pathForQuestion.join(__dirname, '..', '..', 'raim_test', 'test_scene_selection.js'),
    'utf8'
  );
  assert.ok(tester.includes(String(QUESTION_PATTERN)), 'test_scene_selection.js のパターンが Lambda とずれている');
});
