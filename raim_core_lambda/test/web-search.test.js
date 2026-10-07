'use strict';

// Web 検索の結果に日付を付ける（時間で変わる事実を古い記事のまま答えないため）

const test = require('node:test');
const assert = require('node:assert/strict');

const { searchWeb, MAX_RESULTS_RETURNED } = require('../lib/tools/web-search');

function fakeTavily(captured, results) {
  return async (url, options) => {
    captured.body = JSON.parse(options.body);
    return {
      ok: true,
      json: async () => ({ query: captured.body.query, answer: '要約', results }),
    };
  };
}

test('asks Tavily for published dates and passes them with the search date', async () => {
  const captured = {};
  const result = await searchWeb('ジェラードン 現在', undefined, 'key', {
    fetch: fakeTavily(captured, [
      { title: '新しい記事', url: 'https://a', content: '2人で活動', published_date: '2025-03-01T09:00:00Z' },
      { title: '古い記事', url: 'https://b', content: '3人組', published_date: null },
    ]),
    now: () => new Date('2026-10-07T05:00:00Z'),
  });

  assert.equal(captured.body.include_published_date, true);
  assert.equal(captured.body.max_results, MAX_RESULTS_RETURNED);
  assert.equal(result.searched_on, '2026-10-07');
  assert.equal(result.summary[0].published_date, '2025-03-01');
  assert.equal(result.summary[1].published_date, null);
});

test('returns up to five results', async () => {
  const captured = {};
  const results = Array.from({ length: 8 }, (_, i) => ({ title: `t${i}`, url: `u${i}`, content: 'c' }));
  const result = await searchWeb('q', undefined, 'key', { fetch: fakeTavily(captured, results) });
  assert.equal(result.summary.length, 5);
});
