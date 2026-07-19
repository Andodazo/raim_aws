'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { normalizeMantleOutput } = require('../lib/response-validator');

// ─────────────────────────────────────────────
// v13: 12感情 + 正規化 + overall_intensity
// ─────────────────────────────────────────────

test('normalizes emotions map into ratios summing to 1.0', () => {
  const output = normalizeMantleOutput(JSON.stringify({
    text: 'ふふっ、気になるね',
    emotions: { curious: 1.0, amused: 0.5 },
  }));

  assert.equal(output.type, 'chat');

  // 合計1.5 → 比率へ正規化（1.0/1.5, 0.5/1.5）
  assert.ok(Math.abs(output.emotions.curious - 0.667) < 0.01);
  assert.ok(Math.abs(output.emotions.amused - 0.333) < 0.01);

  const sum = Object.values(output.emotions).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1.0) < 0.001);

  // 合計が1.0を超える場合、全体強度は1.0でクランプされる
  assert.equal(output.overall_intensity, 1);

  // 後方互換: ドミナント感情 × 全体強度
  assert.equal(output.emotion, 'curious');
  assert.ok(Math.abs(output.intensity - 0.667) < 0.01);
});

test('keeps weak emotion as low overall_intensity instead of shrinking the ratio', () => {
  const output = normalizeMantleOutput(JSON.stringify({
    text: 'うーん…',
    emotions: { thoughtful: 0.3 },
  }));

  // 単一感情なので比率は1.0、強さだけが0.3として残る
  assert.deepEqual(output.emotions, { thoughtful: 1 });
  assert.equal(output.overall_intensity, 0.3);
  assert.equal(output.emotion, 'thoughtful');
  assert.ok(Math.abs(output.intensity - 0.3) < 0.001);
});

test('accepts the new 12-emotion vocabulary', () => {
  for (const name of ['curious', 'amused', 'thoughtful', 'playful']) {
    const output = normalizeMantleOutput(JSON.stringify({
      text: 'ふふっ',
      emotions: { [name]: 0.8 },
    }));

    assert.equal(output.emotion, name, `${name} should be allowed`);
  }
});

test('drops unknown emotion keys and falls back to neutral when none remain', () => {
  const output = normalizeMantleOutput(JSON.stringify({
    text: 'なにそれ',
    emotions: { unknown_emotion: 0.9 },
  }));

  assert.deepEqual(output.emotions, { neutral: 1 });
  assert.equal(output.emotion, 'neutral');
});

test('still accepts the legacy single-emotion output format', () => {
  const output = normalizeMantleOutput(JSON.stringify({
    text: 'やあ',
    emotion: 'happy',
    intensity: 0.6,
  }));

  // 旧形式でもemotions Mapへ変換され、クライアントは新旧どちらでも読める
  assert.deepEqual(output.emotions, { happy: 1 });
  assert.equal(output.overall_intensity, 0.6);
  assert.equal(output.emotion, 'happy');
  assert.equal(output.intensity, 0.6);
});

test('rounds emotion ratios to 3 decimals for compact transmission', () => {
  // 0.5 / 0.9 = 0.5555555555555556 のような長い小数を避ける
  const output = normalizeMantleOutput(JSON.stringify({
    text: 'ふふっ、またまた挨拶だね',
    emotions: { amused: 0.5, curious: 0.4 },
  }));

  assert.equal(output.emotions.amused, 0.556);
  assert.equal(output.emotions.curious, 0.444);
  assert.equal(output.overall_intensity, 0.9);

  // 後方互換フィールドも丸める
  assert.equal(output.intensity, 0.5);

  // 丸めた値をJSONにしても桁が増えない
  const json = JSON.stringify(output);
  assert.ok(!/\d\.\d{5,}/.test(json), `長い小数が残っている: ${json}`);
});

test('rounding keeps the ratio sum close enough to 1.0', () => {
  const output = normalizeMantleOutput(JSON.stringify({
    text: 'テスト',
    emotions: { happy: 1, caring: 1, curious: 1 },
  }));

  const sum = Object.values(output.emotions).reduce((a, b) => a + b, 0);

  // 3等分は 0.333 × 3 = 0.999 になる。表情表現には影響しない範囲。
  assert.ok(Math.abs(sum - 1.0) <= 0.002, `合計が離れすぎ: ${sum}`);
});
