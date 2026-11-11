'use strict';

// ==============================================================================
// 予定まわりで、返事とは別に LLM に書かせるもの
// ==============================================================================
//
// 1. 知らせる文と大事さ（writeEventExtras）
//    予定を入れたときに、前日の夜・1時間前・当日の朝に知らせる文を
//    ライムの口調で作らせて、予定と一緒に保存する。スマホは時間になったら
//    この文を通知に出すだけなので、電波が無くても時間どおりに出せる（安藤さんと決めた）。
//    あわせて、終わったあとに「どうだった？」と聞く価値（大事さ）も決めさせる。
//
// 2. 予定っぽいもの（findEventCandidate）
//    「明日テストなんだよね」のように話に出ただけのとき、ライムは口では聞かず、
//    アプリが「予定に入れる？」ボタンを出す。そのボタンに入れる中身を作る。
//
// 【なぜ返事と別の呼び出しにするか】
// 返事の JSON に項目を足すと、Gemma が返事の形を崩すことがある。
// 返事の出力は今のまま触らず、別に短い呼び出しをする。
// どちらも返事を作るのと並行して呼ぶので、返事が遅くなることはほぼ無い。
//
// 失敗しても会話は止めない（知らせる文は決まり文句、ボタンは出さない）。
// ==============================================================================

const { getPersonaDigest, resolvePersonaName, RAIM_PERSONA } = require('../prompts/raim-system-prompt');
const {
  buildCalendarLines,
  isAcceptableEventDate,
  normalizeTime,
  todayJst,
  daysBetween,
} = require('./planner-dates');
const { IMPORTANCE } = require('./planner-store');

const LINE_SLOTS = Object.freeze(['eve', 'before', 'morning']);
const MIN_LINE_LENGTH = 4;
const MAX_LINE_LENGTH = 60;

// 知らせる文に書かせない言葉。いつ知らせるかで意味がずれるので、日時はアプリが添える
const RELATIVE_TIME_PATTERN = /明日|あした|今日|きょう|今夜|今晩|明後日|あさって|昨日|あと\s*\d|\d+\s*(?:時|分|日)|時間後|分後|曜/;

/**
 * 決まり文句。LLM の文が使えないときに使う。アプリにも同じものがある。
 */
function templateLine(slot, title) {
  if (slot === 'eve') return `${title}の準備、できてる？`;
  if (slot === 'before') return `そろそろ${title}だよ。いってらっしゃい`;
  return `${title}の日だよ。忘れないでね`;
}

/**
 * LLM の返事から JSON を取り出す（前後に文が付いていても読む）。
 */
