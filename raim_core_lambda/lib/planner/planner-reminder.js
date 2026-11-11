'use strict';

// ==============================================================================
// 予定を知らせるときの、ライムの一言（話しかけの一種）
// ==============================================================================
//
// 【使う場面】
//   - Windows：知らせる時刻にアプリが動いていれば、その場で一言作って吹き出しと声で出す
//   - スマホ：通知を押してアプリを開いたら、ライムがその予定について一言足す
//   - タイマーも同じ（slot: 'timer'）。Windows は鳴る時刻に、スマホは通知を押したときに話す
//
// アプリは「アプリを開いたときの話しかけ」と同じ type: 'greeting' に
// reminder: { itemId, slot } を付けて送る。Core は予定を読み、
// 普段の話しかけの切り口の代わりに、ここの指示を使う。
//
// 保存しておいた文（lines）は通知に出す控え。ここでは時刻に合わせて新しく作る。
// 人格のプロンプト（prompts/）には触れず、状況のルールとしてここに置く。
// ==============================================================================

const {
  formatDateLabel,
  relativeDateLabel,
} = require('./planner-dates');

const REMINDER_SLOTS = Object.freeze(['eve', 'before', 'morning', 'timer']);

// 予定の知らせの種類（タイマーは 'timer' だけ）
const EVENT_SLOTS = Object.freeze(['eve', 'before', 'morning']);

const ITEM_ID_PATTERN = /^[a-z]{2,4}_[A-Za-z0-9-]{8,64}$/;

const SLOT_SCENES = Object.freeze({
  eve: '前の日の夜',
  before: '始まる1時間くらい前',
  morning: '当日の朝',
});

/**
 * アプリが送った reminder を確かめる。形が違えば null（普段の話しかけにする）。
 */
function normalizeReminder(value) {
  if (!value || typeof value !== 'object') return null;
  const itemId = String(value.itemId || '').trim();
  const slot = String(value.slot || '').trim();
  if (!ITEM_ID_PATTERN.test(itemId) || !REMINDER_SLOTS.includes(slot)) return null;
  return { itemId, slot };
}

/**
 * 読んだ項目と slot が合っているか（予定に timer、タイマーに eve などは使わない）
 */
function reminderMatchesItem(item, slot) {
  if (!item) return false;
  if (item.kind === 'event') return EVENT_SLOTS.includes(slot);
  if (item.kind === 'timer') return slot === 'timer';
  return false;
}

/** 「1時間30分」「3分」「45秒」 */
function formatTimerLength(totalSec) {
  const sec = Math.max(0, Math.round(Number(totalSec) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return [h ? `${h}時間` : '', m ? `${m}分` : '', s && !h ? `${s}秒` : ''].join('');
}

/**
 * タイマーが鳴ったときの話しかけの指示。
 */
function buildTimerReminderInstruction({ item, now = new Date() }) {
  const length = formatTimerLength(item.durationSec);
  const title = String(item.title || '').trim();
  const named = title && title !== 'タイマー';
  const lines = [
    '【タイマーを知らせる話しかけ】',
    `ユーザーに頼まれたタイマー${length ? `（${length}）` : ''}の時間になった。ライムから先に知らせる。`,
  ];
  if (named) lines.push(`- 何のタイマーか：${title}`);
  const endsAtMs = Date.parse(item.endsAt || '');
  const lateMin = Number.isFinite(endsAtMs) ? Math.floor((now.getTime() - endsAtMs) / 60000) : 0;
  if (lateMin >= 3) {
    lines.push(`- 鳴ってから${lateMin}分くらいたっている。「さっき時間になったよ」のように言う`);
  }
  lines.push(
    named
      ? '- 1文で短く。何の時間になったのかがはっきり分かるように言う'
      : '- 1文で短く。時間になったことがはっきり分かるように言う',
    '- 「通知」「アプリ」「合図」「リマインド」という言葉は使わない',
    '- 質問で終わらせない',
  );
  return lines.join('\n');
}

/**
 * 予定を知らせる話しかけの指示。
 *
 * @param {{ item: object, slot: string, now?: Date }} params
 */
function buildReminderInstruction({ item, slot, now = new Date() }) {
  if (item.kind === 'timer') return buildTimerReminderInstruction({ item, now });
  const when = relativeDateLabel(item.date, now);
  const dateText = when === formatDateLabel(item.date)
    ? when
    : `${when}（${formatDateLabel(item.date)}）`;
  const timeText = item.time ? ` ${item.time}` : '（時間は決まっていない）';
  const lines = [
    '【予定を知らせる話しかけ】',
    `今は、ユーザーの予定の${SLOT_SCENES[slot] || '少し前'}。ライムから先に、予定のことを知らせる。`,
    `- 予定：${item.title}　${dateText}${timeText}`,
  ];
  if (item.note) lines.push(`- ユーザーのメモ：${item.note}`);
  lines.push(
    '- 1〜2文で短く。何の予定か、いつかがはっきり分かるように言う',
    '- 日にちは上の「今日」「明日」をそのまま使う。日付の数字を言い直さなくていい',
  );
  if (item.importance === 'important') {
    lines.push('- 大事な予定。軽く応援する一言を添える');
  } else if (item.importance === 'chore') {
    lines.push('- ちょっとした用事。さらっと言う');
  }
  if (slot === 'eve') lines.push('- 前の日の夜なので、準備や早めに寝ることに触れてもいい');
  lines.push(
    '- 「通知」「アプリ」「合図」「リマインド」という言葉は使わない',
    '- 質問で終わらせない',
  );
  return lines.join('\n');
}

module.exports = {
  REMINDER_SLOTS,
  normalizeReminder,
  reminderMatchesItem,
  buildReminderInstruction,
};
