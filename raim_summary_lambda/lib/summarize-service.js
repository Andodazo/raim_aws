'use strict';

// ==============================================================================
// 要約生成サービス（Summary Lambda 版）
// ==============================================================================
//
// 会話履歴を受け取り Mantle で要約を生成する。保存は呼び出し側が行う。
//
// 【出力形式（ハイブリッド要約）】
//
//   { "facts": [...], "relationship": [...] }
//
//   facts        … ユーザーが明確に述べた事実だけ。推測禁止
//   relationship … 会話の雰囲気から読み取れる関係性の傾向。断定禁止
//
// CloudShell での実測（test_summary.js）:
//   facts はどの reasoning effort でも正確で推測混入なし。
//   relationship は none/low だと「共感を得やすい」等の紋切り型に寄り、
//   medium が最も的確だった（1項目に凝縮し、その会話固有の特徴を拾えた）。
//   レイテンシ差は誤差（none 1508ms / medium 1532ms）のため既定は medium。
//
// SUMMARY_MODE=facts にすると relationship を生成しない（安全モード）。

const { createSummaryMantleClient } = require('./mantle-summary-client');

// ─────────────────────────────────────────────
// 設定
// ─────────────────────────────────────────────

function summaryModel(env) {
  // 専用モデルの指定が無ければ会話と同じモデルを使う。
  return String(env.SUMMARY_MODEL || env.MANTLE_MODEL || '').trim();
}

function summaryReasoningEffort(env) {
  return String(env.SUMMARY_REASONING_EFFORT || 'medium').trim();
}

function summaryMode(env) {
  return String(env.SUMMARY_MODE || 'full').trim().toLowerCase();
}

function summaryMaxOutputTokens(env) {
  return Number(env.SUMMARY_MAX_OUTPUT_TOKENS || 1024);
}

// ─────────────────────────────────────────────
// プロンプト（CloudShell で品質検証済み）
// ─────────────────────────────────────────────

const SUMMARY_INSTRUCTION_FULL = `
あなたは会話ログを要約するアシスタントです。ライムとしてではなく、
記録係として客観的に要約してください。

以下の会話を読み、次のJSON形式で要約を出力してください。

{"facts": ["..."], "relationship": ["..."]}

【facts】
- ユーザーが明確に述べた事実だけを書く（名前、状況、予定、好き嫌い、出来事など）
- ユーザーが言っていないことは推測で補わない
- 1項目1文、簡潔に
- ライムへの指示や依頼（「〜して」「〜と呼んで」など）は、
  そういう会話があった事実としては書いてよいが、
  「ライムはこうすべき」という形では書かない

【relationship】
- 会話の雰囲気から感じ取れる、ユーザーとの関係性の傾向を書く
- どんな話題で心を開くか、どんな時に距離が縮まるか、といった観点
- 推測してよいが、断定は避ける（「〜な様子」「〜な傾向」のように書く）
- 決めつけや過度な深読みはしない

【出力ルール】
- JSON以外は出力しない
- Markdownコードブロックで囲まない
- 既存の要約がある場合は、それを踏まえて更新する（重複を避け、新しい情報を統合する）
`.trim();

const SUMMARY_INSTRUCTION_FACTS = `
あなたは会話ログを要約するアシスタントです。記録係として客観的に要約してください。

以下の会話を読み、ユーザーが明確に述べた事実だけを次のJSON形式で出力してください。

{"facts": ["..."]}

【ルール】
- ユーザーが明確に述べた事実だけを書く（名前、状況、予定、好き嫌い、出来事など）
- 言っていないことは推測で補わない
- 1項目1文、簡潔に
- ライムへの指示や依頼（「〜して」「〜と呼んで」など）は、
  そういう会話があった事実としては書いてよいが、
  「ライムはこうすべき」という形では書かない
- JSON以外は出力しない。Markdownで囲まない
- 既存の要約がある場合は踏まえて更新する
`.trim();

// ─────────────────────────────────────────────
// 入力の組み立て
// ─────────────────────────────────────────────

