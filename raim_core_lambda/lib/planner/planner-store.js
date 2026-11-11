'use strict';

// ==============================================================================
// 予定とメモのテーブル（Core Lambda 版）
// ==============================================================================
//
// 【テーブル】
//   RAiM-Planner-dev（環境変数 PLANNER_TABLE_NAME で変えられる）
//   パーティションキー sub / ソートキー itemId
//   TTL: expiresAt（終わった予定は7日後に DynamoDB が消す）
//
// 【項目の種類（kind）】
//   event   予定（「金曜10時に面接」）
//   timer   タイマー（「3分計って」）。endsAt に鳴る時刻、鳴って10分たつと一覧から消える
//   ※ メモ・あとで聞くことは、あとから同じテーブルに足す
//
// Edge Lambda 側にも同じテーブルを読み書きする planner-store.js がある
// （一覧・手で直す・消す）。各 Lambda が独立したパッケージなので実装は分かれている。
// 項目の形を変えるときは両方そろえること。
//
// 【注意】`sub` は DynamoDB の予約語。式の中では ExpressionAttributeNames で別名にする。
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
const { randomUUID } = require('node:crypto');
const { expiresAtForEvent } = require('./planner-dates');

const TABLE_NAME = process.env.PLANNER_TABLE_NAME || 'RAiM-Planner-dev';
const REGION = process.env.AWS_REGION || 'ap-northeast-1';

// 1人が持てる予定の数。ライムに一覧を渡すので、多すぎると長くなる
const MAX_ITEMS_PER_USER = Number(process.env.PLANNER_MAX_ITEMS || 200);

const MAX_TITLE_LENGTH = 40;
const MAX_NOTE_LENGTH = 100;
const MAX_LINE_LENGTH = 80;

const IMPORTANCE = Object.freeze(['important', 'normal', 'chore']);

// タイマーの長さの上限（これより長いものは予定にする。安藤さんと決めた）
const MAX_TIMER_SECONDS = 24 * 60 * 60;
// 鳴ったあと、一覧に残しておく時間（「5分後にもう一回」の分も見て少し長め）
const TIMER_KEEP_SECONDS = 10 * 60;
// 1人が同時に動かせるタイマーの数
const MAX_ACTIVE_TIMERS = 10;

let cachedDocClient = null;
function defaultDocClient() {
  cachedDocClient ||= DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  return cachedDocClient;
}

function cleanText(value, maxLength) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function cleanLines(lines) {
  const out = {};
  for (const key of ['eve', 'before', 'morning']) {
    const text = cleanText(lines?.[key], MAX_LINE_LENGTH);
    if (text) out[key] = text;
  }
  return out;
}

/**
 * アプリやライムに返す形（sub は外す）。
 */
function toPublicItem(item) {
  if (!item) return null;
  const { sub: _sub, ...rest } = item;
  return rest;
}

