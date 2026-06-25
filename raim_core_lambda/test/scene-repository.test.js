'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeScene,
  summarizeScenes,
} = require('../lib/scene-repository');

test('normalizeScene keeps new FewShot table attributes', () => {
  const scene = normalizeScene({
    id: 'joke',
    description: '冗談・からかい・ユーモアの会話',
    embedding_text: '冗談 ジョーク 笑える 面白い',
    default_emotions: {
      happy: 0.5,
      excited: 0.3,
    },
    few_shots: [
      {
        user: '笑わせて',
        raim: 'うーん、無茶振りだなぁ。ふふっ、何のお題？',
        emotions: {
          happy: 0.4,
          embarrassed: 0.3,
        },
      },
    ],
    textCentroid: [0.1, 0.2],
  });

  assert.equal(scene.id, 'joke');
  assert.equal(scene.embedding_text, '冗談 ジョーク 笑える 面白い');
  assert.deepEqual(scene.default_emotions, {
    happy: 0.5,
    excited: 0.3,
  });
  assert.equal(scene.few_shots.length, 1);
  assert.deepEqual(scene.few_shots[0].emotions, {
    happy: 0.4,
    embarrassed: 0.3,
  });
  assert.deepEqual(scene.textCentroid, [0.1, 0.2]);
});

test('summarizeScenes reports whether embedding_text exists', () => {
  const summary = summarizeScenes([
    normalizeScene({
      id: 'joke',
      embedding_text: '冗談 ジョーク',
      few_shots: [],
      textCentroid: [0.1, 0.2],
    }),
    normalizeScene({
      id: 'default',
      few_shots: [],
    }),
  ]);

  assert.equal(summary[0].hasEmbeddingText, true);
  assert.equal(summary[1].hasEmbeddingText, false);
});
