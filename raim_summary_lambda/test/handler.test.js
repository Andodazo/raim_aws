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

test('summarizeThread saves the summary and never cuts a Mantle chain', async () => {
  const saved = [];

  const result = await summarizeThread(
    { sub: 'user-1', threadId: 'thread-1' },
    {
      // 以前は文脈が15万トークンを超えたら鎖を切っていた。もう切らない
      env: { ...ENV, SUMMARY_RESET_TOKEN_THRESHOLD: '150000' },
      getThread: async () => makeThread({ sessionInputTokens: 151000 }),
      getForgottenMemories: async () => [],
      generateSummary: async () => ({ summary: '【事実】\n- テスト', usage: null }),
      saveThreadSummary: async (sub, tid, s) => { saved.push({ sub, tid, s }); },
      updateTitleFromSummary: async () => {},
    }
  );

  assert.equal(result.ok, true);
  assert.equal(saved.length, 1);
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
      getForgottenMemories: async () => [],
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
      getForgottenMemories: async () => [],
      generateSummary: async (params) => { captured = params; return { summary: 'x' }; },
      saveThreadSummary: async () => {},
    }
  );
  assert.ok(captured.previousSummary.includes('既存'));
});

test('summarizeThread passes the current title only when it came from a summary', async () => {
  const run = async (thread) => {
    let captured = null;
    let titleOption = null;
    await summarizeThread(
      { sub: 'u', threadId: 't' },
      {
        env: ENV,
        getThread: async () => makeThread(thread),
        getForgottenMemories: async () => [],
        generateSummary: async (params) => { captured = params; return { summary: '【事実】\n- x', title: 'カフェ巡り' }; },
        saveThreadSummary: async () => {},
        updateTitleFromSummary: async (sub, tid, summary, d, options) => { titleOption = options; },
      }
    );
    return { captured, titleOption };
  };

  // 要約から付けた題名は渡す
  const fromSummary = await run({ title: '卒業制作', titleSource: 'summary' });
  assert.equal(fromSummary.captured.currentTitle, '卒業制作');
  assert.deepEqual(fromSummary.titleOption, { title: 'カフェ巡り' });

  // 最初の発言から仮に付けた題名（「こんにちは」など）は渡さない
  const fromMessage = await run({ title: 'こんにちは', titleSource: 'message' });
  assert.equal(fromMessage.captured.currentTitle, '');
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
      getForgottenMemories: async () => [],
      generateSummary: async () => { processed.push(1); return { summary: 'ok' }; },
      saveThreadSummary: async () => {},
      refreshUserMemory: async () => true,
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
      getForgottenMemories: async () => [],
      generateSummary: async () => ({ summary: 'ok' }),
      saveThreadSummary: async () => {},
      refreshUserMemory: async () => true,
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

// ── 要約のあとの記憶の作り直し ───────────────

function sqsRecord(body, messageId = 'm1') {
  return { messageId, eventSource: 'aws:sqs', body: JSON.stringify(body) };
}

test('handleSqsEvent rebuilds user memory after a thread summary is saved', async () => {
  // 以前は SQS の要約ではスレッドの要約だけを保存し、記憶は週次と削除のときしか
  // 作り直さなかったので、テスト中はずっと記憶が空だった
  const memories = [];
  const result = await handleSqsEvent(
    { Records: [sqsRecord({ sub: 'u1', threadId: 't1', reason: 'thread_switch' })] },
    {
      env: ENV,
      getThread: async () => makeThread(),
      getForgottenMemories: async () => [],
      generateSummary: async () => ({ summary: '【事実】\n- 猫を飼っている' }),
      saveThreadSummary: async () => {},
      updateTitleFromSummary: async () => {},
      getMemoryGeneration: async () => 3,
      listThreads: async () => [
        { threadId: 't1', title: '猫の話', sessionSummary: '【事実】\n- 猫を飼っている' },
      ],
      updateUserMemory: async (sub, memory, opts) => { memories.push({ sub, memory, opts }); },
    }
  );

  assert.deepEqual(result.batchItemFailures, []);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].sub, 'u1');
  assert.ok(memories[0].memory.includes('猫'));
  // 作り直している間にスレッドが消されたら書き戻さない
  assert.equal(memories[0].opts.expectedGeneration, 3);
});

test('handleSqsEvent does not rebuild user memory when nothing was summarized', async () => {
  let refreshed = false;
  const result = await handleSqsEvent(
    { Records: [sqsRecord({ sub: 'u1', threadId: 't1' })] },
    {
      env: ENV,
      getThread: async () => null,
      refreshUserMemory: async () => { refreshed = true; return true; },
    }
  );

  assert.deepEqual(result.batchItemFailures, []);
  assert.equal(refreshed, false);
});

