'use strict';

// ==============================================================================
// 言ってたことを後で聞く（「そういえば、昨日の面接どうだった？」）
// ==============================================================================
//
// 【決めたこと】（安藤さんと決めた）
//   - 聞くのは、予定に入っているものと、「予定に入れる？」ボタンが押されなかったもの
//   - 大事さ（予定を入れるときに LLM が決める）で聞き方を変える
//       大事（面接・試験・発表・試合・病院） 前日・当日の知らせで応援（planner-reminder.js）、終わったら必ず聞く
//       ふつう（遊び・映画・買い物） 3回に1回くらい、数日以内に聞く
//     押されなかったボタンのものも、ボタンを出すときに LLM が大事さを決める（2026-11-13 に変更。
//     以前はいつも「ふつう」で、面接でも3回に1回だった）
//       用事（ゴミ出し・振込） 聞かない
//   - 押されなかったボタンのものは「あとで聞くこと」（kind followup, itemId fu_…）として持つ。
//     予定の一覧には出さず、「予定とメモ」画面の下に小さく出して消せるようにする
//   - 聞くのは終わったあと（時間ありは始まって2時間後から、日付だけは次の日から）。
//     起動時の話しかけか、会話のはじめの3往復のうちに「そういえば」で
//   - プロンプトに足すのは、その3往復で、聞きたいことがあるときだけ
//   - 朝のまとめと重なったら1つにまとめる（「昨日の面接どうだった？今日は15時からバイトだね」）
//   - 1回聞いたらもう聞かない。本人が先にその話をしたら「聞いた」扱いにして乗るだけ。
//     濁されたら深追いしない。1日の上限は設けない
//   - 直前の会話がつらい話だったときは聞かない（気づかう話しかけが優先）
//
// 「会話のはじめ」は、起動時の話しかけのあと、または1時間あいたあと。
// （3時間あくと必ず話しかけるが、それより短いと話しかけないことが多い。開き直したあとの
//   はじめの数往復でも聞けるよう、話しかけより短い区切りにした）
// 1回の区切りで聞くのは1つだけ（続けて聞くと問い詰めているように聞こえるので）。
//
// 人格のプロンプト（prompts/）には触れず、状況のルールとしてここに置く。
// ==============================================================================

const { createHash } = require('node:crypto');
const {
  todayJst,
  daysBetween,
  jstToEpochMs,
  formatDateLabel,
} = require('./planner-dates');
const { keyOf } = require('./planner-memo');

// 会話のはじめの何往復まで聞いてよいか
const FOLLOW_UP_TURNS = 3;
// これだけあいたら「会話のはじめ」に戻る
const SESSION_GAP_MINUTES = 60;
// 時間のある予定は、始まってからこれだけたってから聞く
const AFTER_START_MINUTES = 2 * 60;
// ふつうの予定を聞く期間（予定の日から数えて何日目まで）
const NORMAL_WINDOW_DAYS = 3;
// 大事な予定を聞く期間（予定は7日後に消えるので、それまで）
const IMPORTANT_WINDOW_DAYS = 7;
// ふつうの予定を聞く割合（3回に1回くらい）
const NORMAL_ASK_ONE_IN = 3;

/** 予定が始まる時刻（日付だけなら、その日の0時） */
function startMsOf(item) {
  return jstToEpochMs(item.date, item.time || '');
}

/**
 * 聞いていい時刻になったか（時間ありは始まって2時間後、日付だけは次の日）。
 */
function isOver(item, now = new Date()) {
  if (!item?.date) return false;
  if (item.time) return now.getTime() >= startMsOf(item) + AFTER_START_MINUTES * 60000;
  return daysBetween(item.date, todayJst(now)) >= 1;
}

/**
 * ふつうの予定を聞くか（3回に1回くらい）。同じ予定ならいつ見ても同じ答えにする
 * （話すたびにサイコロを振り直すと、結局ほとんど聞いてしまうので）。
 */
