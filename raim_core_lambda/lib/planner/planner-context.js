'use strict';

// ==============================================================================
// 予定の手帳：いつライムに見せるか（関門）と、見せる中身
// ==============================================================================
//
// 【なぜ関門があるか】
// 予定の指示や一覧を毎回プロンプトに入れると、普通の会話の口調が崩れたり、
// 日付が出るたびに予定の話をしたがったりする（安藤さんと決めた: 普通の会話の
// プロンプトは今と一字も変えない）。
// そこで、日付・時間・予定っぽい言葉があるときだけ、予定の指示・今の予定・
// 日付の表と、予定のツールを渡す。
//
// 前の返事で予定の話をしていたら（「消していい？」→「うん」）、言葉が無くても続けて渡す。
//
// 指示の文は人格のプロンプト（prompts/）には入れず、状況のルールとしてここに置く。
// ==============================================================================

const {
  buildCalendarLines,
  formatDateLabel,
  todayJst,
  daysBetween,
} = require('./planner-dates');

const PLANNER_FEATURE = 'planner';

// 日付・時間・予定を表す言葉。音声の聞き取りでかなになることもあるので、かなも入れる
const PLANNER_WORDS = Object.freeze([
  '今日', 'きょう', '明日', 'あした', 'あす', '明後日', 'あさって', 'しあさって',
  '今週', '来週', 'らいしゅう', '再来週', 'さらいしゅう', '週末', '今月', '来月', 'らいげつ',
  '今夜', '今晩', '月曜', '火曜', '水曜', '木曜', '金曜', '土曜', '日曜', '曜日',
  '午前', '午後', '予定', 'よてい', 'スケジュール', '予約', '締め切り', '締切', '〆切',
  '覚えといて', '覚えておいて', 'おぼえといて', 'おぼえておいて', '忘れないように',
  'リマインド', '知らせて', 'しらせて',
]);

// 予定を直す・消すときの言葉。予定を持っている人にだけ使う
const PLANNER_CHANGE_WORDS = Object.freeze([
  'なくなった', '無くなった', '中止', 'キャンセル', 'きゃんせる', '延期', 'ずれた',
  '変わった', 'かわった', '変更', 'へんこう', '消して', 'けして', '削除',
]);

// 数字を使った日付・時刻（「10時」「14日」「11/14」「11月」）
const PLANNER_PATTERNS = Object.freeze([
  /\d{1,2}\s*(?:時|じ)/,
  /\d{1,2}\s*日/,
  /\d{1,2}\s*月/,
  /\d{1,2}\s*[/／]\s*\d{1,2}/,
]);

// タイマーを頼む言葉（「3分計って」「30分たったら教えて」「タイマーやめて」）
const TIMER_WORDS = Object.freeze([
  'タイマー', 'たいまー', '計って', 'はかって', '測って',
]);

const TIMER_PATTERNS = Object.freeze([
  /\d+\s*(?:分|ふん|ぷん|秒|びょう|時間半?)\s*(?:後|ご|たったら|経ったら|したら|で(?:教|知|呼|起|声))/,
]);

// ライムに見せる予定の数。多いとプロンプトが長くなる
const MAX_CONTEXT_ITEMS = 20;

