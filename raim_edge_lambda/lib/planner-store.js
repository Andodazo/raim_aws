'use strict';

// ==============================================================================
// 予定とメモのテーブル（Edge Lambda 版）
// ==============================================================================
//
// 「予定とメモ」画面の一覧・手で足す・直す・消すは、LLM を通さないので
// Edge が DynamoDB を直接読み書きして返す（覚えていることの画面と同じ考え方）。
//
// 【テーブル】 RAiM-Planner-dev（PLANNER_TABLE_NAME）
//   パーティションキー sub / ソートキー itemId / TTL expiresAt
//
// Core Lambda 側にも同じテーブルを読み書きする lib/planner/planner-store.js がある。
// 項目の形を変えるときは両方そろえること。
//
// 【項目の種類】 event 予定 / timer タイマー / memo メモ / list チェックできるリスト
//   list の entries: [{ id, text, checked, checkedAt }]。チェックした項目は次の日（日本時間）に
//   見せなくなり、次に書くときに保存からも外す（Core の planner-memo.js と同じ決まり）。
// ==============================================================================

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');
const { randomBytes, randomUUID } = require('node:crypto');

const TABLE_NAME = process.env.PLANNER_TABLE_NAME || 'RAiM-Planner-dev';
const REGION = process.env.AWS_REGION || 'ap-northeast-1';

const MAX_ITEMS_PER_USER = Number(process.env.PLANNER_MAX_ITEMS || 200);
const MAX_TITLE_LENGTH = 40;
const MAX_NOTE_LENGTH = 100;

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// 終わった予定を残す日数（Core と同じ）
const KEEP_DAYS_AFTER_EVENT = 7;
const MAX_DAYS_AHEAD = 400;

// メモ帳（Core の planner-memo.js と同じ）
const MAX_MEMO_LENGTH = 300;
const MAX_LIST_TITLE_LENGTH = 40;
const MAX_ENTRY_LENGTH = 60;
const MAX_ENTRIES_PER_LIST = 50;
const MAX_LISTS_PER_USER = 20;

class PlannerInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlannerInputError';
    this.code = 'INVALID_INPUT';
  }
}

let cachedDocClient = null;
function defaultDocClient() {
  cachedDocClient ||= DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  return cachedDocClient;
}

// ─────────────────────────────────────────────
// 日付（日本時間）
// ─────────────────────────────────────────────

