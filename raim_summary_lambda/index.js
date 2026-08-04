'use strict';

// ==============================================================================
// RAiM Summary Lambda
// ==============================================================================
//
// 会話の要約を生成して DynamoDB へ保存する専用 Lambda。
// Core Lambda を要約処理で重くしないため分離している。
//
// 【2つのトリガー】
//
//   1. SQS（Summary Request Queue）… Core Lambda からの即時依頼
//      トークン数が閾値を超えた時点で Core が投げる。
//      担当するのは「長くなったスレッドの圧縮」。
//
//   2. EventBridge（週次）… 取りこぼしの回収
//      a. 放置スレッドの要約
//         閾値に届かないまま会話が止まったスレッドは SQS 経由では
//         永遠に要約されない。週次で拾う。
//      b. userMemory の更新
//         各スレッドの要約を集約し「この人はどんな人か」を作る。
//         スレッドを跨いだ記憶はバッチ処理が向いている。
//      c. response_id 失効前の保険
//         Mantle の保持期間は30日。週次なら4回チャンスがある。
//
// 【安全装置】
//
//   SUMMARIZE_ENABLED（既定 false）が true でない限り何もしない。
//   配線が完成するまで本番で暴発させないため。

const { generateSummary } = require('./lib/summarize-service');
const {
  getThread,
  listThreads,
  scanIdleThreads,
  saveThreadSummary,
  resetThreadSession,
  toSummaryHistory,
  updateTitleFromSummary,
} = require('./lib/conversation-thread-store');
const { updateUserMemory } = require('./lib/user-memory-store');

// ─────────────────────────────────────────────
// 設定
// ─────────────────────────────────────────────

/// ユーザー記憶の再生成を要求するメッセージ種別
///
/// スレッド削除後に Edge Lambda から送られる。
/// 要約の生成（既定）と違い threadId を必要としない。
const MEMORY_REFRESH_TYPE = 'memory.refresh';

function isEnabled(env) {
  return String(env.SUMMARIZE_ENABLED || 'false').trim().toLowerCase() === 'true';
}

function idleDays(env) {
  return Number(env.SUMMARY_IDLE_DAYS || 7);
}

function weeklyLimit(env) {
  // 1回の週次実行で処理する上限。暴走とタイムアウトの防止。
  return Number(env.SUMMARY_WEEKLY_LIMIT || 50);
}

function shouldResetSession(env) {
  // 要約後に lastResponseId をクリアして初回モードへ戻すか。
  // 初回モードでは人格全文 + few-shot + 要約が送られるため、
  // 履歴の積み上がりがリセットされつつ文脈は引き継がれる。
  return String(env.SUMMARY_RESET_SESSION || 'true').trim().toLowerCase() === 'true';
}

// ─────────────────────────────────────────────
// 1スレッドの要約
// ─────────────────────────────────────────────

/**
 * 指定スレッドを要約して保存する。
 *
 * SQS 経由でも週次バッチでも、最終的にここへ来る。
 *
 * @returns {Promise<{ ok: boolean, reason?: string, summary?: string }>}
 */
async function summarizeThread({ sub, threadId }, deps = {}) {
  const env = deps.env || process.env;

  const thread = await (deps.getThread || getThread)(sub, threadId);

  if (!thread) {
    return { ok: false, reason: 'thread_not_found' };
  }

  const history = toSummaryHistory(thread.messages);

  if (history.length === 0) {
    return { ok: false, reason: 'no_messages' };
  }

  const { summary } = await (deps.generateSummary || generateSummary)(
    { history, previousSummary: thread.sessionSummary || '' },
    { env }
  );

  if (!summary) {
    // 空要約で既存を潰さない。
    return { ok: false, reason: 'empty_summary' };
  }

  await (deps.saveThreadSummary || saveThreadSummary)(sub, threadId, summary);

  // 要約からタイトルを付け直す。
  //
  // 作成時のタイトルは最初の発話をそのまま切ったものなので、
  // 挨拶から始まる会話だと一覧が「こんにちは」だらけになる。
  // 要約は既に生成済みなので、ここでの LLM 呼び出しは発生しない。
  await (deps.updateTitleFromSummary || updateTitleFromSummary)(sub, threadId, summary);

  if (shouldResetSession(env)) {
    await (deps.resetThreadSession || resetThreadSession)(sub, threadId);
  }

  console.log(
    `[Summary] thread summarized: sub=${sub} threadId=${threadId} chars=${summary.length}`
  );

  return { ok: true, summary };
}

