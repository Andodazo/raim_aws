'use strict';

// ==============================================================================
// メモ帳（普通のメモと、チェックできるリスト）の決まりごと
// ==============================================================================
//
// 【項目の形】（RAiM-Planner-dev に予定と一緒に入れる。安藤さんと決めた）
//   memo  普通のメモ    { itemId: 'mm_…', kind: 'memo', text }
//   list  リスト        { itemId: 'ls_…', kind: 'list', title, entries: [{ id, text, checked, checkedAt }] }
//
// メモは自動では消さない（expiresAt を付けない）。
// リストのチェックした項目は、次の日（日本時間）になったら消す。
// DynamoDB の TTL は項目ごとなので、読むときに外し、次に書くときに保存し直す。
//
// Edge Lambda の planner-store.js にも同じ決まりがある。変えるときは両方そろえること。
// ==============================================================================

const { randomBytes } = require('node:crypto');
const { todayJst } = require('./planner-dates');

const MAX_MEMO_LENGTH = 300;
const MAX_LIST_TITLE_LENGTH = 40;
const MAX_ENTRY_LENGTH = 60;
const MAX_ENTRIES_PER_LIST = 50;
const MAX_LISTS_PER_USER = 20;

// パスワード・暗証番号・カード番号っぽいもの（ライムはメモしない。安藤さんと決めた）
const SECRET_WORDS = Object.freeze([
  'パスワード', 'ぱすわーど', 'パスコード', 'passcode', 'password', 'ＰＩＮ',
  '暗証', 'あんしょう', 'セキュリティコード', 'カード番号', '口座番号', 'ログイン情報',
  '認証コード', 'ワンタイム', '秘密の質問',
]);
const SECRET_PATTERNS = Object.freeze([
  /\bpin\b/i,
  /\bpass(?:word)?\s*[:：=]/i,
  // カード番号のような長い数字（16桁前後）
  /(?:\d[\s-]?){13,19}/,
]);

function cleanText(value, maxLength) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

/** メモしてはいけないもの（パスワードなど）か */
function looksSecret(text) {
  const value = String(text || '');
  if (!value) return false;
  const lower = value.toLowerCase();
  return SECRET_WORDS.some((word) => lower.includes(word.toLowerCase())) ||
    SECRET_PATTERNS.some((pattern) => pattern.test(value));
}

function newEntryId() {
  return `e${randomBytes(4).toString('hex')}`;
}

/** チェックした日（日本時間）が今日より前の項目を外す */
function pruneCheckedEntries(entries, now = new Date()) {
  if (!Array.isArray(entries)) return [];
  const today = todayJst(now);
  return entries.filter((entry) => {
    if (!entry?.checked) return true;
    const at = Date.parse(entry.checkedAt || '');
    if (!Number.isFinite(at)) return true;
    return todayJst(new Date(at)) >= today;
  });
}

/** 保存できる形にそろえる（id が無ければ作る、長さを切る、数を抑える） */
function normalizeEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of entries) {
    const text = cleanText(typeof raw === 'string' ? raw : raw?.text, MAX_ENTRY_LENGTH);
    if (!text) continue;
    let id = typeof raw === 'object' && raw && /^e[0-9a-f]{8}$/.test(String(raw.id || '')) ? raw.id : newEntryId();
    while (seen.has(id)) id = newEntryId();
    seen.add(id);
    const checked = typeof raw === 'object' && raw ? Boolean(raw.checked) : false;
    out.push({
      id,
      text,
      checked,
      ...(checked ? { checkedAt: String(raw.checkedAt || new Date().toISOString()) } : {}),
    });
    if (out.length >= MAX_ENTRIES_PER_LIST) break;
  }
  return out;
}

/** 比べるための形（空白・かなの大小・記号を気にしない） */
function keyOf(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s、。・,.!！?？「」『』（）()]/g, '');
}

// 同じリストを指す言い方（「買うもの」「買い物リスト」「買い物メモ」）
const LIST_ALIASES = Object.freeze([
  [/^(?:買うもの|かうもの|買い物|かいもの|買いもの|買い出し|かいだし)(?:メモ)?$/, 'かいもの'],
  [/^(?:持ち物|もちもの|持っていくもの|もっていくもの)(?:メモ)?$/, 'もちもの'],
  [/^(?:やること|やる事|todo|タスク)(?:メモ)?$/, 'やること'],
]);

/** リストの名前を比べる形に（「リスト」を外し、言い方の違いをそろえる） */
function listKeyOf(name) {
  const key = keyOf(name).replace(/(?:リスト|りすと)$/, '');
  for (const [pattern, alias] of LIST_ALIASES) {
    if (pattern.test(key)) return alias;
  }
  return key;
}

/** 名前（「買うもの」「買い物リスト」）からリストを探す。無ければ null */
function findListByName(lists, name) {
  const key = listKeyOf(name);
  if (!key) return null;
  const exact = lists.filter((list) => listKeyOf(list.title) === key);
  if (exact.length === 1) return exact[0];
  const loose = lists.filter((list) => {
    const title = listKeyOf(list.title);
    return title && (title.includes(key) || key.includes(title));
  });
  return loose.length === 1 ? loose[0] : null;
}

/** 言われた言葉に当たる項目を探す（「牛乳」→「牛乳 2本」も当たる） */
function matchEntries(entries, words) {
  const keys = (Array.isArray(words) ? words : [words]).map(keyOf).filter(Boolean);
  if (keys.length === 0) return [];
  return entries.filter((entry) => {
    const key = keyOf(entry.text);
    return keys.some((word) => key === word || key.includes(word) || word.includes(key));
  });
}

module.exports = {
  MAX_MEMO_LENGTH,
  MAX_LIST_TITLE_LENGTH,
  MAX_ENTRY_LENGTH,
  MAX_ENTRIES_PER_LIST,
  MAX_LISTS_PER_USER,
  looksSecret,
  newEntryId,
  pruneCheckedEntries,
  normalizeEntries,
  keyOf,
  listKeyOf,
  findListByName,
  matchEntries,
};
