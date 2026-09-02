'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveThread, ensureThreadTitle } = require('../lib/thread-resolver');

function makeDeps(overrides = {}) {
  const calls = { ensure: [], active: [] };
  return {
    calls,
    deps: {
      createThreadId: () => 'thread-generated',
      getThread: async () => null,
      ensureThread: async (params) => { calls.ensure.push(params); return { ...params }; },
      getActiveThreadId: async () => '',
      setActiveThreadId: async (sub, threadId) => { calls.active.push({ sub, threadId }); },
      ...overrides,
    },
  };
}

// ── 1. クライアント指定 ──────────────────────

test('uses the thread specified by the client', async () => {
  const { calls, deps } = makeDeps({
    getThread: async (sub, threadId) => ({ sub, threadId, title: '既存' }),
  });

  const result = await resolveThread(
    { sub: 'u', requestedThreadId: 'thread-abc', userText: 'こんにちは' },
    deps
  );

  assert.equal(result.threadId, 'thread-abc');
  assert.equal(result.isNew, false);
  // アクティブスレッドが切り替わる
  assert.deepEqual(calls.active[0], { sub: 'u', threadId: 'thread-abc' });
});

test('creates the thread when the requested id does not exist yet', async () => {
  const { calls, deps } = makeDeps({ getThread: async () => null });

  const result = await resolveThread(
    { sub: 'u', requestedThreadId: 'thread-client-made', userText: 'やあ' },
    deps
  );

  assert.equal(result.threadId, 'thread-client-made');
  assert.equal(result.isNew, true);
  assert.equal(calls.ensure[0].threadId, 'thread-client-made');
});

// ── 2. 継続中のスレッド ──────────────────────

test('falls back to the active thread when no id is specified', async () => {
  const { calls, deps } = makeDeps({
    getActiveThreadId: async () => 'thread-active',
    getThread: async (sub, threadId) => ({ sub, threadId }),
  });

  const result = await resolveThread({ sub: 'u', userText: 'つづき' }, deps);

  assert.equal(result.threadId, 'thread-active');
  assert.equal(result.isNew, false);
  // 既に開いているので切り替えは不要
  assert.equal(calls.active.length, 0);
});

test('creates a new thread when the active thread no longer exists', async () => {
  const { deps } = makeDeps({
    getActiveThreadId: async () => 'thread-deleted',
    getThread: async () => null,
  });

  const result = await resolveThread({ sub: 'u', userText: 'やあ' }, deps);

  assert.equal(result.threadId, 'thread-generated');
  assert.equal(result.isNew, true);
});

// ── 3. 新規スレッド ─────────────────────────

test('creates a new thread on first use', async () => {
  const { calls, deps } = makeDeps();

  const result = await resolveThread({ sub: 'u', userText: 'はじめまして' }, deps);

  assert.equal(result.threadId, 'thread-generated');
  assert.equal(result.isNew, true);
  assert.equal(calls.ensure[0].title, 'はじめまして');
  assert.deepEqual(calls.active[0], { sub: 'u', threadId: 'thread-generated' });
});

test('requires sub', async () => {
  await assert.rejects(() => resolveThread({ sub: '' }), /sub is required/);
});

// ── タイトル付与 ────────────────────────────

test('ensureThreadTitle sets a title for a default-named thread', async () => {
  const updates = [];
  await ensureThreadTitle(
    { sub: 'u', threadId: 't', thread: { title: '新しい会話' }, userText: 'AWSの相談したい' },
    { updateThreadTitle: async (sub, tid, title) => { updates.push(title); } }
  );
  assert.equal(updates.length, 1);
  assert.equal(updates[0], 'AWSの相談したい');
});

test('ensureThreadTitle keeps an existing custom title', async () => {
  const updates = [];
  await ensureThreadTitle(
    { sub: 'u', threadId: 't', thread: { title: '既存タイトル' }, userText: 'x' },
    { updateThreadTitle: async () => { updates.push(1); } }
  );
  assert.equal(updates.length, 0);
});

test('ensureThreadTitle never breaks the conversation on failure', async () => {
  // タイトル更新の失敗は会話に影響させない
  await ensureThreadTitle(
    { sub: 'u', threadId: 't', thread: { title: '新しい会話' }, userText: 'x' },
    { updateThreadTitle: async () => { throw new Error('DynamoDB down'); } }
  );
  assert.ok(true);
});
