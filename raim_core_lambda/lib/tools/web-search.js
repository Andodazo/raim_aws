// lib/tools/web-search.js
// ==============================================================================
// Tavily API を使った Web 検索ツール（v2 サマリ最適化版）
// ==============================================================================
//
// 【v2 での変更点】
// - LLM に渡す結果を簡潔に整形
//   - answer フィールドを最優先
//   - results は title + content の要点のみ、URL は省略可能（トークン節約）
// - LLM が「結果を読みきれない」問題を解消
//
// 【設計判断】
// Tavily の生レスポンスは情報密度高すぎる:
// - results 配列に5〜10件、各 content が長い
// - 全部 LLM に渡すと「読むのが面倒」で無視される傾向
//
// 対策:
// - answer がある場合はそれを最優先（Tavily が既に要約してくれてる）
// - results はトップ3件、各 content は冒頭 200文字でカット
//
// 【v3 での変更点】記事の日付を付ける
// 「ジェラードンは今何人？」のように、時間で変わる事実を古い記事のまま答えていた
// （2026-10 のテスト。2025年に1人抜けて2人組なのに、検索しても「トリオ」と答えた）。
// - include_published_date で各記事の公開日を受け取り、published_date として渡す
// - 調べた日（searched_on）も渡し、どれくらい古い情報か比べられるようにする
// - 新しい記事も拾えるよう、渡す件数を3件→5件にする

'use strict';

const TAVILY_API_URL = 'https://api.tavily.com/search';

// 外部 API の応答を待つ上限
const TOOL_TIMEOUT_MS = Number(process.env.TOOL_TIMEOUT_MS || 8000);

const MAX_RESULT_CONTENT_LENGTH = 200;  // 各結果の content の最大文字数
const MAX_RESULTS_RETURNED = 5;          // LLM に渡す結果の最大件数

// 調べた日（日本時間の YYYY-MM-DD）
function todayInJapan(now = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(now);
}

// Tavily の published_date を YYYY-MM-DD にそろえる。分からなければ null
function toDateOnly(value) {
  if (!value) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * Tavily で Web 検索を実行
 *
 * @param {string} query 検索クエリ
 * @param {number} maxResults 最大結果件数（デフォルト3）
 * @returns {Promise<Object>} {
 *   query: string,
 *   answer: string | null,      // Tavily の要約（最優先）
 *   summary: Array,             // 簡潔化された結果リスト
 * }
 */
async function searchWeb(query, maxResults = MAX_RESULTS_RETURNED, injectedApiKey = null, deps = {}) {
  // Lambdaでは環境変数へ平文保存せず、Secrets Managerから取得したキーを注入する。
  // ローカル検証用に環境変数フォールバックも残す。
  const apiKey = injectedApiKey || process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error('TAVILY_API_KEY is not configured');
  }
  if (!query || typeof query !== 'string') {
    throw new Error('query is required and must be a string');
  }

  const limit = Math.max(1, Math.min(10, maxResults || MAX_RESULTS_RETURNED));

  const requestBody = {
    api_key: apiKey,
    query: query,
    max_results: limit,
    include_answer: true,    // 必須：Tavily 要約取得
    include_published_date: true, // 各記事の公開日（分からなければ null）
  };

  // Node の fetch は既定でタイムアウトしない。
  // 相手が応答しないと Lambda 自身のタイムアウトまで待つことになる。
  const fetchImpl = deps.fetch || fetch;
  const res = await fetchImpl(TAVILY_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(TOOL_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Tavily API error: ${res.status} ${errText}`);
  }

  const data = await res.json();

  // 結果を整形（LLM に読みやすく）
  // 1. answer があれば最優先
  // 2. results はトップ3件、content は冒頭 200文字
  const summaryResults = (data.results || [])
    .slice(0, MAX_RESULTS_RETURNED)
    .map((r, idx) => ({
      rank: idx + 1,
      title: r.title || '(無題)',
      // 記事の公開日。null は「日付が分からない」（古い情報の可能性がある）
      published_date: toDateOnly(r.published_date),
      content: truncate(r.content || '', MAX_RESULT_CONTENT_LENGTH),
    }));

  return {
    query: data.query || query,
    searched_on: todayInJapan(deps.now ? deps.now() : new Date()),
    // Tavily の要約。古い記事から作られていることもあるので、summary の日付と見比べる
    answer: data.answer || null,
    summary: summaryResults,
    // 内部用：オリジナルの URL は履歴記録時に使えるよう保持
    _results_urls: (data.results || []).slice(0, MAX_RESULTS_RETURNED).map(r => r.url),
  };
}

function truncate(text, max) {
  if (!text || text.length <= max) return text;
  return text.slice(0, max) + '…';
}

module.exports = { searchWeb, MAX_RESULTS_RETURNED };