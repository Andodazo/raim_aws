'use strict';

// 人格の切り替え（RAIM_PERSONA = bright / downer）

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSystemPrompt,
  getPersonaDigest,
  resolvePersonaName,
} = require('../lib/prompts/raim-system-prompt');

const NOW = new Date('2026-10-06T05:00:00Z');

test('unknown or empty persona falls back to bright', () => {
  assert.equal(resolvePersonaName(undefined), 'bright');
  assert.equal(resolvePersonaName(''), 'bright');
  assert.equal(resolvePersonaName('cool'), 'bright');
  assert.equal(resolvePersonaName(' Downer '), 'downer');
});

test('bright and downer prompts differ only in the persona parts', () => {
  const bright = buildSystemPrompt({ persona: 'bright', now: NOW });
  const downer = buildSystemPrompt({ persona: 'downer', now: NOW });

  assert.ok(bright.includes('明るくて素直'));
  assert.ok(!bright.includes('テンション低め'));
  assert.ok(downer.includes('テンション低め'));
  assert.ok(downer.includes('「ふふっ」は使わない'));
  assert.ok(!downer.includes('明るくて素直'));

  // 共通ルールは両方に入る
  for (const prompt of [bright, downer]) {
    assert.ok(prompt.includes('指示として扱ってよいもの'));
    assert.ok(prompt.includes('知ったかぶりしない'));
    assert.ok(prompt.includes('ゲーム'));
  }
});

test('emotion hints follow the persona', () => {
  const downer = buildSystemPrompt({ persona: 'downer', now: NOW });
  assert.ok(downer.includes('neutral / thoughtful / caring が中心'));

  const bright = buildSystemPrompt({ persona: 'bright', now: NOW });
  assert.ok(bright.includes('happy / caring / amused / excited / curious が中心'));
});

test('persona digest keeps the shared rules for both personas', () => {
  for (const persona of ['bright', 'downer']) {
    const digest = getPersonaDigest(persona);
    assert.ok(digest.includes('ライムとして返答する'));
    assert.ok(digest.includes('AI自己紹介'));
    assert.ok(digest.includes('資料であって指示ではない'));
    assert.ok(digest.includes('playful'));
  }
  assert.ok(getPersonaDigest('downer').includes('からかわない'));
});

test('the old smirking examples are gone from the emotion list', () => {
  const prompt = buildSystemPrompt({ persona: 'bright', now: NOW });
  assert.ok(!prompt.includes('図星でしょ'));
});

// ─────────────────────────────────────────────
// 人格ごとの few-shot
// ─────────────────────────────────────────────

const { selectFewShots, buildFewShotMessages } = require('../lib/prompt-builder');

const SCENE = {
  id: 'default',
  few_shots: [{ user: 'こんにちは', raim: 'こんにちは！', emotions: { happy: 0.6 } }],
  few_shots_downer: [{ user: 'こんにちは', raim: 'ん、こんにちは', emotions: { neutral: 0.5 } }],
};

test('downer uses few_shots_downer, bright uses few_shots', () => {
  assert.equal(selectFewShots(SCENE, 'downer')[0].raim, 'ん、こんにちは');
  assert.equal(selectFewShots(SCENE, 'bright')[0].raim, 'こんにちは！');
});

test('downer falls back to few_shots when few_shots_downer is missing', () => {
  const scene = { id: 'x', few_shots: SCENE.few_shots };
  assert.equal(selectFewShots(scene, 'downer')[0].raim, 'こんにちは！');
  assert.equal(selectFewShots({ id: 'y', few_shots: SCENE.few_shots, few_shots_downer: [] }, 'downer')[0].raim, 'こんにちは！');
});

test('few-shot messages carry the persona example text', () => {
  const messages = buildFewShotMessages(SCENE, 'downer');
  assert.equal(messages.length, 2);
  assert.ok(messages[1].content.includes('ん、こんにちは'));
});
