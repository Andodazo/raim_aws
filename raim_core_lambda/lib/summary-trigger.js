'use strict';

// ==============================================================================
// 要約トリガー判定
// ==============================================================================
//
// 「このスレッドを今、要約すべきか」を判定する純粋関数。
// 実際の要約は Summary Lambda が行うため、ここでは判定だけを担う。
//
// 【判定方針】トークン数を主軸、往復数を安全弁（キャップ）として併用する。
//
//   - 累積入力トークンが閾値を超えたら要約
//     履歴の肥大を直接測る指標。目的（肥大の抑制）に直結する
//   - または往復数が上限を超えたら要約
//     短い発話ばかりでトークンが伸びない場合の保険。青天井を防ぐ
//
// 「会話の切れ目」での判定は、切れ目の検出自体が非自明なため採用していない。
// 放置されたスレッドは Summary Lambda の週次バッチが拾う。
//
// 【単位はスレッド】
//
// 累積値は ConversationThread の cumulativeInputTokens / turnCount を見る。
// ユーザー単位ではなくスレッド単位なのは、スレッドごとに履歴が独立しており、
// 圧縮も再開もスレッド単位で完結するため。

// 累積入力トークンがこの値を超えたら要約する。
// 初回プロンプト（人格全文 + few-shot）が約2Kトークンのため、
// その3〜5倍が積み上がったあたりを目安に既定 8000。
function tokenThreshold(env) {
  return Math.max(0, Number(env.SUMMARIZE_TOKEN_THRESHOLD || 8000));
}

// 往復数がこの値を超えたら、トークン数に関係なく要約する（安全弁）。
function maxTurns(env) {
  return Math.max(0, Number(env.SUMMARIZE_MAX_TURNS || 20));
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

  const tokens = Number(thread.cumulativeInputTokens) || 0;
  const turns = Number(thread.turnCount) || 0;

  const threshold = tokenThreshold(env);
  const cap = maxTurns(env);

  // 主軸: トークン数
  if (threshold > 0 && tokens >= threshold) {
    return {
      shouldSummarize: true,
      reason: `token_threshold (${tokens} >= ${threshold})`,
    };
  }

  // 安全弁: 往復数
  if (cap > 0 && turns >= cap) {
    return {
      shouldSummarize: true,
      reason: `max_turns (${turns} >= ${cap})`,
    };
  }

  return { shouldSummarize: false, reason: null };
}

module.exports = {
  shouldSummarize,
  isSummarizationEnabled,
  tokenThreshold,
  maxTurns,
};
