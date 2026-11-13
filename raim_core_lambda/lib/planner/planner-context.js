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
// メモ帳（メモ・リスト）も同じ手帳に入れる。「メモ」「買うもの」などの言葉があるときと、
// リストを持っている人が、リストの名前や項目（「牛乳買った」）を言ったときに開く。
//
// 指示の文は人格のプロンプト（prompts/）には入れず、状況のルールとしてここに置く。
// ==============================================================================

const {
  buildCalendarLines,
  formatDateLabel,
  todayJst,
  daysBetween,
} = require('./planner-dates');
const { keyOf } = require('./planner-memo');

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

// メモ帳の言葉（「メモして」「買うものに牛乳足して」「メモ何あったっけ」）
const MEMO_WORDS = Object.freeze([
  'メモ', 'めも', '買うもの', 'かうもの', '買い物リスト', 'かいものリスト', '買い物メモ',
  'リスト', 'りすと', '控えて', 'ひかえて', '控えといて', '書いといて', '書いておいて',
]);

// 「買い物にパン足して」：買い物リストがまだ無くても、足す言葉と一緒ならメモ帳を開く。
// 「買い物行ってきた」のように足す言葉が無いときは開かない（2026-11-13）
const SHOPPING_WORDS = Object.freeze(['買い物', 'かいもの', '買いもの', '買い出し', 'かいだし']);
const SHOPPING_ADD_WORDS = Object.freeze([
  '足して', 'たして', '足しといて', 'たしといて', '追加', '入れて', 'いれて', '入れといて', 'いれといて',
  '加えて', 'くわえて', 'も買う', 'もかう', 'も買わ', 'もかわ',
]);

// リストの項目を足す・チェックする言葉。リストの名前や項目が発言にあるかは、
// 手帳を読んでから確かめる（この言葉だけでは開かない）
const LIST_ACTION_WORDS = Object.freeze([
  '買った', '買いました', '買ってきた', '済んだ', '済ませた', 'すませた', '終わった', 'おわった',
  'やった', 'できた', '足して', 'たして', '追加', '入れて', 'いれて', 'いらなくなった',
  'いらない', 'チェック', '外して', 'はずして',
]);

// ライムに見せる予定の数。多いとプロンプトが長くなる
const MAX_CONTEXT_ITEMS = 20;
// ライムに見せるメモの数（新しい順）
const MAX_CONTEXT_MEMOS = 20;

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
 * メモ帳の言葉があるか（「メモして」「買うもの何だっけ」「買い物にパン足して」）。
 */
function mentionsMemo(userText) {
  const text = String(userText || '');
  if (!text) return false;
  if (MEMO_WORDS.some((word) => text.includes(word))) return true;
  return SHOPPING_WORDS.some((word) => text.includes(word)) &&
    SHOPPING_ADD_WORDS.some((word) => text.includes(word));
}

/**
 * リストの項目を足す・チェックしそうな言葉があるか（手帳を読むかどうかだけに使う）。
 */
function mentionsListAction(userText) {
  const text = String(userText || '');
  if (!text) return false;
  return LIST_ACTION_WORDS.some((word) => text.includes(word));
}

/**
 * リストの名前か、チェックしていない項目が発言に出てきたか。
 */
function mentionsListContent(userText, items = []) {
  const key = keyOf(userText);
  if (!key) return false;
  for (const item of items) {
    if (item?.kind !== 'list') continue;
    const title = keyOf(item.title).replace(/リスト$/, '');
    if (title.length >= 2 && key.includes(title)) return true;
    for (const entry of item.entries || []) {
      const text = keyOf(entry?.text);
      if (!entry?.checked && text.length >= 1 && key.includes(text)) return true;
    }
  }
  return false;
}

/**
 * 手帳を読んでみる価値があるか（読んだあと shouldOpenPlanner で決める）。
 */
