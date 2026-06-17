'use strict';

/**
 * Mantle response_id の利用可否を判定するためのポリシー関数群。
 *
 * このファイルでは、Mantleへのアクセス自体は行わない。
 *
 * 役割:
 * - DynamoDBに保存された lastResponseId を使ってよいか判定する
 * - lastResponseExpiresAt を計算する
 * - Mantle呼び出し時のエラーが response_id 期限切れ系か判定する
 *
 * response_id はLambda側では生成しない。
 * Mantleが返した id / response_id を DynamoDB に保存し、
 * 次回以降 previous_response_id として使う。
 */

const RESPONSE_ID_VALID_DAYS = Number(process.env.RESPONSE_ID_VALID_DAYS || 29);

function toTimeMs(value) {
  if (!value || typeof value !== 'string') {
    return null;
  }

  const time = new Date(value).getTime();

  if (Number.isNaN(time)) {
    return null;
  }

  return time;
}

/**
 * response_id の期限日時を計算する。
 *
 * Mantle側の保持期間より少し安全側に倒すため、
 * デフォルトでは createdAt + 29日 を期限として扱う。
 *
 * @param {string} createdAt ISO文字列
 * @param {number} validDays 有効日数
 * @returns {string} ISO文字列
 */
function calculateResponseExpiresAt(createdAt, validDays = RESPONSE_ID_VALID_DAYS) {
  const base = createdAt ? new Date(createdAt) : new Date();
  base.setDate(base.getDate() + validDays);
  return base.toISOString();
}

/**
 * 保存済みの lastResponseId を previous_response_id として使えるか判定する。
 *
 * 条件:
 * - session が存在する
 * - lastResponseId が空ではない
 * - lastResponseExpiresAt が正しい日時
 * - lastResponseExpiresAt が現在時刻より未来
 *
 * @param {Object} session DynamoDBのUserSession Item
 * @param {Date} now 現在時刻。テスト用に差し替え可能
 * @returns {boolean}
 */
function canUsePreviousResponseId(session, now = new Date()) {
  if (!session) {
    return false;
  }

  if (!session.lastResponseId) {
    return false;
  }

  const expiresAtMs = toTimeMs(session.lastResponseExpiresAt);

  if (!expiresAtMs) {
    return false;
  }

  return now.getTime() < expiresAtMs;
}

/**
 * Mantle呼び出し時に使う response_id 状態をまとめて返す。
 *
 * index.js 側ではこの関数を使うと、
 * previous_response_id を渡すべきかどうかを扱いやすい。
 *
 * @param {Object} session DynamoDBのUserSession Item
 * @param {Date} now 現在時刻。テスト用に差し替え可能
 * @returns {Object}
 */
function getMantleSessionState(session, now = new Date()) {
  const usePreviousResponseId = canUsePreviousResponseId(session, now);

  return {
    usePreviousResponseId,
    previousResponseId: usePreviousResponseId ? session.lastResponseId : '',
    lastResponseId: session?.lastResponseId || '',
    lastResponseCreatedAt: session?.lastResponseCreatedAt || '',
    lastResponseExpiresAt: session?.lastResponseExpiresAt || '',
    hasSessionSummary: Boolean(session?.sessionSummary),
  };
}

/**
 * Mantleのエラーが previous_response_id 期限切れ・削除済み・存在しない系か判定する。
 *
 * 実際のエラー形式はSDK/HTTP実装によって差が出る可能性があるため、
 * status / code / name / message を広めに見る。
 *
 * @param {Error|Object} error
 * @returns {boolean}
 */
function isMantleResponseExpiredError(error) {
  if (!error) {
    return false;
  }

  const statusCode =
    error.status ||
    error.statusCode ||
    error.$metadata?.httpStatusCode ||
    error.response?.status;

  const code = String(
    error.code ||
    error.name ||
    error.error?.code ||
    ''
  ).toLowerCase();

  const message = String(
    error.message ||
    error.error?.message ||
    error.response?.data?.error?.message ||
    ''
  ).toLowerCase();

  const text = `${code} ${message}`;

  const mentionsResponseId =
    text.includes('previous_response_id') ||
    text.includes('response_id') ||
    text.includes('response id') ||
    text.includes('response');

  const looksExpired =
    text.includes('expired') ||
    text.includes('not found') ||
    text.includes('not_found') ||
    text.includes('does not exist') ||
    text.includes('deleted') ||
    text.includes('invalid');

  if (mentionsResponseId && looksExpired) {
    return true;
  }

  // 404 はresponse_idが見つからないケースの可能性が高い。
  // ただし、完全に別原因の404と区別するため、response系の文言がある場合のみtrueにする。
  if (statusCode === 404 && mentionsResponseId) {
    return true;
  }

  // 400で previous_response_id が不正と言われた場合も期限切れ扱いで復旧する。
  if (statusCode === 400 && text.includes('previous_response_id')) {
    return true;
  }

  return false;
}

module.exports = {
  RESPONSE_ID_VALID_DAYS,
  calculateResponseExpiresAt,
  canUsePreviousResponseId,
  getMantleSessionState,
  isMantleResponseExpiredError,
};