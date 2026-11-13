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
//   timer   タイマー（「3分計って」）。endsAt に鳴る時刻、鳴って3時間たつと一覧から消える
//   memo    普通のメモ（「駐輪場は3階」）。自動では消さない
//   list    チェックできるリスト（「買うもの」）。チェックした項目は次の日に消す（planner-memo.js）
//   weather その日の気温の控え（朝のまとめで「昨日より寒い」を言うため。itemId は wx_YYYY-MM-DD、3日で消える）
//   brief   その日の朝のまとめを言った印（全部の端末で1日1回にするため。itemId は bf_YYYY-MM-DD、2日で消える）
//   followup あとで聞くこと（「予定に入れる？」ボタンが押されなかったもの。follow-up.js）。
//           予定の一覧には出さない。予定の日の7日後に消える
//
// 予定とあとで聞くことは、終わったあと一度聞いたら askedAt を付ける（もう聞かない）。
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
const {
  MAX_MEMO_LENGTH,
  MAX_LIST_TITLE_LENGTH,
  normalizeEntries,
  pruneCheckedEntries,
} = require('./planner-memo');

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
// 鳴ったあと、サーバーに残しておく時間。アプリの一覧には鳴った時点で出さないが、
// スマホで通知をあとから押したときに、ライムが何のタイマーだったか分かるように残す
const TIMER_KEEP_SECONDS = 3 * 60 * 60;
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

  /** リストは、前の日までにチェックした項目を外して返す */
  const visible = (item) => {
    const out = toPublicItem(item);
    if (out?.kind === 'list') out.entries = pruneCheckedEntries(out.entries, now());
    return out;
  };

  async function putNew(item) {
    await client().send(new PutCommand({
      TableName: tableName,
      Item: item,
      ConditionExpression: 'attribute_not_exists(itemId)',
    }));
    return visible(item);
  }

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
    return items.map(visible);
  }

  /**
   * 項目を1つ読む。無ければ null。
   */
  async function getItem(sub, itemId) {
    const result = await client().send(new GetCommand({
      TableName: tableName,
      Key: { sub, itemId },
    }));
    return visible(result.Item);
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
   * 普通のメモを足す。
   *
   * @param {string} sub
   * @param {{ text, source? }} input  検証済みのもの
   */
  async function addMemo(sub, input) {
    const timestamp = now().toISOString();
    return putNew({
      sub,
      itemId: `mm_${randomUUID()}`,
      kind: 'memo',
      text: cleanText(input.text, MAX_MEMO_LENGTH),
      source: ['raim', 'manual'].includes(input.source) ? input.source : 'raim',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  /**
   * リストを作る。
   *
   * @param {string} sub
   * @param {{ title, entries?: (string|object)[], source? }} input
   */
  async function addList(sub, input) {
    const timestamp = now().toISOString();
    return putNew({
      sub,
      itemId: `ls_${randomUUID()}`,
      kind: 'list',
      title: cleanText(input.title, MAX_LIST_TITLE_LENGTH),
      entries: normalizeEntries(input.entries),
      source: ['raim', 'manual'].includes(input.source) ? input.source : 'raim',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  /**
   * あとで聞くことを足す（「予定に入れる？」ボタンを出したもの）。
   *
   * @param {string} sub
   * @param {{ title, date, time? }} candidate  findEventCandidate の結果
   */
  async function addFollowUp(sub, candidate) {
    const timestamp = now().toISOString();
    return putNew({
      sub,
      itemId: `fu_${randomUUID()}`,
      kind: 'followup',
      title: cleanText(candidate.title, MAX_TITLE_LENGTH),
      date: candidate.date,
      time: candidate.time || '',
      importance: 'normal',
      source: 'suggest',
      createdAt: timestamp,
      updatedAt: timestamp,
      expiresAt: expiresAtForEvent(candidate.date),
    });
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
    // 終わったあと聞いた（または本人が先に話した）時刻
    if (changes.askedAt !== undefined) put('askedAt', String(changes.askedAt));
    // メモの文、リストの名前と項目（項目は全部入れ替える）
    if (changes.text !== undefined) put('text', cleanText(changes.text, MAX_MEMO_LENGTH));
    if (changes.listTitle !== undefined) put('title', cleanText(changes.listTitle, MAX_LIST_TITLE_LENGTH));
    if (changes.entries !== undefined) {
      put('entries', normalizeEntries(pruneCheckedEntries(changes.entries, now())));
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

  /**
   * その日の気温を控えておく（朝のまとめ）。同じ日なら上書きする。
   */
  async function saveWeather(sub, { date, max, min, keepDays = 3 }) {
    const [y, m, d] = String(date).split('-').map(Number);
    const expiresAt = Math.floor(Date.UTC(y, m - 1, d + keepDays) / 1000);
    await client().send(new PutCommand({
      TableName: tableName,
      Item: {
        sub,
        itemId: `wx_${date}`,
        kind: 'weather',
        date,
        max: Math.round(Number(max)),
        min: Math.round(Number(min)),
        updatedAt: now().toISOString(),
        expiresAt,
      },
    }));
  }

  /**
   * 今日の朝のまとめを言ったことにする。もう言っていたら false。
   *
   * 以前は「その日はじめて」を端末ごとに覚えていたので、スマホで聞いたあと Windows を開くと
   * もう1回まとめていた。サーバーに印（bf_YYYY-MM-DD、2日で消える）を置き、全部の端末で1日1回にする。
   * 2台同時に開いても1回になるよう、無いときだけ書く。
   */
  async function claimBrief(sub, date) {
    const [y, m, d] = String(date).split('-').map(Number);
    try {
      await client().send(new PutCommand({
        TableName: tableName,
        Item: {
          sub,
          itemId: `bf_${date}`,
          kind: 'brief',
          date,
          createdAt: now().toISOString(),
          expiresAt: Math.floor(Date.UTC(y, m - 1, d + 2) / 1000),
        },
        ConditionExpression: 'attribute_not_exists(itemId)',
      }));
      return true;
    } catch (error) {
      if (error?.name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }

  return {
    listItems, getItem, addEvent, addTimer, addMemo, addList, addFollowUp, updateItem, deleteItem, saveWeather,
    claimBrief,
  };
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