function createPlannerStore({ docClient, tableName = TABLE_NAME, now = () => new Date() } = {}) {
  const client = () => docClient || defaultDocClient();

  /**
   * その人の項目を全部返す（予定・あとでほかの種類も）。古いもの（TTL 待ち）も含む。
   */
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
    return items.map(toPublicItem);
  }

  /**
   * 項目を1つ読む。無ければ null。
   */
  async function getItem(sub, itemId) {
    const result = await client().send(new GetCommand({
      TableName: tableName,
      Key: { sub, itemId },
    }));
    return toPublicItem(result.Item);
  }

  /**
   * 予定を足す。
   *
   * @param {string} sub
   * @param {{ title, date, time?, note?, source?, importance?, lines? }} input  検証済みのもの
   */
  async function addEvent(sub, input) {
    const timestamp = now().toISOString();
    const item = {
      sub,
      itemId: `ev_${randomUUID()}`,
      kind: 'event',
      title: cleanText(input.title, MAX_TITLE_LENGTH),
      date: input.date,
      time: input.time || '',
      note: cleanText(input.note, MAX_NOTE_LENGTH),
      importance: IMPORTANCE.includes(input.importance) ? input.importance : 'normal',
      lines: cleanLines(input.lines),
      // 知らせる文と大事さを LLM に作らせたか（手で足したものは、あとで作る）
      enriched: Boolean(input.enriched),
      source: ['raim', 'manual', 'suggest'].includes(input.source) ? input.source : 'raim',
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: expiresAtForEvent(input.date),
    };

    await client().send(new PutCommand({
      TableName: tableName,
      Item: item,
      ConditionExpression: 'attribute_not_exists(itemId)',
    }));
    return toPublicItem(item);
  }

  /**
   * タイマーを足す。鳴ったあと少しして一覧から消えるよう、expiresAt を終わる時刻の少しあとにする
   * （DynamoDB の TTL は遅れて消すので、一覧では expiresAt を過ぎたものを見せない）。
   *
   * @param {string} sub
   * @param {{ title?, durationSec, source? }} input  検証済みのもの
   */
  async function addTimer(sub, input) {
    const start = now();
    const durationSec = Math.max(1, Math.round(Number(input.durationSec) || 0));
    const endsAtMs = start.getTime() + durationSec * 1000;
    const item = {
      sub,
      itemId: `tm_${randomUUID()}`,
      kind: 'timer',
      title: cleanText(input.title, MAX_TITLE_LENGTH) || 'タイマー',
      durationSec,
      endsAt: new Date(endsAtMs).toISOString(),
      source: ['raim', 'manual'].includes(input.source) ? input.source : 'raim',
      createdAt: start.toISOString(),
      updatedAt: start.toISOString(),
      expiresAt: Math.floor(endsAtMs / 1000) + TIMER_KEEP_SECONDS,
    };
    await client().send(new PutCommand({
      TableName: tableName,
      Item: item,
      ConditionExpression: 'attribute_not_exists(itemId)',
    }));
    return toPublicItem(item);
  }

  /**
   * 項目を一部だけ直す。無ければ null。
   *
   * 日付を直したら、消す日（expiresAt）も合わせて直す。
   */
  async function updateItem(sub, itemId, changes) {
    const names = { '#updatedAt': 'updatedAt' };
    const values = { ':updatedAt': now().toISOString() };
    const sets = ['#updatedAt = :updatedAt'];

    const put = (field, value) => {
      names[`#${field}`] = field;
      values[`:${field}`] = value;
      sets.push(`#${field} = :${field}`);
    };

    if (changes.title !== undefined) put('title', cleanText(changes.title, MAX_TITLE_LENGTH));
    if (changes.date !== undefined) {
      put('date', changes.date);
      put('expiresAt', expiresAtForEvent(changes.date));
    }
    if (changes.time !== undefined) put('time', changes.time || '');
    if (changes.note !== undefined) put('note', cleanText(changes.note, MAX_NOTE_LENGTH));
    if (changes.importance !== undefined && IMPORTANCE.includes(changes.importance)) {
      put('importance', changes.importance);
    }
    if (changes.lines !== undefined) put('lines', cleanLines(changes.lines));
    if (changes.enriched !== undefined) put('enriched', Boolean(changes.enriched));

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
      return toPublicItem(result.Attributes);
    } catch (error) {
      if (error?.name === 'ConditionalCheckFailedException') return null;
      throw error;
    }
  }

  /**
   * 項目を消す。消したら消す前の中身、無ければ null。
   */
  async function deleteItem(sub, itemId) {
    const result = await client().send(new DeleteCommand({
      TableName: tableName,
      Key: { sub, itemId },
      ReturnValues: 'ALL_OLD',
    }));
    return toPublicItem(result.Attributes);
  }

  return { listItems, getItem, addEvent, addTimer, updateItem, deleteItem };
}

const defaultPlannerStore = createPlannerStore();

module.exports = {
  TABLE_NAME,
  MAX_ITEMS_PER_USER,
  MAX_TITLE_LENGTH,
  MAX_NOTE_LENGTH,
  IMPORTANCE,
  MAX_TIMER_SECONDS,
  MAX_ACTIVE_TIMERS,
  createPlannerStore,
  defaultPlannerStore,
  toPublicItem,
};