/** 全角数字を半角にする（音声の聞き取りで全角になることがある） */
function toHalfWidthDigits(text) {
  return String(text || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

/**
 * 今回の発言が予定に関係しそうか。
 *
 * @param {string} userText
 * @param {{ hasItems?: boolean }} options  予定を持っていれば、直す・消す言葉も見る
 */
function mentionsPlanner(userText, { hasItems = false } = {}) {
  const text = toHalfWidthDigits(userText);
  if (!text) return false;
  if (mentionsEventDate(text)) return true;
  if (mentionsTimer(text)) return true;
  if (hasItems && PLANNER_CHANGE_WORDS.some((word) => text.includes(word))) return true;
  return false;
}

/**
 * 日付・時間・予定の言葉があるか（「予定に入れる？」の候補を探すかどうかに使う）。
 */
function mentionsEventDate(userText) {
  const text = toHalfWidthDigits(userText);
  if (!text) return false;
  return PLANNER_WORDS.some((word) => text.includes(word)) ||
    PLANNER_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * タイマーの話か（「3分計って」「タイマーやめて」）。
 */
function mentionsTimer(userText) {
  const text = toHalfWidthDigits(userText);
  if (!text) return false;
  return TIMER_WORDS.some((word) => text.includes(word)) ||
    TIMER_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * 前のライムの返事で、予定の手帳を開いていたか（続けて渡すため）。
 */
function previousTurnUsedPlanner(history = []) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (message?.role === 'assistant') {
      return Boolean(message?.meta?.planner);
    }
  }
  return false;
}

/**
 * 今回、予定の手帳（指示・一覧・ツール）を渡すか。
 */
function shouldOpenPlanner({ features = [], userText = '', history = [], items = [], greeting = false }) {
  if (greeting) return false;
  if (!Array.isArray(features) || !features.includes(PLANNER_FEATURE)) return false;
  const hasItems = items.some((item) => item?.kind === 'event') || activeTimers(items).length > 0;
  return mentionsPlanner(userText, { hasItems }) || previousTurnUsedPlanner(history);
}

/** ライムに見せる短い ID（itemId の uuid の先頭6文字） */
function shortIdOf(itemId) {
  return String(itemId || '').replace(/^[a-z]+_/, '').slice(0, 6);
}

/**
 * 短い ID から項目を探す。見つからない・2つ以上当たるときは null。
 */
function findItemByShortId(items, shortId) {
  const key = String(shortId || '').trim().toLowerCase();
  if (!key) return null;
  const hits = items.filter((item) => shortIdOf(item.itemId) === key || item.itemId === key);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * これからの予定（昨日以降）を、日付・時刻順に並べる。
 */
function upcomingEvents(items, now = new Date()) {
  const today = todayJst(now);
  return items
    .filter((item) => item?.kind === 'event' && item.date && daysBetween(today, item.date) >= -1)
    .sort((a, b) => (
      a.date.localeCompare(b.date) ||
      String(a.time || '99:99').localeCompare(String(b.time || '99:99')) ||
      String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
    ));
}

/**
 * まだ鳴っていないタイマー（終わる時刻の早い順）。
 */
function activeTimers(items, now = new Date()) {
  const nowMs = now.getTime();
  return items
    .filter((item) => item?.kind === 'timer' && Date.parse(item.endsAt || '') > nowMs)
    .sort((a, b) => String(a.endsAt).localeCompare(String(b.endsAt)));
}

/** 日本時間の「HH:mm」 */
function jstClock(iso) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + 9 * 60 * 60 * 1000).toISOString().slice(11, 16);
}

function describeTimer(item, now) {
  const left = Math.max(1, Math.round((Date.parse(item.endsAt) - now.getTime()) / 60000));
  return `- id=${shortIdOf(item.itemId)} タイマー「${item.title}」 ${jstClock(item.endsAt)} に鳴る（あと約${left}分）`;
}

function describeEvent(item) {
  const time = item.time ? ` ${item.time}` : '';
  const note = item.note ? `（メモ: ${item.note}）` : '';
  return `- id=${shortIdOf(item.itemId)} ${item.date} ${formatDateLabel(item.date)}${time} ${item.title}${note}`;
}

const PLANNER_INSTRUCTION = [
  '【予定の手帳】',
  'ライムはユーザーの予定を手帳に入れておける。入れた予定は、前の日の夜や1時間前にアプリが知らせる。',
  '- ユーザーが「予定入れて」「覚えといて」「〇〇の日に教えて」のように、はっきり頼んだときだけ add_schedule を使う',
  '- 話に出ただけのとき（「明日テストなんだよね」）は入れない。予定に入れるか聞くこともしない（アプリがボタンを出す）',
  '- 日付は下の「日付の表」から選んで YYYY-MM-DD で入れる。時間が分かれば HH:mm で入れる',
  '- 日付が決められないとき（「来週」「今度」）は入れずに、何日か1回だけ聞く。時間があいまい（「夕方」）なら時間なしで入れる',
  '- 予定を直すときは update_schedule、消すときは delete_schedule。id は「今入っている予定」の id を使う',
  '- 消す前に「〇〇、消していい？」と1回聞く。ユーザーが「うん」などと答えてから delete_schedule を使う',
  '- 入れた・直した・消したら、何をいつにしたか短く言う',
  '- ツールを使っていないのに「入れた」「消した」と言わない。手帳に無い予定を「入っている」と言わない',
  '- 「3分計って」「30分たったら教えて」のようにタイマーを頼まれたら set_timer。24時間より長いときは予定に入れるか聞く',
  '- 「タイマーやめて」は cancel_timer（聞き返さずに止める）。動いているタイマーが2つ以上なら、どれか聞く',
].join('\n');

/**
 * プロンプトに入れる、予定の手帳の中身。
 */
function buildPlannerContext({ items = [], now = new Date() }) {
  const events = upcomingEvents(items, now).slice(0, MAX_CONTEXT_ITEMS);
  const timers = activeTimers(items, now);
  return [
    PLANNER_INSTRUCTION,
    '',
    '日付の表（今日から2週間）:',
    ...buildCalendarLines(now, 14),
    '',
    '今入っている予定:',
    ...(events.length > 0 ? events.map(describeEvent) : ['- （まだ無い）']),
    ...(timers.length > 0 ? ['', '動いているタイマー:', ...timers.map((t) => describeTimer(t, now))] : []),
  ].join('\n');
}

module.exports = {
  PLANNER_FEATURE,
  PLANNER_INSTRUCTION,
  mentionsPlanner,
  mentionsEventDate,
  mentionsTimer,
  activeTimers,
  jstClock,
  previousTurnUsedPlanner,
  shouldOpenPlanner,
  shortIdOf,
  findItemByShortId,
  upcomingEvents,
  buildPlannerContext,
  toHalfWidthDigits,
};
