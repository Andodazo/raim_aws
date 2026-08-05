'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  summarizeThread,
  handleSqsEvent,
  handleScheduledEvent,
  refreshUserMemory,
  isSqsEvent,
  isScheduledEvent,
} = require('../index');

const { toSummaryHistory } = require('../lib/conversation-thread-store');

const ENV = { SUMMARIZE_ENABLED: 'true', MANTLE_MODEL: 'm' };

function makeThread(overrides = {}) {
  return {
    sub: 'user-1',
    threadId: 'thread-1',
    title: 'テスト',
    messages: [
      { role: 'user', text: 'こんにちは' },
      { role: 'assistant', text: 'あ、こんにちは' },
    ],
    sessionSummary: '',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

// ── イベント判定 ────────────────────────────

test('isSqsEvent detects SQS records', () => {
  assert.equal(isSqsEvent({ Records: [{ eventSource: 'aws:sqs' }] }), true);
  assert.equal(isSqsEvent({ Records: [] }), false);
  assert.equal(isSqsEvent(null), false);
});

test('isScheduledEvent detects EventBridge schedule', () => {
  assert.equal(isScheduledEvent({ source: 'aws.events' }), true);
  assert.equal(isScheduledEvent({ 'detail-type': 'Scheduled Event' }), true);
  assert.equal(isScheduledEvent({ Records: [] }), false);
});

// ── toSummaryHistory ────────────────────────

test('toSummaryHistory merges text and image description', () => {
  const history = toSummaryHistory([
    { role: 'user', text: 'これ何？', imageDescription: '猫が寝ている写真' },
    { role: 'assistant', text: 'あ、猫だね' },
    { role: 'user', text: '' },            // 空はスキップ
    null,                                   // 不正値もスキップ
  ]);
  assert.equal(history.length, 2);
  assert.ok(history[0].content.includes('これ何？'));
  assert.ok(history[0].content.includes('猫が寝ている写真'));
  assert.equal(history[1].role, 'assistant');
});

test('toSummaryHistory tolerates missing messages', () => {
  assert.deepEqual(toSummaryHistory(undefined), []);
  assert.deepEqual(toSummaryHistory('not an array'), []);
});

// ── summarizeThread ─────────────────────────

test('summarizeThread saves the summary without cutting the Mantle chain', async () => {
  const saved = [];
  const reset = [];

  const result = await summarizeThread(
    { sub: 'user-1', threadId: 'thread-1' },
    {
      env: ENV,
      // まだ文脈は小さい
      getThread: async () => makeThread({ sessionInputTokens: 9000 }),
      generateSummary: async () => ({ summary: '【事実】\n- テスト', usage: null }),
      saveThreadSummary: async (sub, tid, s) => { saved.push({ sub, tid, s }); },
      resetThreadSession: async (sub, tid) => { reset.push({ sub, tid }); },
      updateTitleFromSummary: async () => {},
    }
  );

  assert.equal(result.ok, true);
  assert.equal(saved.length, 1);

  // 30日以内は Mantle が完全な会話を持っているので鎖は切らない
  assert.equal(reset.length, 0);
});

test('summarizeThread cuts the chain once the context grows large', async () => {
  const reset = [];

  await summarizeThread(
    { sub: 'user-1', threadId: 'thread-1' },
    {
      env: { ...ENV, SUMMARY_RESET_TOKEN_THRESHOLD: '150000' },
      // 256K に近づいてきた状態
      getThread: async () => makeThread({ sessionInputTokens: 151000 }),
      generateSummary: async () => ({ summary: 'x', usage: null }),
      saveThreadSummary: async () => {},
      resetThreadSession: async (sub, tid) => { reset.push({ sub, tid }); },
      updateTitleFromSummary: async () => {},
    }
  );

  assert.equal(reset.length, 1);
});

test('summarizeThread never cuts the chain when reset is disabled', async () => {
  const reset = [];

  await summarizeThread(
    { sub: 'user-1', threadId: 'thread-1' },
    {
      env: { ...ENV, SUMMARY_RESET_SESSION: 'false' },
      // 閾値を超えていても切らない
      getThread: async () => makeThread({ sessionInputTokens: 999999 }),
      generateSummary: async () => ({ summary: 'x', usage: null }),
      saveThreadSummary: async () => {},
      resetThreadSession: async () => { reset.push(1); },
      updateTitleFromSummary: async () => {},
    }
  );

  assert.equal(reset.length, 0);
});


test('summarizeThread reports missing thread', async () => {
  const result = await summarizeThread(
    { sub: 'u', threadId: 't' },
    { env: ENV, getThread: async () => null }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'thread_not_found');
});

test('summarizeThread skips threads without messages', async () => {
  const result = await summarizeThread(
    { sub: 'u', threadId: 't' },
    { env: ENV, getThread: async () => makeThread({ messages: [] }) }
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_messages');
});

test('summarizeThread does not save an empty summary', async () => {
  let savedCalled = false;
  const result = await summarizeThread(
    { sub: 'u', threadId: 't' },
    {
      env: ENV,
      getThread: async () => makeThread(),
      generateSummary: async () => ({ summary: '', usage: null }),
      saveThreadSummary: async () => { savedCalled = true; },
    }
  );
  assert.equal(result.ok, false);
  assert.equal(savedCalled, false);
});

test('summarizeThread passes the existing summary for integration', async () => {
  let captured = null;
  await summarizeThread(
    { sub: 'u', threadId: 't' },
    {
      env: ENV,
      getThread: async () => makeThread({ sessionSummary: '【事実】\n- 既存' }),
      generateSummary: async (params) => { captured = params; return { summary: 'x' }; },
      saveThreadSummary: async () => {},
      resetThreadSession: async () => {},
    }
  );
  assert.ok(captured.previousSummary.includes('既存'));
});

// ── SQS ハンドラ ─────────────────────────────

test('handleSqsEvent processes records', async () => {
  const processed = [];
  const result = await handleSqsEvent(
    {
      Records: [
        {
          messageId: 'm1',
          eventSource: 'aws:sqs',
          body: JSON.stringify({ sub: 'u1', threadId: 't1', reason: 'token_threshold' }),
        },
      ],
    },
    {
      env: ENV,
      getThread: async () => makeThread(),
      generateSummary: async () => { processed.push(1); return { summary: 'ok' }; },
      saveThreadSummary: async () => {},
      resetThreadSession: async () => {},
    }
  );
  assert.equal(processed.length, 1);
  assert.deepEqual(result.batchItemFailures, []);
});

test('handleSqsEvent returns only failed records for retry', async () => {
  const result = await handleSqsEvent(
    {
      Records: [
        { messageId: 'ok', eventSource: 'aws:sqs', body: JSON.stringify({ sub: 'u', threadId: 'good' }) },
        { messageId: 'ng', eventSource: 'aws:sqs', body: JSON.stringify({ sub: 'u', threadId: 'bad' }) },
      ],
    },
    {
      env: ENV,
      getThread: async (sub, threadId) => {
        if (threadId === 'bad') throw new Error('DynamoDB down');
        return makeThread();
      },
      generateSummary: async () => ({ summary: 'ok' }),
      saveThreadSummary: async () => {},
      resetThreadSession: async () => {},
    }
  );
  assert.deepEqual(result.batchItemFailures, [{ itemIdentifier: 'ng' }]);
});

test('handleSqsEvent discards malformed bodies without retry', async () => {
  const result = await handleSqsEvent(
    { Records: [{ messageId: 'bad', eventSource: 'aws:sqs', body: 'not json' }] },
    { env: ENV }
  );
  // 再試行しても直らないので failure に入れない（DLQ 行き）
  assert.deepEqual(result.batchItemFailures, []);
});

// ── 週次ハンドラ ─────────────────────────────

test('handleScheduledEvent summarizes idle threads and updates user memory', async () => {
  const memories = [];

  const result = await handleScheduledEvent(
    { source: 'aws.events' },
    {
      env: ENV,
      scanIdleThreads: async () => [
        { sub: 'u1', threadId: 't1', updatedAt: '2026-07-01T00:00:00.000Z' },
      ],
      getThread: async () => makeThread(),
      generateSummary: async () => ({ summary: '【事実】\n- あり' }),
      saveThreadSummary: async () => {},
      resetThreadSession: async () => {},
      listThreads: async () => [{ threadId: 't1', title: 'A', sessionSummary: '【事実】\n- あり' }],
      updateUserMemory: async (sub, m) => { memories.push({ sub, m }); },
    }
  );

  assert.equal(result.summarized, 1);
  assert.equal(result.memoriesUpdated, 1);
  assert.equal(memories.length, 1);
});

test('handleScheduledEvent skips threads already summarized since last update', async () => {
  const result = await handleScheduledEvent(
    { source: 'aws.events' },
    {
      env: ENV,
      scanIdleThreads: async () => [
        {
          sub: 'u1',
          threadId: 't1',
          updatedAt: '2026-07-01T00:00:00.000Z',
          summarizedAt: '2026-07-02T00:00:00.000Z',  // 要約の方が新しい
        },
      ],
      getThread: async () => { throw new Error('should not be called'); },
    }
  );
  assert.equal(result.skipped, 1);
  assert.equal(result.summarized, 0);
});

test('handleScheduledEvent continues after a single thread failure', async () => {
  const result = await handleScheduledEvent(
    { source: 'aws.events' },
    {
      env: ENV,
      scanIdleThreads: async () => [
        { sub: 'u1', threadId: 'bad', updatedAt: '2026-07-01T00:00:00.000Z' },
        { sub: 'u2', threadId: 'good', updatedAt: '2026-07-01T00:00:00.000Z' },
      ],
      getThread: async (sub, threadId) => {
        if (threadId === 'bad') throw new Error('boom');
        return makeThread();
      },
      generateSummary: async () => ({ summary: 'ok' }),
      saveThreadSummary: async () => {},
      resetThreadSession: async () => {},
      listThreads: async () => [{ threadId: 'good', sessionSummary: 'ok' }],
      updateUserMemory: async () => {},
    }
  );
  assert.equal(result.failed, 1);
  assert.equal(result.summarized, 1);   // 1件失敗しても続行
});

// ── userMemory ──────────────────────────────

test('refreshUserMemory aggregates thread summaries', async () => {
  let captured = null;

  const updated = await refreshUserMemory('u1', {
    env: ENV,
    listThreads: async () => [
      { threadId: 't1', title: 'AWSの相談', sessionSummary: '【事実】\n- 移行中' },
      { threadId: 't2', title: '雑談', sessionSummary: '【事実】\n- タピオカ好き' },
      { threadId: 't3', title: '空', sessionSummary: '' },   // 空はスキップ
    ],
    generateSummary: async (params) => { captured = params; return { summary: '統合結果' }; },
    updateUserMemory: async () => {},
  });

  assert.equal(updated, true);
  assert.equal(captured.history.length, 2);
  assert.ok(captured.history[0].content.includes('AWSの相談'));
});


// ── memory.refresh ──────────────────────────

test('memory.refresh rebuilds user memory without needing a threadId', async () => {
  const memories = [];

  const result = await handleSqsEvent(
    {
      Records: [
        {
          messageId: 'm1',
          eventSource: 'aws:sqs',
          // スレッド削除後に Edge から送られる。threadId は無い
          body: JSON.stringify({
            type: 'memory.refresh',
            sub: 'u1',
            reason: 'thread_deleted',
          }),
        },
      ],
    },
    {
      env: ENV,
      // 削除後に残っているスレッドの要約だけを集める
      listThreads: async () => [
        { threadId: 't2', title: '残った会話', sessionSummary: '【事実】\n- 残っている' },
      ],
      generateSummary: async () => ({ summary: '【事実】\n- 残っている' }),
      updateUserMemory: async (sub, m) => { memories.push({ sub, m }); },
      // 要約は呼ばれないはず
      getThread: async () => { throw new Error('should not summarize a thread'); },
    }
  );

  assert.deepEqual(result.batchItemFailures, []);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].sub, 'u1');
  assert.ok(memories[0].m.includes('残っている'));
});

test('memory.refresh is retried when it fails', async () => {
  const result = await handleSqsEvent(
    {
      Records: [
        {
          messageId: 'm1',
          eventSource: 'aws:sqs',
          body: JSON.stringify({ type: 'memory.refresh', sub: 'u1' }),
        },
      ],
    },
    {
      env: ENV,
      listThreads: async () => { throw new Error('DynamoDB down'); },
    }
  );

  assert.deepEqual(result.batchItemFailures, [{ itemIdentifier: 'm1' }]);
});

test('a summarize request without threadId is discarded', async () => {
  // memory.refresh 以外は threadId が必須。無い場合は再試行しても直らない
  const result = await handleSqsEvent(
    {
      Records: [
        { messageId: 'm1', eventSource: 'aws:sqs', body: JSON.stringify({ sub: 'u1' }) },
      ],
    },
    { env: ENV }
  );

  assert.deepEqual(result.batchItemFailures, []);
});

test('refreshUserMemory clears the memory when every thread is deleted', async () => {
  const cleared = [];
  let updateCalled = false;

  // 全スレッドを削除した状態。ここで記憶を消さないと
  // 「会話を全部消したのにライムが覚えている」状態になる
  const updated = await refreshUserMemory('u1', {
    env: ENV,
    listThreads: async () => [],
    clearUserMemory: async (sub) => { cleared.push(sub); },
    updateUserMemory: async () => { updateCalled = true; },
    generateSummary: async () => { throw new Error('should not summarize'); },
  });

  assert.equal(updated, true);
  assert.deepEqual(cleared, ['u1']);
  assert.equal(updateCalled, false);
});

test('refreshUserMemory clears the memory when threads have no summary yet', async () => {
  const cleared = [];

  // スレッドは残っているが、まだ要約が生成されていない場合も
  // 集約する材料が無いので記憶は空にする
  const updated = await refreshUserMemory('u1', {
    env: ENV,
    listThreads: async () => [
      { threadId: 't1', title: '新しい会話', sessionSummary: '' },
    ],
    clearUserMemory: async (sub) => { cleared.push(sub); },
    updateUserMemory: async () => {},
  });

  assert.equal(updated, true);
  assert.deepEqual(cleared, ['u1']);
});
