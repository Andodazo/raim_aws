'use strict';

// ==============================================================================
// ユーザー記憶ストア（userMemory）
// ==============================================================================
//
// スレッドを跨いだ記憶を UserSession テーブルへ保存する。
//
// 【なぜスレッドと別に持つのか】
//
// スレッドの sessionSummary は「このスレッドは何の話だったか」で、
// 別のスレッドを開いたときには読まれない。
//
//   スレッドA（3日前）: 卒業制作の相談
//   スレッドB（今日）  : 「疲れた〜」と雑談
//
// スレッドB でライムが「制作、まだ詰まってる感じ?」と言えるようにするには、
// スレッドを越えて参照される場所に記憶を置く必要がある。それが userMemory。
//
// 全スレッドのフル履歴を毎回送ることはできない（10スレッドで10万文字）ため、
// 圧縮して持ち回るしかない。要約でしか実現できない機能。
//
// 【構造】
//
//   ConversationThread (sub, threadId)
//     └ sessionSummary  「このスレッドは何の話だったか」
//           ↓ 集約
//   UserSession (sub)
//     └ userMemory      「この人はどんな人か」

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');

const TABLE_NAME = process.env.USER_SESSION_TABLE_NAME || 'RAiM-UserSession-dev';
const REGION = process.env.AWS_REGION || 'ap-northeast-1';

let cachedDocClient = null;

function getDocClient() {
  if (!cachedDocClient) {
    cachedDocClient = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: REGION }),
      { marshallOptions: { removeUndefinedValues: true } }
    );
  }
  return cachedDocClient;
}

/**
 * ユーザー記憶を取得する。
 */
async function getUserMemory(sub, deps = {}) {
  if (!sub) {
    throw new Error('sub is required');
  }

  const client = deps.docClient || getDocClient();

  const result = await client.send(
    new GetCommand({
      TableName: deps.tableName || TABLE_NAME,
      Key: { sub },
    })
  );

  return result.Item ? result.Item.userMemory || '' : '';
}

/**
 * ユーザー記憶を保存する。
 *
 * UserSession の項目自体は Core Lambda が作成済みの想定だが、
 * 週次バッチが先に走る可能性もあるため UpdateCommand で upsert する。
 *
 * @param {string} sub
 * @param {string} memory 整形済みの記憶テキスト
 */
async function updateUserMemory(sub, memory, deps = {}) {
  if (!sub) {
    throw new Error('sub is required');
  }

  if (!memory || !String(memory).trim()) {
    // 空で既存の記憶を潰さない。
    return null;
  }

  const client = deps.docClient || getDocClient();
  const now = (deps.now ? deps.now() : new Date()).toISOString();

  const result = await client.send(
    new UpdateCommand({
      TableName: deps.tableName || TABLE_NAME,
      Key: { sub },
      UpdateExpression: [
        'SET userMemory = :memory',
        'userMemoryUpdatedAt = :now',
        'updatedAt = :now',
      ].join(', '),
      ExpressionAttributeValues: {
        ':memory': String(memory).trim(),
        ':now': now,
      },
      ReturnValues: 'ALL_NEW',
    })
  );

  return result.Attributes;
}

module.exports = {
  TABLE_NAME,
  getUserMemory,
  updateUserMemory,
};