function mayNeedPlanner(userText, history = []) {
  return mentionsPlanner(userText, { hasItems: true }) ||
    mentionsMemo(userText) ||
    mentionsListAction(userText) ||
    previousTurnUsedPlanner(history);
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
  const hasItems = items.some((item) => item?.kind === 'event' || item?.kind === 'memo' || item?.kind === 'list') ||
    activeTimers(items).length > 0;
  return mentionsPlanner(userText, { hasItems }) ||
    mentionsMemo(userText) ||
    (mentionsListAction(userText) && mentionsListContent(userText, items)) ||
    previousTurnUsedPlanner(history);
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

/** 新しい順のメモ */
function memosOf(items) {
  return items
    .filter((item) => item?.kind === 'memo')
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

/** 作った順のリスト */
function listsOf(items) {
  return items
    .filter((item) => item?.kind === 'list')
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

function describeMemo(item) {
  const day = item.createdAt ? jstDay(item.createdAt) : '';
  return `- id=${shortIdOf(item.itemId)} メモ「${item.text}」${day ? `（${day}）` : ''}`;
}

function describeList(item) {
  const entries = item.entries || [];
  const open = entries.filter((e) => !e.checked).map((e) => e.text);
  const done = entries.filter((e) => e.checked).map((e) => e.text);
  return `- id=${shortIdOf(item.itemId)} リスト「${item.title}」: ${open.length ? open.join('、') : '（空）'}` +
    (done.length ? `（チェック済み: ${done.join('、')}）` : '');
}

/** 「11/10」（日本時間） */
function jstDay(iso) {
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + 9 * 60 * 60 * 1000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

const MEMO_INSTRUCTION = [
  '【メモ帳】',
  'ライムはユーザーのメモと、項目ごとにチェックできるリスト（買うものなど）も持っておける。',
  '- 「メモして」「買うものに牛乳足して」のように、はっきり頼まれたときだけ入れる。話に出ただけでは入れない',
  '- 項目を並べてチェックしたいもの（買うもの・持ち物など）は add_to_list、それ以外は add_memo',
  '- パスワード・暗証番号・カード番号などはメモしない。「それは自分で控えてね」と言う',
  '- 「メモ何あったっけ？」「買うもの何だっけ？」は show_memos。声で言うのは新しい順に3件まで。残りは「あと〇件あるよ」と言う（カードに全部出る）',
  '- 「牛乳買った」のように済んだと言われたら check_list_entries（聞き返さない）。チェックした項目は次の日に消える',
  '- リストの項目だけ消すときは remove_list_entries',
  '- メモやリストそのものを消す前に「消していい？」と1回聞く。ユーザーが「うん」などと答えてから delete_memo',
  '- メモ帳に無いことを「メモしてある」と言わない',
].join('\n');

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
  const memos = memosOf(items);
  const lists = listsOf(items);
  const shownMemos = memos.slice(0, MAX_CONTEXT_MEMOS);
  return [
    PLANNER_INSTRUCTION,
    '',
    MEMO_INSTRUCTION,
    '',
    '日付の表（今日から2週間）:',
    ...buildCalendarLines(now, 14),
    '',
    '今入っている予定:',
    ...(events.length > 0 ? events.map(describeEvent) : ['- （まだ無い）']),
    ...(timers.length > 0 ? ['', '動いているタイマー:', ...timers.map((t) => describeTimer(t, now))] : []),
    '',
    'メモ（新しい順）:',
    ...(shownMemos.length > 0 ? shownMemos.map(describeMemo) : ['- （まだ無い）']),
    ...(memos.length > shownMemos.length ? [`- ほかに古いメモが${memos.length - shownMemos.length}件`] : []),
    '',
    'リスト:',
    ...(lists.length > 0 ? lists.map(describeList) : ['- （まだ無い）']),
  ].join('\n');
}

module.exports = {
  PLANNER_FEATURE,
  PLANNER_INSTRUCTION,
  mentionsPlanner,
  mentionsEventDate,
  mentionsTimer,
  mentionsMemo,
  mentionsListAction,
  mentionsListContent,
  mayNeedPlanner,
  memosOf,
  listsOf,
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
