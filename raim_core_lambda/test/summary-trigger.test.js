'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { shouldSummarize } = require('../lib/summary-trigger');
const { dispatchSummarization } = require('../lib/summary-dispatcher');

const ON = { SUMMARIZE_ENABLED: 'true' };

// ── 有効/無効 ──────────────────────────────

test('does nothing when summarization is disabled (default)', () => {
  const r = shouldSummarize({ turnCount: 999 }, {});
  assert.equal(r.shouldSummarize, false);
});

test('tolerates a missing thread', () => {
  assert.equal(shouldSummarize(null, ON).shouldSummarize, false);
  assert.equal(shouldSummarize({}, ON).shouldSummarize, false);
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

// ── 往復数で決める ────

test('前の要約から10往復で要約する', () => {
  const env = { SUMMARIZE_ENABLED: 'true' };
  // トークン数はもう見ない（前は SUMMARIZE_TOKEN_THRESHOLD で決めていた）
  assert.equal(
    shouldSummarize({ sessionInputTokens: 999999, turnCount: 9 }, { ...env, SUMMARIZE_TOKEN_THRESHOLD: '8000' }).shouldSummarize,
    false
  );
  const hit = shouldSummarize({ sessionInputTokens: 0, turnCount: 10 }, env);
  assert.equal(hit.shouldSummarize, true);
  assert.match(hit.reason, /every_turns/);
});

test('SUMMARIZE_EVERY_TURNS で往復数を変えられる。0 なら要約しない', () => {
  assert.equal(
    shouldSummarize({ turnCount: 5 }, { SUMMARIZE_ENABLED: 'true', SUMMARIZE_EVERY_TURNS: '5' }).shouldSummarize,
    true
  );
  assert.equal(
    shouldSummarize({ turnCount: 99 }, { SUMMARIZE_ENABLED: 'true', SUMMARIZE_EVERY_TURNS: '0' }).shouldSummarize,
    false
  );
});