test('a failed memory rebuild after a summary is not retried', async () => {
  // 再試行すると保存済みの要約をもう一度作ることになる。次の要約か週次で作り直す
  let summaries = 0;
  const result = await handleSqsEvent(
    { Records: [sqsRecord({ sub: 'u1', threadId: 't1' })] },
    {
      env: ENV,
      getThread: async () => makeThread(),
      getForgottenMemories: async () => [],
      generateSummary: async () => { summaries += 1; return { summary: 'ok' }; },
      saveThreadSummary: async () => {},
      updateTitleFromSummary: async () => {},
      refreshUserMemory: async () => { throw new Error('DynamoDB down'); },
    }
  );

  assert.deepEqual(result.batchItemFailures, []);
  assert.equal(summaries, 1);
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
      getForgottenMemories: async () => [],
      generateSummary: async () => ({ summary: '【事実】\n- あり' }),
      saveThreadSummary: async () => {},
      getMemoryGeneration: async () => null,
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
      getForgottenMemories: async () => [],
      generateSummary: async () => ({ summary: 'ok' }),
      saveThreadSummary: async () => {},
      getMemoryGeneration: async () => null,
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
    getMemoryGeneration: async () => null,
    listThreads: async () => [
      { threadId: 't1', title: 'AWSの相談', sessionSummary: '【事実】\n- 移行中' },
      { threadId: 't2', title: '雑談', sessionSummary: '【事実】\n- タピオカ好き' },
      { threadId: 't3', title: '空', sessionSummary: '' },   // 空はスキップ
    ],
    getForgottenMemories: async () => [],
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
      getMemoryGeneration: async () => null,
      listThreads: async () => [
        { threadId: 't2', title: '残った会話', sessionSummary: '【事実】\n- 残っている' },
      ],
      getForgottenMemories: async () => [],
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
      getMemoryGeneration: async () => null,
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
    getMemoryGeneration: async () => null,
    listThreads: async () => [],
    clearUserMemory: async (sub) => { cleared.push(sub); },
    updateUserMemory: async () => { updateCalled = true; },
    getForgottenMemories: async () => [],
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
    getMemoryGeneration: async () => null,
    listThreads: async () => [
      { threadId: 't1', title: '新しい会話', sessionSummary: '' },
    ],
    clearUserMemory: async (sub) => { cleared.push(sub); },
    updateUserMemory: async () => {},
  });

  assert.equal(updated, true);
  assert.deepEqual(cleared, ['u1']);
});

// ── 記憶の世代番号 ─────────────────────────────

test('refreshUserMemory saves only if the memory generation is unchanged', async () => {
  const saved = [];
  const updated = await refreshUserMemory('u1', {
    getMemoryGeneration: async () => 3,
    listThreads: async (sub, options) => {
      // 削除の直後に読むので強い整合性で読む
      assert.equal(options.consistentRead, true);
      return [{ threadId: 't1', title: 'A', sessionSummary: '要約' }];
    },
    getForgottenMemories: async () => [],
    generateSummary: async () => ({ summary: '記憶' }),
    updateUserMemory: async (sub, memory, options) => {
      saved.push({ sub, memory, options });
    },
  });

  assert.equal(updated, true);
  assert.deepEqual(saved, [{ sub: 'u1', memory: '記憶', options: { expectedGeneration: 3 } }]);
});

test('refreshUserMemory does not write back when a thread was deleted meanwhile', async () => {
  const updated = await refreshUserMemory('u1', {
    getMemoryGeneration: async () => 3,
    listThreads: async () => [{ threadId: 't1', title: 'A', sessionSummary: '要約' }],
    getForgottenMemories: async () => [],
    generateSummary: async () => ({ summary: '古い記憶' }),
    updateUserMemory: async () => {
      const error = new Error('changed');
      error.name = 'MemoryGenerationChangedError';
      throw error;
    },
  });

  assert.equal(updated, false);
});

// ── 要約中にスレッドが消された ───────────────────

test('summarizeThread stops without recreating a thread deleted meanwhile', async () => {
  let titleUpdated = false;
  const result = await summarizeThread({ sub: 'u1', threadId: 't1' }, {
    getThread: async () => ({
      threadId: 't1',
      messages: [
        { role: 'user', text: 'こんにちは' },
        { role: 'assistant', text: 'やあ' },
      ],
    }),
    getForgottenMemories: async () => [],
    generateSummary: async () => ({ summary: '要約' }),
    saveThreadSummary: async () => {
      const error = new Error('deleted');
      error.name = 'ThreadDeletedError';
      throw error;
    },
    updateTitleFromSummary: async () => { titleUpdated = true; },
  });

  assert.deepEqual(result, { ok: false, reason: 'thread_deleted' });
  assert.equal(titleUpdated, false);
});

// ── 利用者が消した項目 ───────────────────────

test('summarizeThread passes the forgotten items so they are not written again', async () => {
  let captured = null;
  await summarizeThread(
    { sub: 'user-1', threadId: 'thread-1' },
    {
      env: ENV,
      getThread: async () => makeThread(),
      getForgottenMemories: async () => ['猫を飼っている'],
      generateSummary: async (params) => { captured = params; return { summary: 'x' }; },
      saveThreadSummary: async () => {},
      updateTitleFromSummary: async () => {},
    }
  );
  assert.deepEqual(captured.forgotten, ['猫を飼っている']);
});

test('summarizeThread still summarizes when the forgotten items cannot be read', async () => {
  let captured = null;
  const result = await summarizeThread(
    { sub: 'user-1', threadId: 'thread-1' },
    {
      env: ENV,
      getThread: async () => makeThread(),
      getForgottenMemories: async () => { throw new Error('dynamo down'); },
      generateSummary: async (params) => { captured = params; return { summary: 'x' }; },
      saveThreadSummary: async () => {},
      updateTitleFromSummary: async () => {},
    }
  );
  assert.equal(result.ok, true);
  assert.deepEqual(captured.forgotten, []);
});

test('refreshUserMemory builds the memory with the memory instruction', async () => {
  let captured;
  await refreshUserMemory('u1', {
    env: ENV,
    getMemoryGeneration: async () => 1,
    listThreads: async () => [{ threadId: 't1', title: 'a', sessionSummary: '【事実】\n- 猫を飼っている' }],
    getForgottenMemories: async () => [],
    generateSummary: async (input) => { captured = input; return { summary: '【事実】\n- 猫を飼っている' }; },
    updateUserMemory: async () => {},
  });
  assert.equal(captured.purpose, 'memory');
});