function parseJsonObject(rawText) {
  const text = String(rawText || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 知らせる文として使えるか。長すぎる・短すぎる・日時の言葉がある・改行や絵文字っぽい記号があるものは使わない。
 */
function isUsableLine(line) {
  const text = String(line || '').trim();
  const length = Array.from(text).length;
  if (length < MIN_LINE_LENGTH || length > MAX_LINE_LENGTH) return false;
  if (RELATIVE_TIME_PATTERN.test(text)) return false;
  if (/[\n\r{}[\]<>]/.test(text)) return false;
  if (/\p{Extended_Pictographic}/u.test(text)) return false;
  return true;
}

/**
 * 人格の口調の部分だけ（返事の出力形式の指示は外す。ここでは別の JSON を返させるため）。
 */
function toneOnlyDigest(persona) {
  return getPersonaDigest(resolvePersonaName(persona)).split('【出力形式】')[0].trim();
}

function buildExtrasMessages({ title, note, persona }) {
  return [
    {
      role: 'system',
      content: [
        toneOnlyDigest(persona),
        '',
        '---',
        '',
        '【予定の知らせの文を書く】',
        'ユーザーが手帳に入れた予定について、アプリが通知で出す文をライムの口調で書く。',
        '- eve: 前の日の夜に言う文',
        '- before: 予定の少し前に言う文',
        '- morning: 当日の朝に言う文',
        '- それぞれ1文か2文、15〜40字くらい。予定の名前は入れてよい',
        '- 日付・曜日・時刻と、「明日」「今日」「あと〇時間」のような、いつかを表す言葉は書かない（アプリが添える）',
        '- 絵文字・顔文字は使わない',
        '',
        'あわせて、この予定が終わったあとに「どうだった？」と聞く価値で、大事さを決める。',
        '- important: 面接・試験・テスト・発表・試合・病院など、本人にとって大きいこと',
        '- normal: 遊び・映画・買い物・食事など',
        '- chore: ゴミ出し・振込・支払い・返却などの用事',
        '',
        'JSON だけを返す: {"importance":"important か normal か chore","eve":"...","before":"...","morning":"..."}',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `予定: ${title}${note ? `（メモ: ${note}）` : ''}`,
    },
  ];
}

/**
 * 知らせる文と大事さを作る。
 *
 * @returns {Promise<{ lines: object, importance: string, fromLlm: boolean }>}
 *   LLM が使えなければ決まり文句と normal。
 */
async function writeEventExtras({ title, note = '', persona = RAIM_PERSONA, createResponse }) {
  const fallback = {
    lines: Object.fromEntries(LINE_SLOTS.map((slot) => [slot, templateLine(slot, title)])),
    importance: 'normal',
    fromLlm: false,
  };

  try {
    const response = await createResponse({
      mantleInput: { mode: 'planner_extras', messages: buildExtrasMessages({ title, note, persona }) },
      store: false,
    });
    const parsed = parseJsonObject(response?.rawText);
    if (!parsed) {
      console.warn('[Planner] extras: could not parse');
      return fallback;
    }

    const lines = {};
    let usable = 0;
    for (const slot of LINE_SLOTS) {
      const line = String(parsed[slot] || '').trim();
      if (isUsableLine(line)) {
        lines[slot] = line;
        usable += 1;
      } else {
        lines[slot] = templateLine(slot, title);
      }
    }
    const importance = IMPORTANCE.includes(parsed.importance) ? parsed.importance : 'normal';
    console.log(`[Planner] extras: usableLines=${usable}/3 importance=${importance}`);
    return { lines, importance, fromLlm: true };
  } catch (error) {
    console.warn(`[Planner] extras failed (non-fatal): ${error.message}`);
    return fallback;
  }
}

function buildCandidateMessages({ userText, now }) {
  return [
    {
      role: 'system',
      content: [
        '次のユーザーの発言に、ユーザー本人のこれから先の予定（いつか分かるもの）が出ているかを見る。',
        '出ていれば JSON で返す: {"title":"予定の短い名前（12字まで）","date":"YYYY-MM-DD","time":"HH:mm か 空"}',
        '出ていなければ {"none":true} を返す。',
        '- 過去のこと、もしもの話、ほかの人の予定、毎日のこと（「毎朝」など）、ただの話題は none',
        '- 日付は下の表から選ぶ。決められなければ none',
        '- JSON だけを返す',
        '',
        '日付の表（今日から2週間）:',
        ...buildCalendarLines(now, 14),
      ].join('\n'),
    },
    { role: 'user', content: String(userText || '') },
  ];
}

/**
 * 話に出ただけの予定（「予定に入れる？」ボタンの中身）を探す。無ければ null。
 *
 * @returns {Promise<{ title: string, date: string, time: string } | null>}
 */
async function findEventCandidate({ userText, now = new Date(), createResponse }) {
  try {
    const response = await createResponse({
      mantleInput: { mode: 'planner_candidate', messages: buildCandidateMessages({ userText, now }) },
      store: false,
    });
    const parsed = parseJsonObject(response?.rawText);
    if (!parsed || parsed.none) return null;

    const title = String(parsed.title || '').replace(/\s+/g, ' ').trim().slice(0, 20);
    const date = String(parsed.date || '').trim();
    const time = normalizeTime(parsed.time);
    if (!title || !isAcceptableEventDate(date, now)) return null;
    // 今日より前は予定ではない
    if (daysBetween(todayJst(now), date) < 0) return null;

    return { title, date, time };
  } catch (error) {
    console.warn(`[Planner] candidate failed (non-fatal): ${error.message}`);
    return null;
  }
}

module.exports = {
  LINE_SLOTS,
  templateLine,
  isUsableLine,
  parseJsonObject,
  writeEventExtras,
  findEventCandidate,
};
