'use strict';

// 崩れた要約 JSON を読む（Gemma が配列の閉じ括弧を落とすことがある）

const test = require('node:test');
const assert = require('node:assert/strict');

const { formatSummary, parseSummaryJson } = require('../lib/summarize-service');

test('reads the broken JSON seen on 2026-10-07 (missing ] before })', () => {
  const raw = '{"facts": ["ユーザーの名前は葵である", "家でチャーハンを食べた"], "relationship": ["リラックスして接している様子。"}';
  assert.equal(
    formatSummary(raw),
    '【事実】\n- ユーザーの名前は葵である\n- 家でチャーハンを食べた\n\n【関係性】\n- リラックスして接している様子。'
  );
});

test('valid JSON is unchanged', () => {
  assert.equal(formatSummary('{"facts": ["A"], "relationship": ["B"]}'), '【事実】\n- A\n\n【関係性】\n- B');
});

test('output cut off at the end is closed and read', () => {
  assert.deepEqual(parseSummaryJson('{"facts": ["A", "B"], "relationship": ["C"'), {
    facts: ['A', 'B'],
    relationship: ['C'],
  });
});

test('brackets inside strings are not counted', () => {
  assert.deepEqual(parseSummaryJson('{"facts": ["} を含む", "[ も"]}'), { facts: ['} を含む', '[ も'] });
});

test('plain text without JSON is kept as is', () => {
  assert.equal(formatSummary('【事実】\n- そのまま'), '【事実】\n- そのまま');
  assert.equal(parseSummaryJson('JSONではない'), null);
});