// ─────────────────────────────────────────────
// SQS ハンドラ
// ─────────────────────────────────────────────

/**
 * Summary Request Queue からの依頼を処理する。
 *
 * 部分失敗は batchItemFailures で返し、失敗したメッセージだけ再試行させる。
 * 全体を throw するとバッチ内の成功分まで再処理されてしまう。
 */
async function handleSqsEvent(event, deps = {}) {
  const env = deps.env || process.env;
  const batchItemFailures = [];

  for (const record of event.Records || []) {
    let payload;

    try {
      payload = JSON.parse(record.body);
    } catch {
      // JSON でないメッセージは再試行しても直らないので捨てる（DLQ 行き）。
      console.error(`[Summary] invalid message body: ${record.messageId}`);
      continue;
    }

    const { type, sub, threadId, reason } = payload;

    if (!sub) {
      console.error(`[Summary] missing sub: ${record.messageId}`);
      continue;
    }

    // ユーザー記憶の再生成だけを行う要求。
    //
    // スレッドを削除したときに使う。削除したスレッドの内容は
    // userMemory へ既に取り込まれているため、残っているスレッドの
    // 要約から作り直さないと「消したのにライムが覚えている」状態になる。
    const isMemoryRefresh = type === MEMORY_REFRESH_TYPE;

    if (!isMemoryRefresh && !threadId) {
      console.error(`[Summary] missing threadId: ${record.messageId}`);
      continue;
    }

    try {
      if (isMemoryRefresh) {
        const updated = await refreshUserMemory(sub, { ...deps, env });
        console.log(
          `[Summary] memory refreshed: sub=${sub} reason=${reason || '-'} updated=${updated}`
        );
      } else {
        const result = await summarizeThread({ sub, threadId }, { ...deps, env });
        console.log(
          `[Summary] sqs processed: sub=${sub} threadId=${threadId} ` +
          `reason=${reason || '-'} ok=${result.ok} ${result.reason || ''}`
        );
      }
    } catch (error) {
      // 一時的な障害の可能性があるので再試行させる。
      console.error(
        `[Summary] sqs failed (will retry): ${record.messageId} ${error.message}`
      );
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }

  return { batchItemFailures };
}

// ─────────────────────────────────────────────
// EventBridge ハンドラ（週次）
// ─────────────────────────────────────────────

/**
 * 放置スレッドを要約し、ユーザー記憶を更新する。
 */
async function handleScheduledEvent(event, deps = {}) {
  const env = deps.env || process.env;

  const threads = await (deps.scanIdleThreads || scanIdleThreads)({
    idleDays: idleDays(env),
    limit: weeklyLimit(env),
  });

  console.log(`[Summary] weekly scan: ${threads.length} idle threads`);

  let summarized = 0;
  let skipped = 0;
  let failed = 0;

  // 要約が更新されたユーザーだけ userMemory を作り直す。
  const touchedSubs = new Set();

  for (const thread of threads) {
    const { sub, threadId } = thread;

    // 前回の要約以降にメッセージが増えていなければスキップ。
    // 週次で同じスレッドを繰り返し要約しないため。
    if (thread.summarizedAt && thread.updatedAt <= thread.summarizedAt) {
      skipped += 1;
      continue;
    }

    try {
      const result = await summarizeThread({ sub, threadId }, { ...deps, env });
      if (result.ok) {
        summarized += 1;
        touchedSubs.add(sub);
      } else {
        skipped += 1;
      }
    } catch (error) {
      failed += 1;
      // 1件の失敗で週次バッチ全体を止めない。
      console.error(
        `[Summary] weekly thread failed: sub=${sub} threadId=${threadId} ${error.message}`
      );
    }
  }

  // スレッド跨ぎの記憶（userMemory）を更新する。
  let memoriesUpdated = 0;

  for (const sub of touchedSubs) {
    try {
      const updated = await refreshUserMemory(sub, { ...deps, env });
      if (updated) memoriesUpdated += 1;
    } catch (error) {
      console.error(`[Summary] userMemory failed: sub=${sub} ${error.message}`);
    }
  }

  const result = { summarized, skipped, failed, memoriesUpdated };
  console.log(`[Summary] weekly done: ${JSON.stringify(result)}`);

  return result;
}

/**
 * あるユーザーの全スレッド要約を集約して userMemory を作る。
 *
 * これがスレッドを跨いだ記憶の本体。
 * 「別の会話で話したこと」をライムが覚えている状態を作る。
 */
async function refreshUserMemory(sub, deps = {}) {
  const env = deps.env || process.env;

  // messages は不要（各スレッドの要約だけ集める）。
  const threads = await (deps.listThreads || listThreads)(sub, {
    includeMessages: false,
  });

  const summaries = threads
    .filter((t) => t.sessionSummary && String(t.sessionSummary).trim())
    .map((t) => ({
      role: 'user',
      content: `【${t.title || 'スレッド'}】\n${t.sessionSummary}`,
    }));

  if (summaries.length === 0) {
    return false;
  }

  // スレッド要約たちを入力として、さらに1段圧縮する。
  // summarize-service は「既存要約があれば統合」に対応しているため、
  // 入力を会話ログからスレッド要約へ差し替えるだけで流用できる。
  const { summary } = await (deps.generateSummary || generateSummary)(
    { history: summaries, previousSummary: '' },
    { env }
  );

  if (!summary) {
    return false;
  }

  await (deps.updateUserMemory || updateUserMemory)(sub, summary);

  console.log(
    `[Summary] userMemory updated: sub=${sub} threads=${summaries.length} chars=${summary.length}`
  );

  return true;
}

// ─────────────────────────────────────────────
// イベント判定
// ─────────────────────────────────────────────

function isSqsEvent(event) {
  return Boolean(
    event &&
    Array.isArray(event.Records) &&
    event.Records.length > 0 &&
    event.Records[0].eventSource === 'aws:sqs'
  );
}

function isScheduledEvent(event) {
  return Boolean(
    event &&
    (event.source === 'aws.events' ||
      event['detail-type'] === 'Scheduled Event')
  );
}

// ─────────────────────────────────────────────
// エントリポイント
// ─────────────────────────────────────────────

exports.handler = async (event) => {
  const env = process.env;

  if (!isEnabled(env)) {
    console.log('[Summary] SUMMARIZE_ENABLED is not true; skipping');
    return { skipped: true, reason: 'disabled' };
  }

  if (isSqsEvent(event)) {
    return handleSqsEvent(event);
  }

  if (isScheduledEvent(event)) {
    return handleScheduledEvent(event);
  }

  // Lambda コンソールからの手動テスト用。
  // { "sub": "...", "threadId": "..." } を直接渡せる。
  if (event && event.sub && event.threadId) {
    return summarizeThread({ sub: event.sub, threadId: event.threadId });
  }

  console.warn(`[Summary] unsupported event shape: ${JSON.stringify(event).slice(0, 200)}`);
  return { skipped: true, reason: 'unsupported_event' };
};

// テスト用に内部関数も公開する。
exports.MEMORY_REFRESH_TYPE = MEMORY_REFRESH_TYPE;
exports.summarizeThread = summarizeThread;
exports.handleSqsEvent = handleSqsEvent;
exports.handleScheduledEvent = handleScheduledEvent;
exports.refreshUserMemory = refreshUserMemory;
exports.isSqsEvent = isSqsEvent;
exports.isScheduledEvent = isScheduledEvent;
