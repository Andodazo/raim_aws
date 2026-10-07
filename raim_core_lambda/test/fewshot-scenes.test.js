'use strict';

// raim_test/fewshot/scenes.json（DynamoDB へ入れる few-shot の元データ）の検証

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { buildFewShotMessages } = require('../lib/prompt-builder');

const SCENES_FILE = path.join(__dirname, '..', '..', 'raim_test', 'fewshot', 'scenes.json');
const EMOTIONS = [
  'neutral', 'happy', 'sad', 'angry', 'surprised', 'caring',
  'embarrassed', 'excited', 'curious', 'amused', 'thoughtful', 'playful',
];

const scenes = JSON.parse(fs.readFileSync(SCENES_FILE, 'utf8')).scenes;

function dominant(emotions) {
  return Object.entries(emotions).sort((a, b) => b[1] - a[1])[0][0];
}

test('every emotion has its own scene, and default exists', () => {
  const targets = scenes.map((s) => s.target).filter(Boolean);
  assert.deepEqual([...targets].sort(), [...EMOTIONS].sort());
  assert.ok(scenes.some((s) => s.id === 'default'));
});

test('the target emotion leads in most examples of its scene', () => {
  for (const scene of scenes.filter((s) => s.target)) {
    const leads = scene.shots
      .flatMap((shot) => [shot.bright, shot.downer])
      .filter((example) => dominant(example.emotions) === scene.target).length;
    assert.ok(leads >= 4, `${scene.id}: ${scene.target} が中心の例が ${leads}/6`);
  }
});

test('only known emotion keys are used', () => {
  for (const scene of scenes) {
    for (const shot of scene.shots) {
      for (const example of [shot.bright, shot.downer]) {
        for (const key of Object.keys(example.emotions)) {
          assert.ok(EMOTIONS.includes(key), `${scene.id}: ${key}`);
        }
      }
    }
  }
});

test('downer examples keep the downer tone', () => {
  for (const scene of scenes) {
    for (const shot of scene.shots) {
      assert.ok(!shot.downer.raim.includes('ふふっ'), `${scene.id}: ${shot.downer.raim}`);
      assert.ok(!shot.downer.raim.includes('！'), `${scene.id}: ${shot.downer.raim}`);
    }
  }
});

test('examples are short enough for TTS', () => {
  for (const scene of scenes) {
    for (const shot of scene.shots) {
      for (const example of [shot.bright, shot.downer]) {
        assert.ok([...example.raim].length <= 45, `${scene.id}: ${example.raim}`);
        assert.ok(!example.raim.includes('\n'));
      }
    }
  }
});

test('scenes turn into few-shot messages for both personas', () => {
  for (const scene of scenes) {
    const item = {
      id: scene.id,
      few_shots: scene.shots.map((s) => ({ user: s.user, ...s.bright })),
      few_shots_downer: scene.shots.map((s) => ({ user: s.user, ...s.downer })),
    };
    assert.equal(buildFewShotMessages(item, 'bright').length, scene.shots.length * 2);
    const downer = buildFewShotMessages(item, 'downer');
    assert.ok(downer[1].content.includes(scene.shots[0].downer.raim));
  }
});

test('every scene has example sentences for its centroid', () => {
  for (const scene of scenes) {
    assert.ok(Array.isArray(scene.embedding_examples), scene.id);
    assert.ok(scene.embedding_examples.length >= 8, `${scene.id}: 例文 ${scene.embedding_examples.length}`);
  }
});

test('check cases cover every scene and are not copies of the examples', () => {
  const casesFile = path.join(__dirname, '..', '..', 'raim_test', 'fewshot', 'check_cases.txt');
  const cases = fs.readFileSync(casesFile, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split('|'));

  const allExamples = new Set(scenes.flatMap((s) => s.embedding_examples));
  const ids = new Set(scenes.map((s) => s.id));
  const covered = new Set();

  for (const [expected, text] of cases) {
    assert.ok(ids.has(expected), `unknown scene: ${expected}`);
    assert.ok(!allExamples.has(text), `例文と同じ文は確認に使わない: ${text}`);
    covered.add(expected);
  }
  assert.deepEqual([...covered].sort(), [...ids].sort());
});

test('greeting examples do not imply an earlier visit', () => {
  // 「今日も話しに来てくれて」を見て、新しい会話でも「また挨拶してくれた」と返していた
  for (const scene of scenes) {
    for (const shot of scene.shots) {
      if (!/こんにちは|おはよう|こんばんは/.test(shot.user)) continue;
      for (const example of [shot.bright, shot.downer]) {
        assert.ok(!/また|今日も|さっき/.test(example.raim), `${scene.id}: ${example.raim}`);
      }
    }
  }
});
