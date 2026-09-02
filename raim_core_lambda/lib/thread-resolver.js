'use strict';

// ==============================================================================
// スレッド解決
// ==============================================================================
//
// 「今回の往復はどのスレッドに属するか」を決める。
//
// 【優先順位】
//
//   1. クライアントが threadId を指定した
//      → そのスレッド（過去スレッドの再開、または明示的な切り替え）
//
//   2. 指定が無く、UserSession に activeThreadId がある
//      → 継続中のスレッド
//
//   3. どちらも無い
//      → 新規スレッドを作る（初回利用、または「新しい会話」を押した直後）
//
// 【UserSession との関係】
//
// UserSession は「今どのスレッドを開いているか（activeThreadId）」だけを持ち、
// 会話の実体は ConversationThread 側にある。
// これによりスレッドを切り替えても UserSession の構造は変わらない。

const {
  createThreadId,
  ensureThread,
  getThread,
  deriveTitle,
  updateThreadTitle,
} = require('./conversation-thread-store');

const {
  getActiveThreadId,
  setActiveThreadId,
} = require('./user-session-store');

/**
 * 今回の往復で使うスレッドを決めて、必要なら作る。
 *
 * @param {Object} params
 * @param {string} params.sub
 * @param {string} [params.requestedThreadId] クライアント指定の threadId
 * @param {string} [params.userText] 新規作成時のタイトル生成に使う
 * @param {Object} [deps] テスト用の差し替え
 * @returns {Promise<{ threadId: string, thread: Object, isNew: boolean }>}
 */
async function resolveThread(
  { sub, requestedThreadId = '', userText = '' },
  deps = {}
) {
  if (!sub) {
    throw new Error('sub is required');
  }

  const ensure = deps.ensureThread || ensureThread;
  const fetch = deps.getThread || getThread;
  const readActive = deps.getActiveThreadId || getActiveThreadId;
  const writeActive = deps.setActiveThreadId || setActiveThreadId;
  const makeId = deps.createThreadId || createThreadId;

  // 1. クライアントが指定したスレッド
  if (requestedThreadId) {
    const existing = await fetch(sub, requestedThreadId);

    if (existing) {
      // アクティブスレッドを切り替える
      await writeActive(sub, requestedThreadId);
      return { threadId: requestedThreadId, thread: existing, isNew: false };
    }

    // 指定されたが存在しない場合は、その ID で作る。
    // クライアントが先に ID を採番する運用にも対応できる。
    const created = await ensure({
      sub,
      threadId: requestedThreadId,
      title: deriveTitle(userText),
    });
    await writeActive(sub, requestedThreadId);
    return { threadId: requestedThreadId, thread: created, isNew: true };
  }

  // 2. 継続中のスレッド
  const activeThreadId = await readActive(sub);

  if (activeThreadId) {
    const existing = await fetch(sub, activeThreadId);

    if (existing) {
      return { threadId: activeThreadId, thread: existing, isNew: false };
    }
    // activeThreadId は残っているが実体が消えている場合は新規作成へ落ちる
  }

  // 3. 新規スレッド
  const threadId = makeId();
  const created = await ensure({
    sub,
    threadId,
    title: deriveTitle(userText),
  });
  await writeActive(sub, threadId);

  return { threadId, thread: created, isNew: true };
}

/**
 * まだ既定タイトルのままのスレッドに、最初の発話からタイトルを付ける。
 *
 * 「新しい会話」が並ぶと一覧で区別できないため。
 * 失敗しても会話には影響しないので、例外は握りつぶす。
 */
async function ensureThreadTitle({ sub, threadId, thread, userText }, deps = {}) {
  if (!sub || !threadId || !userText) {
    return;
  }

  const currentTitle = thread && thread.title;

  if (currentTitle && currentTitle !== '新しい会話') {
    return;
  }

  try {
    const update = deps.updateThreadTitle || updateThreadTitle;
    await update(sub, threadId, deriveTitle(userText));
  } catch (error) {
    console.warn(`[Thread] title update failed (non-fatal): ${error.message}`);
  }
}

module.exports = {
  resolveThread,
  ensureThreadTitle,
};
