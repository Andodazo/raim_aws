'use strict';

// ==============================================================================
// スレッド一覧ストア（Edge Lambda）
// ==============================================================================
//
// 「新しい会話」プルダウンに出すスレッド一覧を DynamoDB から直接引く。
//
// 【なぜ Core（SQS 経由）ではなく Edge で処理するのか】
//
// チャット送信が SQS 経由なのは、Core が Titan + Mantle で数秒かかり、
// API Gateway WebSocket の応答時間制限を超えうるためで、
// 非同期に切り離す必要があるから。
//
// 一方スレッド一覧は DynamoDB の Query 1回（10ms 程度）で終わる読み取り要求。
// これを SQS に載せると Edge → SQS → Core → SQS → Edge で
// **Lambda 起動が3回**必要になり、コールドスタート次第で数秒かかる。
// プルダウンを開くたびにこれでは体感が悪い。
//
// そのため「LLM 処理を伴う重い要求は非同期（SQS）、
// 読み取りのみの軽い要求は同期（Edge 直接）」という切り分けにしている。
//
// 【注意】`sub` は DynamoDB の予約語のため、KeyConditionExpression では
// ExpressionAttributeNames で別名にする必要がある。

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
} = require('@aws-sdk/lib-dynamodb');

const TABLE_NAME =
  process.env.CONVERSATION_THREAD_TABLE_NAME || 'RAiM-ConversationThread-dev';

const REGION = process.env.AWS_REGION || 'ap-northeast-1';

// 一覧に返す最大件数。プルダウンに数百件出しても使えないため上限を設ける。
const MAX_THREADS = Number(process.env.THREAD_LIST_LIMIT || 50);

// 履歴として返す最大件数。
const MAX_HISTORY_MESSAGES = Number(process.env.THREAD_HISTORY_LIMIT || 400);

// 履歴応答のバイト予算。
//
// Edge Lambda は config.maxWebSocketMessageBytes（既定 30KB）を超える
// 送信を PayloadTooLarge で弾く。これは API Gateway WebSocket の
// フレーム上限 32KB に合わせた最終防御。
//
// 日本語は UTF-8 で 1文字3バイトのため、件数だけで制限すると
// 長文が続いたときに上限を超える。そこで件数とバイト数の両方で打ち切る。
//
// 27KB にしているのは、応答の外枠（type / requestId / threadId / title /
// hasMore / totalMessages）と JSON のエスケープ分を 30KB との差に残すため。
//
// 実測での目安（1往復あたり 296B〜1.4KB）:
//   短文(20字)  約90往復 / 普通(50字) 約56往復 / 長め(100字) 約34往復
const MAX_HISTORY_BYTES = Number(process.env.THREAD_HISTORY_MAX_BYTES || 27000);

let cachedDocClient = null;

function getDocClient() {
  if (!cachedDocClient) {
    cachedDocClient = DynamoDBDocumentClient.from(
      new DynamoDBClient({ region: REGION })
    );
  }
  return cachedDocClient;
}

/**
 * ユーザーのスレッド一覧を取得する。
 *
 * messages と sessionSummary は重いので取得しない。
 * 一覧表示に必要な項目だけを ProjectionExpression で絞る。
 *
 * @param {string} sub
 * @param {Object} [deps] テスト用の差し替え
 * @returns {Promise<Array>} 更新が新しい順
 */
async function listThreads(sub, deps = {}) {
  if (!sub) {
    throw new Error('sub is required');
  }

  const client = deps.docClient || getDocClient();
  const tableName = deps.tableName || TABLE_NAME;

  const items = [];
  let lastEvaluatedKey;

  do {
    const result = await client.send(
      new QueryCommand({
        TableName: tableName,
        // sub は予約語なので別名が必須
        KeyConditionExpression: '#sub = :sub',
        ExpressionAttributeNames: { '#sub': 'sub' },
        ExpressionAttributeValues: { ':sub': sub },
        ProjectionExpression: 'threadId, title, turnCount, createdAt, updatedAt',
        ExclusiveStartKey: lastEvaluatedKey,
      })
    );

    items.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey && items.length < MAX_THREADS);

  // 更新が新しい順（プルダウンの並び）
  items.sort((a, b) =>
    String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
  );

  return items.slice(0, MAX_THREADS).map((item) => ({
    threadId: String(item.threadId || ''),
    title: String(item.title || '新しい会話'),
    turnCount: Number(item.turnCount) || 0,
    createdAt: String(item.createdAt || ''),
    updatedAt: String(item.updatedAt || ''),
  }));
}

