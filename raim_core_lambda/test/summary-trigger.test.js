'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldSummarize } = require('../lib/summary-trigger');
const { dispatchSummarization } = require('../lib/summary-dispatcher');

const ON = { SUMMARIZE_ENABLED: 'true' };

// ── 有効/無効 ──────────────────────────────

test('does nothing when summarization is disabled (default)', () => {
  const r = shouldSummarize({ sessionInputTokens: 999999, turnCount: 999 }, {});
  assert.equal(r.shouldSummarize, false);
});

test('enabled only when SUMMARIZE_ENABLED=true', () => {
  const r = shouldSummarize({ sessionInputTokens: 999999, turnCount: 0 }, ON);
  assert.equal(r.shouldSummarize, true);
});

// ── トークン閾値（主軸）────────────────────

test('triggers when the context grows past the threshold', () => {
  const env = { ...ON, SUMMARIZE_TOKEN_THRESHOLD: '8000' };
  assert.equal(shouldSummarize({ sessionInputTokens: 7999, turnCount: 1 }, env).shouldSummarize, false);

  const hit = shouldSummarize({ sessionInputTokens: 8000, turnCount: 1 }, env);
  assert.equal(hit.shouldSummarize, true);
  assert.match(hit.reason, /token_growth/);
});

// ── 往復キャップ（安全弁）──────────────────

test('triggers on turn cap even when tokens are low', () => {
  const env = { ...ON, SUMMARIZE_TOKEN_THRESHOLD: '100000', SUMMARIZE_MAX_TURNS: '20' };
  const hit = shouldSummarize({ sessionInputTokens: 500, turnCount: 20 }, env);
  assert.equal(hit.shouldSummarize, true);
  assert.match(hit.reason, /max_turns/);
});

test('token growth takes priority in the reason', () => {
  const env = { ...ON, SUMMARIZE_TOKEN_THRESHOLD: '8000', SUMMARIZE_MAX_TURNS: '20' };
  const hit = shouldSummarize({ sessionInputTokens: 9000, turnCount: 25 }, env);
  assert.match(hit.reason, /token_growth/);
});

test('does not trigger below both limits', () => {
  const env = { ...ON, SUMMARIZE_TOKEN_THRESHOLD: '8000', SUMMARIZE_MAX_TURNS: '20' };
  assert.equal(shouldSummarize({ sessionInputTokens: 1000, turnCount: 3 }, env).shouldSummarize, false);
});

test('tolerates a missing thread', () => {
  assert.equal(shouldSummarize(null, ON).shouldSummarize, false);
  assert.equal(shouldSummarize({}, ON).shouldSummarize, false);
});

test('accumulates across turns until the threshold is crossed', () => {
  const env = { ...ON, SUMMARIZE_TOKEN_THRESHOLD: '8000', SUMMARIZE_MAX_TURNS: '20' };
  // 継続モードで毎回およそ1800トークン
  let fired = null;
  for (let turn = 1; turn <= 6; turn += 1) {
    const thread = { sessionInputTokens: 1800 * turn, summarizedAtInputTokens: 0, turnCount: turn };
    if (!fired && shouldSummarize(thread, env).shouldSummarize) {
      fired = turn;
    }
  }
  // 1800 × 5 = 9000 で5往復目に発火
  assert.equal(fired, 5);
});

// ── ディスパッチ（SQS）─────────────────────

const QUEUE_ENV = {
  SUMMARY_REQUEST_QUEUE_URL:
    'https://sqs.ap-northeast-1.amazonaws.com/990442281360/raim-summary-request-dev.fifo',
};

test('dispatchSummarization sends a FIFO message with dedup keys', async () => {
  const sent = [];
  const ok = await dispatchSummarization(
    { sub: 'user-1', threadId: 'thread-1', reason: 'token_threshold' },
    { env: QUEUE_ENV, sqsClient: { send: async (cmd) => { sent.push(cmd.input); } } }
  );

  assert.equal(ok, true);
  assert.equal(sent.length, 1);

  // ユーザー単位で順序保証、別ユーザーは並列
  assert.equal(sent[0].MessageGroupId, 'user-1');
  // 同一スレッドの重複依頼を5分ウィンドウで潰す
  assert.equal(sent[0].MessageDeduplicationId, 'user-1:thread-1');

  const body = JSON.parse(sent[0].MessageBody);
  assert.equal(body.type, 'summarize.request');
  assert.equal(body.threadId, 'thread-1');
  assert.equal(body.reason, 'token_threshold');
});

test('dispatchSummarization skips when the queue URL is unset', async () => {
  const ok = await dispatchSummarization(
    { sub: 'u', threadId: 't', reason: 'x' },
    { env: {}, sqsClient: { send: async () => { throw new Error('should not send'); } } }
  );
  assert.equal(ok, false);
});

test('dispatchSummarization never throws on SQS failure', async () => {
  const ok = await dispatchSummarization(
    { sub: 'u', threadId: 't', reason: 'x' },
    {
      env: QUEUE_ENV,
      sqsClient: { send: async () => { throw new Error('AccessDenied'); } },
    }
  );
  // 会話は壊さない。次の往復で再度トリガーされる
  assert.equal(ok, false);
});

test('dispatchSummarization requires sub and threadId', async () => {
  assert.equal(await dispatchSummarization({ sub: '', threadId: 't' }, { env: QUEUE_ENV }), false);
  assert.equal(await dispatchSummarization({ sub: 'u', threadId: '' }, { env: QUEUE_ENV }), false);
});

// usage.input_tokens は履歴込みの累計なので、絶対値ではなく
// 前回要約時からの伸びで判定する。
test('前回要約時からの伸びが閾値に届かなければ要約しない', () => {
  const env = { SUMMARIZE_ENABLED: 'true', SUMMARIZE_TOKEN_THRESHOLD: '8000', SUMMARIZE_MAX_TURNS: '0' };

  const thread = {
    sessionInputTokens: 50000,
    summarizedAtInputTokens: 45000,
    turnCount: 3,
  };

  assert.equal(shouldSummarize(thread, env).shouldSummarize, false);
});

test('前回要約時からの伸びが閾値に届けば要約する', () => {
  const env = { SUMMARIZE_ENABLED: 'true', SUMMARIZE_TOKEN_THRESHOLD: '8000', SUMMARIZE_MAX_TURNS: '0' };

  const thread = {
    sessionInputTokens: 53000,
    summarizedAtInputTokens: 45000,
    turnCount: 3,
  };

  const hit = shouldSummarize(thread, env);
  assert.equal(hit.shouldSummarize, true);
  assert.match(hit.reason, /token_growth \(8000 >= 8000\)/);
});

test('基準点が無い（初回）ときは文脈サイズそのもので判定する', () => {
  const env = { SUMMARIZE_ENABLED: 'true', SUMMARIZE_TOKEN_THRESHOLD: '8000', SUMMARIZE_MAX_TURNS: '0' };

  assert.equal(shouldSummarize({ sessionInputTokens: 7999, turnCount: 1 }, env).shouldSummarize, false);
  assert.equal(shouldSummarize({ sessionInputTokens: 8000, turnCount: 1 }, env).shouldSummarize, true);
});
