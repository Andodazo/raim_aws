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
