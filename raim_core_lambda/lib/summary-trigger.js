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
//   - 前回要約したときから文脈が閾値ぶん伸びたら要約
//     履歴の肥大を直接測る指標。目的（肥大の抑制）に直結する
//   - または往復数が上限を超えたら要約
//     短い発話ばかりでトークンが伸びない場合の保険。青天井を防ぐ
//
// 「会話の切れ目」での判定は、切れ目の検出自体が非自明なため採用していない。
// 放置されたスレッドは Summary Lambda の週次バッチが拾う。
//
// 【単位はスレッド】
//
// 値は ConversationThread の sessionInputTokens（今の文脈サイズ）と
// summarizedAtInputTokens（前回要約時の文脈サイズ）、turnCount を見る。
// ユーザー単位ではなくスレッド単位なのは、スレッドごとに履歴が独立しており、
// 圧縮も再開もスレッド単位で完結するため。

// 前回の要約時点から文脈がこの量だけ伸びたら要約する。
//
// usage.input_tokens は履歴込みの値（= 今の文脈サイズ）なので、
// 「絶対値が閾値を超えたか」で判定すると、一度超えた後は
// 毎ターン発火し続けてしまう。前回要約時点との差で測る。
//
// 継続モードの1往復あたりの伸びが 450〜1500 程度のため、
// 既定 8000 でおよそ 5〜15 往復に1回。
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

  const contextTokens = Number(thread.sessionInputTokens) || 0;
  const baseline = Number(thread.summarizedAtInputTokens) || 0;
  const growth = Math.max(0, contextTokens - baseline);
  const turns = Number(thread.turnCount) || 0;

  const threshold = tokenThreshold(env);
  const cap = maxTurns(env);

  // 主軸: 前回要約時からの伸び
  if (threshold > 0 && growth >= threshold) {
    return {
      shouldSummarize: true,
      reason: `token_growth (${growth} >= ${threshold})`,
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