function todayJst(now = new Date()) {
  const shifted = new Date(now.getTime() + JST_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function dateToUtcMs(date) {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function normalizeTime(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function checkEventDate(date, now) {
  if (!isValidDate(date)) throw new PlannerInputError('date must be YYYY-MM-DD');
  const diff = Math.round((dateToUtcMs(date) - dateToUtcMs(todayJst(now))) / DAY_MS);
  if (diff < -1 || diff > MAX_DAYS_AHEAD) throw new PlannerInputError('date is out of range');
}

/** 予定の日の7日後の終わり（日本時間）を epoch 秒で */
function expiresAtForEvent(date) {
  return Math.floor((dateToUtcMs(date) + (KEEP_DAYS_AFTER_EVENT + 1) * DAY_MS - JST_OFFSET_MS) / 1000);
}

function cleanText(value, maxLength) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

// ─────────────────────────────────────────────
// リストの項目
// ─────────────────────────────────────────────

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

/**
 * アプリから来た項目をそろえる。id が無ければ作る。チェックを付けた時刻は、
 * 前から付いていればそのまま、新しく付けたなら今にする。
 */
function normalizeEntries(entries, previous = [], now = new Date()) {
  if (!Array.isArray(entries)) throw new PlannerInputError('entries must be an array');
  const before = new Map((previous || []).map((e) => [e.id, e]));
  const out = [];
  const seen = new Set();
  for (const raw of entries) {
    const text = cleanText(typeof raw === 'string' ? raw : raw?.text, MAX_ENTRY_LENGTH);
    if (!text) continue;
    let id = raw && typeof raw === 'object' && /^e[0-9a-f]{8}$/.test(String(raw.id || '')) ? raw.id : newEntryId();
    while (seen.has(id)) id = newEntryId();
    seen.add(id);
    const checked = Boolean(raw && typeof raw === 'object' && raw.checked);
    const old = before.get(id);
    const entry = { id, text, checked };
    if (checked) entry.checkedAt = old?.checked && old.checkedAt ? old.checkedAt : now.toISOString();
    out.push(entry);
    if (out.length >= MAX_ENTRIES_PER_LIST) break;
  }
  return pruneCheckedEntries(out, now);
}

function toPublicItem(item) {
  if (!item) return null;
  const { sub: _sub, ...rest } = item;
  return rest;
}

// ─────────────────────────────────────────────
// 読み書き
// ─────────────────────────────────────────────

function createPlannerStore({ docClient, tableName = TABLE_NAME, now = () => new Date() } = {}) {
  const client = () => docClient || defaultDocClient();

  async function listItems(sub) {
    const items = [];
    let startKey;
    do {
      const result = await client().send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: '#sub = :sub',
        ExpressionAttributeNames: { '#sub': 'sub' },
        ExpressionAttributeValues: { ':sub': sub },
        ExclusiveStartKey: startKey,
      }));
      items.push(...(result.Items || []));
      startKey = result.LastEvaluatedKey;
    } while (startKey && items.length < MAX_ITEMS_PER_USER * 2);

    // TTL で消える前の、もう残す期間を過ぎたものは見せない
    const nowSec = Math.floor(now().getTime() / 1000);
    return items
      .filter((item) => !item.expiresAt || Number(item.expiresAt) > nowSec)
      .map(visible);
  }

  /** リストは、前の日までにチェックした項目を外して返す */
  function visible(item) {
    const out = toPublicItem(item);
    if (out?.kind === 'list') out.entries = pruneCheckedEntries(out.entries, now());
    return out;
  }

  async function putNew(item) {
    await client().send(new PutCommand({
      TableName: tableName,
      Item: item,
      ConditionExpression: 'attribute_not_exists(itemId)',
    }));
    return visible(item);
  }

  /**
   * 手でメモかリストを足す（「予定とメモ」画面のメモタブ）。
   *
   * @param {{ kind: 'memo'|'list', text?, title?, entries? }} input
   * @param {{ items?: object[] }} options  今の一覧（数の上限を見る）
   */
  async function addMemoOrList(sub, input, { items = [] } = {}) {
    if (items.length >= MAX_ITEMS_PER_USER) throw new PlannerInputError('too many items');
    const timestamp = now().toISOString();
    if (input?.kind === 'list') {
      const title = cleanText(input.title, MAX_LIST_TITLE_LENGTH);
      if (!title) throw new PlannerInputError('title is required');
      if (items.filter((i) => i.kind === 'list').length >= MAX_LISTS_PER_USER) {
        throw new PlannerInputError('too many lists');
      }
      return putNew({
        sub,
        itemId: `ls_${randomUUID()}`,
        kind: 'list',
        title,
        entries: normalizeEntries(input.entries || [], [], now()),
        source: 'manual',
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
    const text = cleanText(input?.text, MAX_MEMO_LENGTH);
    if (!text) throw new PlannerInputError('text is required');
    return putNew({
      sub,
      itemId: `mm_${randomUUID()}`,
      kind: 'memo',
      text,
      source: 'manual',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  /**
   * 手で直す。種類を読んでから、予定・メモ・リストそれぞれの直し方にする。
   * タイマーは直せない（止めるときは消す）。
   *
   * @returns {Promise<{ item: object|null, needsEnrich: boolean }>}
   */
  async function updateItem(sub, itemId, changes = {}) {
    const current = await client().send(new GetCommand({ TableName: tableName, Key: { sub, itemId } }));
    const existing = current.Item;
    if (!existing) return { item: null, needsEnrich: false };
    if (existing.kind === 'event' || !existing.kind) return updateEvent(sub, itemId, changes);
    if (existing.kind === 'memo') {
      const text = cleanText(changes.text, MAX_MEMO_LENGTH);
      if (!text) throw new PlannerInputError('text must not be empty');
      return { item: await setFields(sub, itemId, { text }), needsEnrich: false };
    }
    if (existing.kind === 'list') {
      const fields = {};
      if (changes.title !== undefined) {
        const title = cleanText(changes.title, MAX_LIST_TITLE_LENGTH);
        if (!title) throw new PlannerInputError('title must not be empty');
        fields.title = title;
      }
      if (changes.entries !== undefined) {
        fields.entries = normalizeEntries(changes.entries, existing.entries, now());
      }
      if (Object.keys(fields).length === 0) throw new PlannerInputError('nothing to change');
      return { item: await setFields(sub, itemId, fields), needsEnrich: false };
    }
    throw new PlannerInputError('this item cannot be changed');
  }

  async function setFields(sub, itemId, fields) {
    const names = { '#updatedAt': 'updatedAt' };
    const values = { ':updatedAt': now().toISOString() };
    const sets = ['#updatedAt = :updatedAt'];
    for (const [field, value] of Object.entries(fields)) {
      names[`#${field}`] = field;
      values[`:${field}`] = value;
      sets.push(`#${field} = :${field}`);
    }
    try {
      const result = await client().send(new UpdateCommand({
        TableName: tableName,
        Key: { sub, itemId },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: 'attribute_exists(itemId)',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }));
      return visible(result.Attributes);
    } catch (error) {
      if (error?.name === 'ConditionalCheckFailedException') return null;
      throw error;
    }
  }

  /**
   * 手で予定を足す（「予定とメモ」画面、「予定に入れる？」ボタン）。
   * 知らせる文はまだ無い（Core があとで作る。それまではアプリの決まり文句）。
   */
  async function addEvent(sub, input, { count = 0 } = {}) {
    const title = cleanText(input?.title, MAX_TITLE_LENGTH);
    if (!title) throw new PlannerInputError('title is required');
    const date = String(input?.date || '').trim();
    checkEventDate(date, now());
    const time = normalizeTime(input?.time);
    if (time === null) throw new PlannerInputError('time must be HH:mm');
    if (count >= MAX_ITEMS_PER_USER) throw new PlannerInputError('too many items');

    const timestamp = now().toISOString();
    const item = {
      sub,
      itemId: `ev_${randomUUID()}`,
      kind: 'event',
      title,
      date,
      time,
      note: cleanText(input?.note, MAX_NOTE_LENGTH),
      importance: 'normal',
      lines: {},
      enriched: false,
      source: input?.source === 'suggest' ? 'suggest' : 'manual',
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: expiresAtForEvent(date),
    };
    await client().send(new PutCommand({
      TableName: tableName,
      Item: item,
      ConditionExpression: 'attribute_not_exists(itemId)',
    }));
    return toPublicItem(item);
  }

  /**
   * 手で予定を直す。名前か日時を変えたら、知らせる文を作り直すため enriched を false に戻す。
   *
   * @returns {Promise<{ item: object|null, needsEnrich: boolean }>}
   */
  async function updateEvent(sub, itemId, changes = {}) {
    const names = { '#updatedAt': 'updatedAt' };
    const values = { ':updatedAt': now().toISOString() };
    const sets = ['#updatedAt = :updatedAt'];
    const put = (field, value) => {
      names[`#${field}`] = field;
      values[`:${field}`] = value;
      sets.push(`#${field} = :${field}`);
    };
    let needsEnrich = false;

    if (changes.title !== undefined) {
      const title = cleanText(changes.title, MAX_TITLE_LENGTH);
      if (!title) throw new PlannerInputError('title must not be empty');
      put('title', title);
      needsEnrich = true;
    }
    if (changes.date !== undefined) {
      const date = String(changes.date || '').trim();
      checkEventDate(date, now());
      put('date', date);
      put('expiresAt', expiresAtForEvent(date));
      needsEnrich = true;
    }
    if (changes.time !== undefined) {
      const time = normalizeTime(changes.time);
      if (time === null) throw new PlannerInputError('time must be HH:mm');
      put('time', time);
      needsEnrich = true;
    }
    if (changes.note !== undefined) put('note', cleanText(changes.note, MAX_NOTE_LENGTH));
    if (sets.length === 1) throw new PlannerInputError('nothing to change');
    if (needsEnrich) put('enriched', false);

    try {
      const result = await client().send(new UpdateCommand({
        TableName: tableName,
        Key: { sub, itemId },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ConditionExpression: 'attribute_exists(itemId)',
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      }));
      return { item: visible(result.Attributes), needsEnrich };
    } catch (error) {
      if (error?.name === 'ConditionalCheckFailedException') return { item: null, needsEnrich: false };
      throw error;
    }
  }

  async function deleteItem(sub, itemId) {
    const result = await client().send(new DeleteCommand({
      TableName: tableName,
      Key: { sub, itemId },
      ReturnValues: 'ALL_OLD',
    }));
    return toPublicItem(result.Attributes);
  }

  return { listItems, addEvent, addMemoOrList, updateEvent, updateItem, deleteItem };
}

module.exports = {
  TABLE_NAME,
  PlannerInputError,
  createPlannerStore,
  expiresAtForEvent,
  todayJst,
  pruneCheckedEntries,
};