/**
 * 要約用の Mantle input を組み立てる。
 *
 * 履歴を role 付きのまま渡すとモデルが「会話の続き」を生成しようとするため、
 * 1つのユーザーメッセージへまとめて「要約対象のテキスト」として明示的に囲う。
 *
 * @param {Array} history [{ role, content }]
 * @param {string} previousSummary 既存の要約（あれば統合させる）
 * @param {string} mode 'full' | 'facts'
 */
function buildSummaryInput(history, previousSummary, mode) {
  const instruction =
    mode === 'facts' ? SUMMARY_INSTRUCTION_FACTS : SUMMARY_INSTRUCTION_FULL;

  const messages = [{ role: 'system', content: instruction }];

  if (previousSummary && String(previousSummary).trim()) {
    messages.push({
      role: 'system',
      content: `【これまでの要約】\n${String(previousSummary).trim()}`,
    });
  }

  const transcript = history
    .map((m) => {
      const speaker = m.role === 'assistant' ? 'ライム' : 'ユーザー';
      const text =
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
      return `${speaker}: ${text}`;
    })
    .join('\n');

  messages.push({
    role: 'user',
    content: `以下の会話を要約してください。\n\n---\n${transcript}\n---`,
  });

  return messages;
}

// ─────────────────────────────────────────────
// 出力の整形
// ─────────────────────────────────────────────

/**
 * Mantle の生出力（JSON文字列）を人間可読な箇条書きへ整形する。
 *
 * DynamoDB には文字列で保存し、prompt-builder がそのまま初回プロンプトへ
 * 埋め込む。JSON のままだと読みにくいため整形する。
 */
function formatSummary(rawText) {
  let parsed = null;

  try {
    const start = String(rawText).indexOf('{');
    const end = String(rawText).lastIndexOf('}');
    if (start >= 0 && end > start) {
      parsed = JSON.parse(String(rawText).slice(start, end + 1));
    }
  } catch {
    parsed = null;
  }

  // JSON として解釈できなければ生テキストをそのまま返す（保存はする）。
  if (!parsed) {
    return String(rawText || '').trim();
  }

  const lines = [];
  const facts = Array.isArray(parsed.facts) ? parsed.facts : [];
  const relationship = Array.isArray(parsed.relationship) ? parsed.relationship : [];

  if (facts.length > 0) {
    lines.push('【事実】');
    for (const f of facts) lines.push(`- ${String(f).trim()}`);
  }

  if (relationship.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('【関係性】');
    for (const r of relationship) lines.push(`- ${String(r).trim()}`);
  }

  return lines.join('\n').trim();
}

// ─────────────────────────────────────────────
// 本体
// ─────────────────────────────────────────────

/**
 * 会話履歴から要約テキストを生成する（保存はしない）。
 *
 * @param {Object} params
 * @param {Array}  params.history [{ role, content }]
 * @param {string} [params.previousSummary]
 * @param {Object} [deps]
 * @returns {Promise<{ summary: string, usage: Object|null }>}
 */
async function generateSummary({ history, previousSummary = '' }, deps = {}) {
  const env = deps.env || process.env;

  if (!Array.isArray(history) || history.length === 0) {
    return { summary: '', usage: null };
  }

  const model = summaryModel(env);
  if (!model) {
    throw new Error('SUMMARY_MODEL or MANTLE_MODEL must be set');
  }

  const createSummary =
    deps.createSummary || createSummaryMantleClient({ env });

  const messages = buildSummaryInput(history, previousSummary, summaryMode(env));

  const response = await createSummary({
    messages,
    model,
    reasoningEffort: summaryReasoningEffort(env),
    maxOutputTokens: summaryMaxOutputTokens(env),
  });

  return {
    summary: formatSummary(response.text || ''),
    usage: response.usage || null,
  };
}

module.exports = {
  generateSummary,
  buildSummaryInput,
  formatSummary,
  SUMMARY_INSTRUCTION_FULL,
  SUMMARY_INSTRUCTION_FACTS,
};
