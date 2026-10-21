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
 * 記憶の世代番号を読む。まだ無ければ null。
 *
 * スレッドを削除するたびに Edge が1つ進める（同時に記憶を空にする）。
 * 記憶を作り始める前にこれを読んでおき、保存するときに変わっていないか確かめる。
 * 削除の直後に読むことがあるので、強い整合性で読む。
 */
async function getMemoryGeneration(sub, deps = {}) {
  if (!sub) {
    throw new Error('sub is required');
  }

  const client = deps.docClient || getDocClient();

  const result = await client.send(
    new GetCommand({
      TableName: deps.tableName || TABLE_NAME,
      Key: { sub },
      ProjectionExpression: 'memoryGeneration',
      ConsistentRead: true,
    })
  );

  const value = result.Item?.memoryGeneration;
  return value === undefined || value === null ? null : Number(value);
}

/**
 * 保存しようとしたら、作り始めてから記憶の世代が変わっていた（間にスレッドが消された）。
 */
class MemoryGenerationChangedError extends Error {
  constructor() {
    super('userMemory generation changed while it was being rebuilt');
    this.name = 'MemoryGenerationChangedError';
  }
}

/**
 * ユーザー記憶を保存する。
 *
 * UserSession の項目自体は Core Lambda が作成済みの想定だが、
 * 週次バッチが先に走る可能性もあるため UpdateCommand で upsert する。
 *
 * deps.expectedGeneration を渡すと、世代番号がその値のままのときだけ保存する
 * （null は「まだ番号が無い」）。作っている間にスレッドが消されていたら
 * MemoryGenerationChangedError を投げる。消した会話の内容を含む古い記憶を、
 * 削除のあとで書き戻さないため。
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

  const values = {
    ':memory': String(memory).trim(),
    ':now': now,
  };

  let condition;
  if (deps.expectedGeneration === null) {
    condition = 'attribute_not_exists(memoryGeneration)';
  } else if (deps.expectedGeneration !== undefined) {
    condition = 'memoryGeneration = :generation';
    values[':generation'] = Number(deps.expectedGeneration);
  }

  try {
    const result = await client.send(
      new UpdateCommand({
        TableName: deps.tableName || TABLE_NAME,
        Key: { sub },
        UpdateExpression: [
          'SET userMemory = :memory',
          'userMemoryUpdatedAt = :now',
          'updatedAt = :now',
        ].join(', '),
        ...(condition ? { ConditionExpression: condition } : {}),
        ExpressionAttributeValues: values,
        ReturnValues: 'ALL_NEW',
      })
    );

    return result.Attributes;
  } catch (error) {
    if (error?.name === 'ConditionalCheckFailedException') {
      throw new MemoryGenerationChangedError();
    }
    throw error;
  }
}

/**
 * ユーザー記憶を消す。
 *
 * updateUserMemory は空文字を弾く（要約生成が失敗したときに
 * 既存の記憶を潰さないため）ので、意図的な消去は専用の関数にする。
 *
 * スレッドを全部削除したときに使う。ここで消さないと
 * 「会話を全部消したのにライムが覚えている」状態になる。
 */
async function clearUserMemory(sub, deps = {}) {
  if (!sub) {
    throw new Error('sub is required');
  }

  const client = deps.docClient || getDocClient();
  const now = (deps.now ? deps.now() : new Date()).toISOString();

  const result = await client.send(
    new UpdateCommand({
      TableName: deps.tableName || TABLE_NAME,
      Key: { sub },
      UpdateExpression: [
        'SET userMemory = :empty',
        'userMemoryUpdatedAt = :now',
        'updatedAt = :now',
      ].join(', '),
      ExpressionAttributeValues: { ':empty': '', ':now': now },
      ReturnValues: 'ALL_NEW',
    })
  );

  return result.Attributes;
}

module.exports = {
  TABLE_NAME,
  MemoryGenerationChangedError,
  getMemoryGeneration,
  getUserMemory,
  updateUserMemory,
  clearUserMemory,
};
