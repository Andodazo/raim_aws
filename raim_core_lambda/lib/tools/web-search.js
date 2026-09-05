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

'use strict';

const TAVILY_API_URL = 'https://api.tavily.com/search';

// 外部 API の応答を待つ上限
const TOOL_TIMEOUT_MS = Number(process.env.TOOL_TIMEOUT_MS || 8000);

const MAX_RESULT_CONTENT_LENGTH = 200;  // 各結果の content の最大文字数
const MAX_RESULTS_RETURNED = 3;          // LLM に渡す結果の最大件数

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
async function searchWeb(query, maxResults = 3, injectedApiKey = null) {
  // Lambdaでは環境変数へ平文保存せず、Secrets Managerから取得したキーを注入する。
  // ローカル検証用に環境変数フォールバックも残す。
  const apiKey = injectedApiKey || process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error('TAVILY_API_KEY is not configured');
  }
  if (!query || typeof query !== 'string') {
    throw new Error('query is required and must be a string');
  }

  const limit = Math.max(1, Math.min(10, maxResults || 3));

  const requestBody = {
    api_key: apiKey,
    query: query,
    max_results: limit,
    include_answer: true,    // 必須：Tavily 要約取得
  };

  // Node の fetch は既定でタイムアウトしない。
  // 相手が応答しないと Lambda 自身のタイムアウトまで待つことになる。
  const res = await fetch(TAVILY_API_URL, {
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
      content: truncate(r.content || '', MAX_RESULT_CONTENT_LENGTH),
    }));

  return {
    query: data.query || query,
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

module.exports = { searchWeb };