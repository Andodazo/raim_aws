'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generateSummary,
  buildSummaryInput,
  formatSummary,
} = require('../lib/summarize-service');

const HISTORY = [
  { role: 'user', content: 'こんにちは。今日は卒業制作で疲れた…' },
  { role: 'assistant', content: 'あ、おつかれ。制作か、大変だね。何作ってるの？' },
  { role: 'user', content: 'AIのコンパニオンアプリ。一人で全部やってる' },
];

test('formatSummary converts facts+relationship JSON into readable text', () => {
  const raw = JSON.stringify({
    facts: ['卒業制作でAIコンパニオンアプリを作っている'],
    relationship: ['疲れているときに弱音をこぼす様子'],
  });
  const text = formatSummary(raw);
  assert.ok(text.includes('【事実】'));
  assert.ok(text.includes('【関係性】'));
  assert.ok(text.includes('弱音をこぼす様子'));
});

test('formatSummary handles facts-only output', () => {
  const text = formatSummary(JSON.stringify({ facts: ['大学生である'] }));
  assert.ok(text.includes('【事実】'));
  assert.ok(!text.includes('【関係性】'));
});

test('formatSummary strips markdown code fences', () => {
  const text = formatSummary('```json\n{"facts":["テスト"]}\n```');
  assert.ok(text.includes('- テスト'));
});

test('formatSummary falls back to raw text when not JSON', () => {
  assert.equal(formatSummary('要約に失敗しました'), '要約に失敗しました');
});

test('buildSummaryInput wraps history as a summarization target', () => {
  const messages = buildSummaryInput(HISTORY, '', 'full');
  const last = messages[messages.length - 1];
  assert.equal(last.role, 'user');
  assert.ok(last.content.includes('以下の会話を要約'));
  assert.ok(last.content.includes('ユーザー:'));
  assert.ok(last.content.includes('ライム:'));
});

test('buildSummaryInput includes previous summary when present', () => {
  const messages = buildSummaryInput(HISTORY, '【事実】\n- 前回の要約', 'full');
  const systemText = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  assert.ok(systemText.includes('これまでの要約'));
});

test('buildSummaryInput uses facts-only instruction in facts mode', () => {
  const full = buildSummaryInput(HISTORY, '', 'full');
  const facts = buildSummaryInput(HISTORY, '', 'facts');
  assert.ok(full[0].content.includes('relationship'));
  assert.ok(!facts[0].content.includes('relationship'));
});

test('generateSummary formats the model output', async () => {
  const result = await generateSummary(
    { history: HISTORY },
    {
      env: { MANTLE_MODEL: 'google.gemma-4-31b' },
      createSummary: async () => ({
        text: JSON.stringify({ facts: ['制作中'], relationship: ['前向きな様子'] }),
        usage: { input_tokens: 100 },
      }),
    }
  );
  assert.ok(result.summary.includes('制作中'));
  assert.equal(result.usage.input_tokens, 100);
});

test('generateSummary passes summary-specific settings to the client', async () => {
  let captured = null;
  await generateSummary(
    { history: HISTORY },
    {
      env: {
        MANTLE_MODEL: 'base-model',
        SUMMARY_MODEL: 'summary-model',
        SUMMARY_REASONING_EFFORT: 'medium',
        SUMMARY_MAX_OUTPUT_TOKENS: '512',
      },
      createSummary: async (params) => {
        captured = params;
        return { text: '{"facts":["x"]}', usage: null };
      },
    }
  );
  assert.equal(captured.model, 'summary-model');
  assert.equal(captured.reasoningEffort, 'medium');
  assert.equal(captured.maxOutputTokens, 512);
});

test('generateSummary returns empty for empty history', async () => {
  const result = await generateSummary({ history: [] }, { env: { MANTLE_MODEL: 'm' } });
  assert.equal(result.summary, '');
});
