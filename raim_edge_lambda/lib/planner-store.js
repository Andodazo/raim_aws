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
// ==============================================================================

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  DeleteCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');
const { randomUUID } = require('node:crypto');

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
      .map(toPublicItem);
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
      return { item: toPublicItem(result.Attributes), needsEnrich };
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

  return { listItems, addEvent, updateEvent, deleteItem };
}

module.exports = {
  TABLE_NAME,
  PlannerInputError,
  createPlannerStore,
  expiresAtForEvent,
  todayJst,
};
