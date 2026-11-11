'use strict';

// ==============================================================================
// 予定まわりの日付（日本時間）
// ==============================================================================
//
// 予定は「日本時間の日付（YYYY-MM-DD）」と「時刻（HH:mm、無くてもいい）」で持つ。
// Lambda は UTC で動くので、日付の計算は全部ここで日本時間に揃える。
//
// ライムに「金曜」を日付に直させると、Gemma は曜日を数え間違えることがある。
// そのため、今日から2週間ぶんの「日付と曜日の表」をプロンプトに渡して、
// そこから選ばせる（buildCalendarLines）。
// ==============================================================================

const TIME_ZONE = 'Asia/Tokyo';
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = Object.freeze(['日', '月', '火', '水', '木', '金', '土']);

// 終わった予定を残す日数（安藤さんと決めた: 7日）
const KEEP_DAYS_AFTER_EVENT = 7;

// 予定として受け付ける先の日数。それより先は聞き間違いとみなす
const MAX_DAYS_AHEAD = 400;

/**
 * 日本時間の「今日」を YYYY-MM-DD で返す。
 */
function todayJst(now = new Date()) {
  return toDateString(new Date(now.getTime() + JST_OFFSET_MS));
}

/** UTC の Date を、その UTC 日付の YYYY-MM-DD にする（JST に寄せた Date を渡す） */
function toDateString(shifted) {
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * YYYY-MM-DD として正しい日付か。2月30日なども弾く。
 */
function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * 時刻を HH:mm に揃える。「9:5」「09:05」「9時」などを受け付ける。正しくなければ ''。
 */
function normalizeTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const match = text.match(/^(\d{1,2})(?:[:：時](\d{1,2})?分?)?$/);
  if (!match) return '';
  const hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (hour > 23 || minute > 59) return '';
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * 日付と時刻（日本時間）を UTC の epoch ミリ秒にする。時刻が無ければ 0:00。
 */
function jstToEpochMs(date, time = '') {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = (time || '00:00').split(':').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - JST_OFFSET_MS;
}

/**
 * 日付の差（日数）。a が b より後なら正。
 */
function daysBetween(fromDate, toDate) {
  return Math.round((jstToEpochMs(toDate) - jstToEpochMs(fromDate)) / DAY_MS);
}

/** YYYY-MM-DD に日数を足す */
function addDays(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  return toDateString(new Date(Date.UTC(y, m - 1, d + days)));
}

/** 曜日（日〜土） */
function weekdayOf(date) {
  const [y, m, d] = date.split('-').map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/**
 * 画面や返事で使う日付の書き方。「11/14(金)」
 */
function formatDateLabel(date) {
  const [, m, d] = date.split('-').map(Number);
  return `${m}/${d}(${weekdayOf(date)})`;
}

/**
 * 今日から見た言い方。「今日」「明日」「あさって」、それ以外は「11/14(金)」。
 */
function relativeDateLabel(date, now = new Date()) {
  const diff = daysBetween(todayJst(now), date);
  if (diff === 0) return '今日';
  if (diff === 1) return '明日';
  if (diff === 2) return 'あさって';
  if (diff === -1) return '昨日';
  return formatDateLabel(date);
}

/**
 * ライムに渡す、今日から days 日ぶんの日付と曜日の表。
 * 「金曜」→ どの日付かを、ここから選ばせる。
 */
function buildCalendarLines(now = new Date(), days = 14) {
  const today = todayJst(now);
  const lines = [];
  for (let i = 0; i < days; i += 1) {
    const date = addDays(today, i);
    const label = i === 0 ? '今日' : i === 1 ? '明日' : i === 2 ? 'あさって' : '';
    lines.push(`${date} (${weekdayOf(date)})${label ? ` ${label}` : ''}`);
  }
  return lines;
}

/**
 * 予定を消す時刻（DynamoDB の TTL、epoch 秒）。予定の日の7日後の終わり。
 */
function expiresAtForEvent(date) {
  const endOfKeepDay = jstToEpochMs(addDays(date, KEEP_DAYS_AFTER_EVENT + 1));
  return Math.floor(endOfKeepDay / 1000);
}

/**
 * 予定の日付として受け付けるか。過去すぎる・先すぎるものは聞き間違いとみなす。
 * 昨日までは受け付ける（「昨日の分も入れといて」は無いが、日付の境目のずれを許す）。
 */
function isAcceptableEventDate(date, now = new Date()) {
  if (!isValidDate(date)) return false;
  const diff = daysBetween(todayJst(now), date);
  return diff >= -1 && diff <= MAX_DAYS_AHEAD;
}

module.exports = {
  TIME_ZONE,
  KEEP_DAYS_AFTER_EVENT,
  todayJst,
  isValidDate,
  normalizeTime,
  jstToEpochMs,
  daysBetween,
  addDays,
  weekdayOf,
  formatDateLabel,
  relativeDateLabel,
  buildCalendarLines,
  expiresAtForEvent,
  isAcceptableEventDate,
};