function rollsToAsk(itemId) {
  const digest = createHash('sha1').update(String(itemId || '')).digest();
  return digest[0] % NORMAL_ASK_ONE_IN === 0;
}

/** 大事さに合わせて、聞く対象か */
function wantsToAsk(item) {
  if (item.kind !== 'event' && item.kind !== 'followup') return false;
  if (item.importance === 'important') return true;
  if (item.importance === 'chore') return false;
  return rollsToAsk(item.itemId);
}

function windowDaysOf(item) {
  return item.importance === 'important' ? IMPORTANT_WINDOW_DAYS : NORMAL_WINDOW_DAYS;
}

/**
 * 予定の名前から、話に出たかを見るための言葉（「A社の面接」→「a社」「面接」と全体）。
 */
function titleWords(title) {
  const whole = keyOf(title);
  const parts = String(title || '')
    .normalize('NFKC')
    .toLowerCase()
    .split(/[\sのでとへにをはがも・、。,.!！?？「」『』（）()]+/)
    .map(keyOf)
    .filter((word) => word.length >= 2);
  return [...new Set([whole, ...parts].filter((word) => word.length >= 2))];
}

/** 文に、その予定の話が出ているか */
function mentionsItem(text, item) {
  const key = keyOf(text);
  if (!key) return false;
  return titleWords(item?.title).some((word) => key.includes(word));
}

/**
 * 予定が始まってから、ユーザーが自分でその話をしていたか（していたら「聞いた」扱い）。
 */
function talkedAboutSince(item, messages = []) {
  const since = startMsOf(item);
  return (Array.isArray(messages) ? messages : []).some((m) => {
    if (m?.role !== 'user') return false;
    const at = Date.parse(m.createdAt || '');
    return Number.isFinite(at) && at >= since && mentionsItem(m.text, item);
  });
}

/** 同じ日の同じこと（名前の言葉がかぶる）か */
function sameThing(a, b) {
  if (!a?.date || a.date !== b?.date) return false;
  const aw = titleWords(a.title);
  const bw = titleWords(b.title);
  return aw.some((word) => bw.some((other) => word.includes(other) || other.includes(word)));
}

/**
 * 今、聞けることを全部（聞く順に）。
 *
 * - 終わっている、まだ聞いていない、聞く期間のうち、大事さで聞くと決まったもの
 * - 押されなかったボタンのものは、あとから同じものが予定に入っていれば予定のほうで聞く
 * - 大事なものを先に、同じなら古いものから
 */
function dueFollowUps(items, now = new Date()) {
  const list = Array.isArray(items) ? items : [];
  const today = todayJst(now);
  const events = list.filter((item) => item?.kind === 'event');
  return list
    .filter((item) => (item?.kind === 'event' || item?.kind === 'followup') && !item.askedAt)
    .filter((item) => item.kind !== 'followup' || !events.some((event) => sameThing(event, item)))
    .filter((item) => isOver(item, now))
    .filter((item) => daysBetween(item.date, today) <= windowDaysOf(item))
    .filter(wantsToAsk)
    .sort((a, b) => (
      Number(b.importance === 'important') - Number(a.importance === 'important') ||
      startMsOf(a) - startMsOf(b)
    ));
}

/**
 * 今回の発言が「会話のはじめ」の何往復目か、その区切りでもう聞いたか。
 *
 * 起動時の話しかけのあと、または1時間あいたあとを区切りにする。
 * messages は今の会話（今回の発言を足す前）。
 *
 * @returns {{ turns: number, asked: boolean }} turns はこれまでの往復数（今回を含まない）
 */
function sessionState(messages = [], now = new Date()) {
  const list = Array.isArray(messages) ? messages : [];
  let turns = 0;
  let later = now.getTime();
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const message = list[i];
    const at = Date.parse(message?.createdAt || '');
    if (Number.isFinite(at) && later - at >= SESSION_GAP_MINUTES * 60000) break;
    if (message?.role === 'assistant' && message.meta?.followUp) return { turns, asked: true };
    if (message?.role === 'assistant' && message.meta?.greeting) break;
    if (message?.role === 'user') turns += 1;
    if (Number.isFinite(at)) later = at;
  }
  return { turns, asked: false };
}

