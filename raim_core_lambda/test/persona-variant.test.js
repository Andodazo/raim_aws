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

test('game talk waits for the user in every prompt (v5.1)', () => {
  // 好きなものがゲームだけだと、何の話でもゲームに結びつけていた
  for (const persona of ['bright', 'downer']) {
    const prompt = buildSystemPrompt({ persona, now: NOW });
    const digest = getPersonaDigest(persona);
    for (const text of [prompt, digest]) {
      assert.ok(text.includes('相手の話をゲームに結びつけない'), persona);
      assert.ok(text.includes('漫画や小説'), persona);
    }
  }
});

test('Raim knows her own profile in every prompt (v5.2)', () => {
  // 展示で「AIだから髪がない」「心の中にだけ姿がある」と答えていた
  for (const persona of ['bright', 'downer']) {
    const prompt = buildSystemPrompt({ persona, now: NOW });
    const digest = getPersonaDigest(persona);
    for (const text of [prompt, digest]) {
      assert.ok(text.includes('画面にイラストの姿で出ている'), persona);
      assert.ok(text.includes('毛先が黄緑') || text.includes('毛先に向かって黄緑'), persona);
      assert.ok(text.includes('12種類'), persona);
      assert.ok(text.includes('「ご主人様」と呼ぶ'), persona);
      assert.ok(text.includes('「Signさん」とは呼ばない'), persona);
      assert.ok(text.includes('4〜5文'), persona);
      assert.ok(text.includes('できるふり'), persona);
      assert.ok(text.includes('一字一句同じ返事'), persona);
    }
    assert.ok(prompt.includes('【ライムのプロフィール'), persona);
    assert.ok(prompt.includes('「髪がない」'), persona);
  }
});

test('the old "keep self-introductions short, never explain your role" rule is gone (v5.2)', () => {
  // この指示どおりに、プレゼンや制作背景への答えが短くあいまいになっていた
  const prompt = buildSystemPrompt({ persona: 'bright', now: NOW });
  assert.ok(!prompt.includes('自分の役割や目的の説明はしない'));
  assert.ok(prompt.includes('ただの「自己紹介して」には短く答える'));
});

test('the first turn of a new conversation treats the user as someone new (v5.2)', () => {
  // デモは来場者全員が同じアカウントなので、記憶を見て「またこんにちは」と返していた
  const prompt = buildSystemPrompt({ persona: 'bright', now: NOW });
  assert.ok(prompt.includes('この会話の1ターン目は、初めて会う人として返す'));
  assert.ok(prompt.includes('記憶に書いてある人と、今話している人が同じとは限らない'));
});
