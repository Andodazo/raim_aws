#!/usr/bin/env node
/**
 * Bedrock Mantle: システムプロンプトの渡し方 検証スクリプト
 *
 * ============================================================================
 * 目的
 * ============================================================================
 *
 * Core Lambda は現在、システムプロンプト（ライムの人格・12感情ルール）を
 * input 配列の `role: 'system'` メッセージとして渡している。
 *
 * しかし Lambda の実行結果では、
 *   - 人格ルール（AI的自己紹介の禁止）が守られない
 *   - 12感情の使い分けが行われず単一感情になる
 * という症状が出ている。
 *
 * 一方で JSON 形式では返ってくる。これは few-shot の assistant 例
 * （JSON 文字列）を真似ただけで説明がつく。
 *
 * つまり「system ロールだけが Mantle に無視されているのでは」という仮説を
 * 検証する。
 *
 * ============================================================================
 * 検証方法
 * ============================================================================
 *
 * 従いやすく、かつ普通は絶対にやらない指示を与える。
 *
 *   「返答の先頭に必ず [OK] と付ける」
 *
 * これが出力に現れれば、その渡し方でシステムプロンプトが届いている。
 * 現れなければ無視されている。
 *
 * 3パターンを比較する。
 *
 *   A. input 配列に role:'system' を入れる    ← Core Lambda の現在の実装
 *   B. instructions パラメータで渡す          ← Responses API の本来の形
 *   C. input 配列に role:'developer' を入れる ← OpenAI の新しい呼び方
 *
 * ============================================================================
 * 実行手順（CloudShell）
 * ============================================================================
 *
 *   export OPENAI_API_KEY='長期キー'
 *   node test_mantle_system.js
 *
 * リージョンを変えたい場合:
 *
 *   export OPENAI_BASE_URL='https://bedrock-mantle.us-east-1.api.aws/openai/v1'
 *
 * ※ Lambda と条件を揃えるなら、Lambda の OPENAI_BASE_URL と同じ値にすること。
 */

'use strict';

const DEFAULT_BASE_URL = 'https://bedrock-mantle.us-east-1.api.aws/openai/v1';
const DEFAULT_MODEL = 'google.gemma-4-31b';

// 従いやすいが、指示がなければ絶対に出ない目印。
const MARKER = '[OK]';

const SYSTEM_PROMPT = [
  'あなたは「ライム」という友達キャラクターです。',
  '',
  '【最重要ルール】',
  '返答の先頭に必ず ' + MARKER + ' と付けてください。例外はありません。',
  '',
  '【口調】',
  '- タメ口で話す',
  '- 「私はAIです」のような自己紹介は絶対にしない',
].join('\n');

const USER_TEXT = 'こんにちは。今日はどんな一日だった？';

function baseUrl() {
  const url = process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
  return url.replace(/\/$/, '');
}

function apiKey() {
  const key = process.env.OPENAI_API_KEY || '';
  if (!key) {
    throw new Error('OPENAI_API_KEY is required');
  }
  return key;
}

function model() {
  return process.env.MANTLE_MODEL || DEFAULT_MODEL;
}

async function callResponses(label, requestBody) {
  const url = `${baseUrl()}/responses`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  const text = await response.text();

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${label}`);
  console.log(`${'─'.repeat(60)}`);
  console.log(`HTTP status : ${response.status}`);

  if (!response.ok) {
    console.log('レスポンス:');
    console.log(text.slice(0, 800));
    return { ok: false, output: '' };
  }

  const payload = JSON.parse(text);

  // instructions が echo されるか（＝サーバーが認識したか）も確認する。
  console.log(`instructions: ${payload.instructions === null ? 'null' : JSON.stringify(String(payload.instructions).slice(0, 40)) + '...'}`);

  // 出力テキストを取り出す
  let output = '';
  for (const item of payload.output || []) {
    if (item.type === 'message') {
      for (const part of item.content || []) {
        if (typeof part.text === 'string') output += part.text;
      }
    }
  }

  console.log(`出力        : ${output || '(なし)'}`);

  const followed = output.includes(MARKER);
  console.log(`判定        : ${followed ? `✓ ${MARKER} あり → システムプロンプトが届いている` : `✗ ${MARKER} なし → 無視されている`}`);

  return { ok: true, output, followed };
}

async function main() {
  console.log('Bedrock Mantle システムプロンプト検証');
  console.log(`  baseUrl : ${baseUrl()}`);
  console.log(`  model   : ${model()}`);
  console.log(`  marker  : ${MARKER}`);

  const common = {
    model: model(),
    max_output_tokens: 256,
    reasoning: { effort: 'none' },
  };

  const results = {};

  // A: input 配列の role:'system'（Core Lambda の現在の実装）
  results.A = await callResponses(
    'A. input 配列に role:"system"（Core Lambda の現在の方式）',
    {
      ...common,
      input: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: USER_TEXT },
      ],
    }
  );

  // B: instructions パラメータ（Responses API の本来の形）
  results.B = await callResponses(
    'B. instructions パラメータで渡す',
    {
      ...common,
      instructions: SYSTEM_PROMPT,
      input: [{ role: 'user', content: USER_TEXT }],
    }
  );

  // C: input 配列の role:'developer'
  results.C = await callResponses(
    'C. input 配列に role:"developer"',
    {
      ...common,
      input: [
        { role: 'developer', content: SYSTEM_PROMPT },
        { role: 'user', content: USER_TEXT },
      ],
    }
  );

  console.log(`\n${'═'.repeat(60)}`);
  console.log('結論');
  console.log(`${'═'.repeat(60)}`);

  for (const [key, label] of [
    ['A', 'input role:system  （現在の実装）'],
    ['B', 'instructions       （本来の形）  '],
    ['C', 'input role:developer             '],
  ]) {
    const r = results[key];
    const mark = !r.ok ? 'エラー' : r.followed ? '✓ 届いた' : '✗ 無視された';
    console.log(`  ${key}. ${label} : ${mark}`);
  }

  console.log('');

  if (results.A.followed) {
    console.log('現在の実装で問題ありません。');
    console.log('口調が崩れる原因はシステムプロンプトの渡し方ではなく、');
    console.log('モデルの指示追従性（reasoning:none の影響など）を疑ってください。');
  } else if (results.B.followed || results.C.followed) {
    console.log('現在の実装（role:system）は無視されています。');
    const better = results.B.followed ? 'instructions パラメータ' : 'role:developer';
    console.log(`${better} へ切り替える必要があります。`);
    console.log('mantle-client.js と prompt-builder.js の修正が必要です。');
  } else {
    console.log('どの方式でも指示が守られませんでした。');
    console.log('モデル側の指示追従性の問題の可能性があります。');
    console.log('reasoning の effort を low へ上げて再試行してみてください。');
  }
}

main().catch((error) => {
  console.error('\nERROR');
  console.error(`  ${error.message}`);
  process.exit(1);
});
