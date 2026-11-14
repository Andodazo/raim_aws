'use strict';

// ==============================================================================
// 要約トリガー判定
// ==============================================================================
//
// 「このスレッドを今、要約すべきか」を判定する純粋関数。
// 実際の要約は Summary Lambda が行うため、ここでは判定だけを担う。
//
// 【判定方針】前の要約から何往復したかで決める。
//
// 毎回送る量は「人格・要約・記憶・直近の会話」でほぼ一定なので、文脈の伸び
// （トークン数）では測れない。直近の会話は15往復送るので（prompt-builder.js）、
// 10往復ごとに要約すれば重なりができ、要約の前の会話が抜けない。
//
// 以前は previous_response_id で会話をつないでいたので、文脈の伸び（トークン数）を
// 主軸にしていた（SUMMARIZE_TOKEN_THRESHOLD / SUMMARIZE_MAX_TURNS）。2026-11 に消した。
//
// 「会話の切れ目」での判定は、切れ目の検出自体が非自明なため採用していない。
// 放置されたスレッドは Summary Lambda の週次バッチが拾う。
// 単位はスレッド（ConversationThread の turnCount。要約のたびに 0 に戻る）。

// 前の要約からこの往復数に達したら要約する
function everyTurns(env) {
  const value = Number(env.SUMMARIZE_EVERY_TURNS ?? 10);
  return Number.isFinite(value) ? Math.max(0, value) : 10;
}

// 要約機能そのものの ON/OFF。既定 OFF。
// SQS キューやイベントソースマッピングが揃うまで暴発させないための安全弁。
function isSummarizationEnabled(env) {
  return String(env.SUMMARIZE_ENABLED || 'false').trim().toLowerCase() === 'true';
}

/**
 * スレッドの状態から「今、要約すべきか」を判定する。
 *
 * @param {Object} thread ConversationThread の項目（appendTurn の戻り値でよい）
 * @param {Object} [env]
 * @returns {{ shouldSummarize: boolean, reason: string|null }}
 */
function shouldSummarize(thread, env = process.env) {
  if (!isSummarizationEnabled(env)) {
    return { shouldSummarize: false, reason: null };
  }

  if (!thread || typeof thread !== 'object') {
    return { shouldSummarize: false, reason: null };
  }

  const turns = Number(thread.turnCount) || 0;
  const every = everyTurns(env);
  if (every > 0 && turns >= every) {
    return {
      shouldSummarize: true,
      reason: `every_turns (${turns} >= ${every})`,
    };
  }
  return { shouldSummarize: false, reason: null };
}

module.exports = {
  shouldSummarize,
  isSummarizationEnabled,
  everyTurns,
};