/** 「昨日の15:00」「おとといの」「11/8(土)の」 */
function whenText(item, now = new Date()) {
  const diff = daysBetween(item.date, todayJst(now));
  const day = diff === 0 ? '今日' : diff === 1 ? '昨日' : diff === 2 ? 'おととい' : formatDateLabel(item.date);
  return item.time ? `${day}の${item.time}` : day;
}

function describe(item, now) {
  const kind = item.kind === 'followup'
    ? `ユーザーが前に話していた${item.importance === 'important' ? '大事な' : ''}こと（予定には入っていない）`
    : item.importance === 'important' ? '大事な予定' : '予定';
  return `- ${whenText(item, now)}：${item.title}（${kind}）`;
}

const COMMON_RULES = Object.freeze([
  '- 結果を決めつけない（うまくいかなかったかもしれない）。答えを急かさない',
  '- 聞くのは1回だけ。話したがらなかったり濁されたりしたら、深追いせず別の話に乗る',
  '- 「通知」「アプリ」「登録」「記録」という言葉は使わない',
]);

/**
 * 起動時の話しかけで聞く指示。
 */
function buildFollowUpGreetingInstruction({ item, now = new Date() }) {
  return [
    '【そういえばの話しかけ（終わったことを聞く）】',
    'ユーザーがアプリを開いた。ライムから先に話しかけて、終わったことがどうだったか聞く。',
    describe(item, now),
    '- 1〜2文で短く。いつもの口調のまま。時間帯に合った挨拶を軽く添えてよい',
    '- 「そういえば」などで自然に。大事な予定なら気にかけていた気持ちを少し込めてよい',
    ...COMMON_RULES,
  ].join('\n');
}

/**
 * 朝のまとめと重なったときに、まとめの指示に足す行。
 */
function buildFollowUpBriefLines({ item, now = new Date() }) {
  return [
    'あわせて、終わったことを1つだけ聞く（今日の予定より先に、ひとことで）:',
    describe(item, now),
    '- 「昨日の面接どうだった？今日は15時からバイトだね」のように、聞いてから今日の予定へつなぐ',
    '- 結果を決めつけない。答えを急かさない',
  ];
}

/**
 * 会話のはじめの3往復で、返事のあとに聞く指示。
 */
function buildFollowUpTurnInstruction({ item, now = new Date() }) {
  return [
    '【そういえば（終わったことを聞く）】',
    'ユーザーには、もう終わったこんなことがあった。まだどうだったか聞いていない。',
    describe(item, now),
    '- まずユーザーの今の話にちゃんと答える。そのあと最後に「そういえば」で、どうだったか軽く聞く',
    '- ユーザーが相談や質問の途中、つらそうな話、急いでいる話なら、今回は聞かない',
    '- ユーザーが自分からその話をしたら、聞き直さずにその話に乗る',
    ...COMMON_RULES,
  ].join('\n');
}

/**
 * 返事の中で聞いたか（会話の途中は「流れが合えば」なので、聞かない返事もある）。
 */
function replyAskedAbout(replyText, item) {
  const text = String(replyText || '');
  return text.includes('そういえば') || text.includes('どうだった') || mentionsItem(text, item);
}

module.exports = {
  FOLLOW_UP_TURNS,
  SESSION_GAP_MINUTES,
  NORMAL_WINDOW_DAYS,
  IMPORTANT_WINDOW_DAYS,
  isOver,
  rollsToAsk,
  wantsToAsk,
  titleWords,
  mentionsItem,
  talkedAboutSince,
  sameThing,
  dueFollowUps,
  sessionState,
  whenText,
  buildFollowUpGreetingInstruction,
  buildFollowUpBriefLines,
  buildFollowUpTurnInstruction,
  replyAskedAbout,
};