/**
 * スレッドの会話履歴を取得する。
 *
 * 過去スレッドを開き直したときに、画面へメッセージを復元するために使う。
 * 一覧と同じく読み取りのみなので Edge から直接引く。
 *
 * 新しい方から MAX_HISTORY_MESSAGES 件、かつ MAX_HISTORY_BYTES 以内に収まる
 * ぶんだけ返す。打ち切った場合は hasMore=true を立てる。
 *
 * @param {string} sub
 * @param {string} threadId
 * @returns {Promise<{threadId, title, messages, hasMore, totalMessages}|null>}
 *          スレッドが存在しなければ null
 */
async function getThreadHistory(sub, threadId, deps = {}) {
  if (!sub || !threadId) {
    throw new Error('sub and threadId are required');
  }

  const client = deps.docClient || getDocClient();

  const result = await client.send(
    new GetCommand({
      TableName: deps.tableName || TABLE_NAME,
      Key: { sub, threadId },
    })
  );

  if (!result.Item) {
    return null;
  }

  const item = result.Item;
  const all = Array.isArray(item.messages) ? item.messages : [];

  const limit = deps.maxMessages || MAX_HISTORY_MESSAGES;
  const byteBudget = deps.maxBytes || MAX_HISTORY_BYTES;

  // 新しい方から詰めていき、件数かバイト予算のどちらかに達したら止める。
  const picked = [];
  let usedBytes = 0;

  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (picked.length >= limit) {
      break;
    }

    const message = normalizeHistoryMessage(all[i]);
    if (!message) {
      continue;
    }

    const size = Buffer.byteLength(JSON.stringify(message), 'utf8');

    // 1件目だけは予算を超えても入れる（空応答を避けるため）。
    if (usedBytes + size > byteBudget && picked.length > 0) {
      break;
    }

    picked.push(message);
    usedBytes += size;
  }

  // 詰めるときに新しい順で走査したので、時系列へ戻す。
  picked.reverse();

  return {
    threadId,
    title: String(item.title || ''),
    messages: picked,
    hasMore: picked.length < all.length,
    totalMessages: all.length,
  };
}

/**
 * DynamoDB のメッセージをクライアント向けへ整形する。
 *
 * 画像はバイナリではなく imageDescription（生成済みの説明文）を保存しているため、
 * そのまま返せる。
 */
function normalizeHistoryMessage(raw) {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const text = String(raw.text || '');
  const imageDescription = String(raw.imageDescription || '');

  if (!text && !imageDescription) {
    return null;
  }

  const message = {
    role: raw.role === 'assistant' ? 'assistant' : 'user',
    text,
    createdAt: String(raw.createdAt || ''),
  };

  if (imageDescription) {
    message.imageDescription = imageDescription;
  }

  // 表情の復元に使えるよう、assistant 側の感情も返す。
  if (message.role === 'assistant' && raw.emotions && typeof raw.emotions === 'object') {
    message.emotions = raw.emotions;
  }

  return message;
}

/**
 * スレッドを削除する。
 *
 * 本文（messages）とスレッド要約（sessionSummary）はこの項目に入っているため、
 * 項目ごと消せば会話の中身は残らない。
 *
 * ただし UserSession の userMemory には、このスレッドの要約が集約された
 * 内容が残る。「消したのにライムが覚えている」状態を避けるため、
 * 呼び出し側は削除後に userMemory の再生成を依頼すること。
 *
 * @returns {Promise<boolean>} 削除を実行したら true（元から無い場合も true）
 */
async function deleteThread(sub, threadId, deps = {}) {
  if (!sub || !threadId) {
    throw new Error('sub and threadId are required');
  }

  const client = deps.docClient || getDocClient();

  await client.send(
    new DeleteCommand({
      TableName: deps.tableName || TABLE_NAME,
      Key: { sub, threadId },
    })
  );

  return true;
}

module.exports = {
  TABLE_NAME,
  MAX_THREADS,
  listThreads,
  getThreadHistory,
  deleteThread,
  normalizeHistoryMessage,
};
