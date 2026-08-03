'use strict';

// ==============================================================================
// ConversationThread ストア（Core Lambda 版）
// ==============================================================================
//
// 会話履歴を DynamoDB へ自前保存する。Summary Lambda 側の同名モジュールは
// 「読み取りと要約保存」担当で、こちらは「会話の書き込み」担当。
// 各 Lambda が独立パッケージのため実装は分かれている。
//
// 【なぜ自前保存するのか】
//
// previous_response_id を使うと会話履歴は Mantle 側にしか無く、
//   - Core からは中身を読めない（要約の材料が取れない）
//   - 30日で消える（それ以降スレッドを開き直せない）
//   - 画像の説明を貯めておけない
// という制約がある。案A としてフル履歴を DynamoDB に持つことにした。
//
// 【テーブル】
//   RAiM-ConversationThread-dev
//   パーティションキー sub / ソートキー threadId
//
// 【注意】`sub` は DynamoDB の予約語。式の中では ExpressionAttributeNames で
// 別名にする必要がある（Key 指定は式ではないのでそのまま書ける）。

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');

const { randomUUID } = require('node:crypto');

const TABLE_NAME =
  process.env.CONVERSATION_THREAD_TABLE_NAME || 'RAiM-ConversationThread-dev';

const REGION = process.env.AWS_REGION || 'ap-northeast-1';

// スレッドに保持する最大メッセージ数。
// DynamoDB の項目上限は 400KB（日本語で約10万〜13万文字）。
// 上限に張り付く前に古いものから落とす安全弁。
// 要約が動いていれば古い内容は sessionSummary に残るため、履歴が消えても
// 文脈は失われない。
const MAX_MESSAGES = Number(process.env.THREAD_MAX_MESSAGES || 1000);

// 履歴の合計バイト数の上限。
//
// DynamoDB の項目上限は 400KB で、これを超えると書き込み自体が
// ValidationException で失敗する。会話は続くが履歴が保存されなくなるため、
// 件数だけでなくバイト数でも必ず切り詰める。
//
// 実測では1往復あたり 300B（短文）〜1.4KB（長文200字）なので、
// 件数上限だけだと長文の会話で 400KB を超えうる。
//
// 340KB に抑え、残りは sessionSummary・title・キー等の余裕とする。
const MAX_MESSAGE_BYTES = Number(process.env.THREAD_MAX_MESSAGE_BYTES || 340000);

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

function nowIso(deps) {
  return (deps.now ? deps.now() : new Date()).toISOString();
}

// ─────────────────────────────────────────────
// スレッドの作成・取得
// ─────────────────────────────────────────────

function createThreadId() {
  return `thread-${randomUUID()}`;
}

/**
 * スレッドを取得する。存在しなければ null。
 */
async function getThread(sub, threadId, deps = {}) {
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

  return result.Item || null;
}

/**
 * スレッドが無ければ作る。あればそのまま返す。
 *
 * if_not_exists を使うことで、同時に複数リクエストが来ても
 * 既存の会話内容を初期値で上書きしない。
 */
async function ensureThread({ sub, threadId, title }, deps = {}) {
  if (!sub || !threadId) {
    throw new Error('sub and threadId are required');
  }

  const client = deps.docClient || getDocClient();
  const now = nowIso(deps);

  const result = await client.send(
    new UpdateCommand({
      TableName: deps.tableName || TABLE_NAME,
      Key: { sub, threadId },
      UpdateExpression: [
        'SET createdAt = if_not_exists(createdAt, :now)',
        'title = if_not_exists(title, :title)',
        // タイトルの出所。'message' は最初の発話から自動生成したもので、
        // 要約が生成されたら Summary Lambda が 'summary' へ差し替える。
        // ユーザーが手で付けた場合は 'user' になり、以後上書きされない。
        'titleSource = if_not_exists(titleSource, :titleSource)',
        'messages = if_not_exists(messages, :emptyList)',
        'sessionSummary = if_not_exists(sessionSummary, :empty)',
        'lastResponseId = if_not_exists(lastResponseId, :empty)',
        'lastResponseCreatedAt = if_not_exists(lastResponseCreatedAt, :empty)',
        'cumulativeInputTokens = if_not_exists(cumulativeInputTokens, :zero)',
        'turnCount = if_not_exists(turnCount, :zero)',
        'updatedAt = :now',
      ].join(', '),
      ExpressionAttributeValues: {
        ':now': now,
        ':title': title || '新しい会話',
        ':titleSource': 'message',
        ':emptyList': [],
        ':empty': '',
        ':zero': 0,
      },
      ReturnValues: 'ALL_NEW',
    })
  );

  return result.Attributes;
}

/**
 * ユーザーのスレッド一覧を取得する（「新しい会話」プルダウン用）。
 *
 * messages は重いため既定では取得しない。
 */
async function listThreads(sub, options = {}, deps = {}) {
  if (!sub) {
    throw new Error('sub is required');
  }

  const client = deps.docClient || getDocClient();

  const params = {
    TableName: deps.tableName || TABLE_NAME,
    // sub は予約語なので別名が必須
    KeyConditionExpression: '#sub = :sub',
    ExpressionAttributeNames: { '#sub': 'sub' },
    ExpressionAttributeValues: { ':sub': sub },
  };

  if (!options.includeMessages) {
    params.ProjectionExpression =
      '#sub, threadId, title, sessionSummary, lastResponseId, ' +
      'lastResponseCreatedAt, turnCount, createdAt, updatedAt';
  }

  const items = [];
  let lastEvaluatedKey;

  do {
    const result = await client.send(
      new QueryCommand({ ...params, ExclusiveStartKey: lastEvaluatedKey })
    );
    items.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  // 新しい順（更新日時の降順）に並べる。UIの一覧表示に合わせる。
  items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

  return items;
}

// ─────────────────────────────────────────────
// 会話の記録
// ─────────────────────────────────────────────

/**
 * 1メッセージ分のレコードを組み立てる。
 *
 * 画像はバイナリではなく imageDescription（マルチモーダルで生成済みの説明文）
 * を保存する。容量が軽く、「前に見せた写真のこと」をライムが覚えていられる。
 */
function buildMessageRecord({ role, text, imageDescription, emotions, createdAt }) {
  const record = {
    role: role === 'assistant' ? 'assistant' : 'user',
    text: String(text || ''),
    createdAt: createdAt || new Date().toISOString(),
  };

  if (imageDescription) {
    record.imageDescription = String(imageDescription);
  }

  // 感情はスレッド再開時の表情復元に使えるので、assistant 側だけ残す。
  if (record.role === 'assistant' && emotions && typeof emotions === 'object') {
    record.emotions = emotions;
  }

  return record;
}

/**
 * 1往復分（ユーザー発話 + ライムの応答）を履歴へ追記する。
 *
 * list_append で末尾に足すため、既存の履歴を読み直す必要がない。
 * トークン累積と往復数も同じ更新でアトミックに加算する。
 *
 * @param {Object} params
 * @param {string} params.sub
 * @param {string} params.threadId
 * @param {Object} params.userMessage { text, imageDescription }
 * @param {Object} params.assistantMessage { text, emotions }
 * @param {number} params.inputTokens 今回の入力トークン数
 * @param {string} params.responseId Mantle の response_id
 * @param {string} params.responseCreatedAt
 */
async function appendTurn(
  {
    sub,
    threadId,
    userMessage,
    assistantMessage,
    inputTokens = 0,
    responseId = '',
    responseCreatedAt = '',
  },
  deps = {}
) {
  if (!sub || !threadId) {
    throw new Error('sub and threadId are required');
  }

  const client = deps.docClient || getDocClient();
  const now = nowIso(deps);

  const newMessages = [];

  if (userMessage) {
    newMessages.push(buildMessageRecord({ ...userMessage, role: 'user', createdAt: now }));
  }
  if (assistantMessage) {
    newMessages.push(
      buildMessageRecord({ ...assistantMessage, role: 'assistant', createdAt: now })
    );
  }

  if (newMessages.length === 0) {
    return null;
  }

  const setParts = [
    // messages が未作成でも動くよう if_not_exists で空リストを補う
    'messages = list_append(if_not_exists(messages, :emptyList), :newMessages)',
    'updatedAt = :now',
  ];

  const values = {
    ':emptyList': [],
    ':newMessages': newMessages,
    ':now': now,
  };

  if (responseId) {
    setParts.push('lastResponseId = :responseId', 'lastResponseCreatedAt = :responseCreatedAt');
    values[':responseId'] = responseId;
    values[':responseCreatedAt'] = responseCreatedAt || now;
  }

  // ADD はアトミックな加算。読み取り不要で並行更新にも強い。
  const updateExpression =
    `SET ${setParts.join(', ')} ADD cumulativeInputTokens :tokens, turnCount :one`;

  values[':tokens'] = Number(inputTokens) || 0;
  values[':one'] = 1;

  const result = await client.send(
    new UpdateCommand({
      TableName: deps.tableName || TABLE_NAME,
      Key: { sub, threadId },
      UpdateExpression: updateExpression,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    })
  );

  const attributes = result.Attributes || {};

  // 項目サイズの暴走を防ぐため、上限を超えたら古い分を落とす。
  // 要約が効いていれば文脈は sessionSummary に残る。
  // 件数超過、またはバイト数超過で切り詰める。
  // バイト数の計測は履歴が大きいときだけ行い、毎回の往復では走らせない。
  if (Array.isArray(attributes.messages)) {
    const overCount = attributes.messages.length > MAX_MESSAGES;
    const overBytes =
      !overCount &&
      attributes.messages.length > 0 &&
      Buffer.byteLength(JSON.stringify(attributes.messages), 'utf8') >
        MAX_MESSAGE_BYTES;

    if (overCount || overBytes) {
      return trimMessages(sub, threadId, attributes.messages, deps);
    }
  }

  return attributes;
}

/**
 * 履歴を上限まで切り詰める（古いものから落とす）。
 */
async function trimMessages(sub, threadId, messages, deps = {}) {
  const client = deps.docClient || getDocClient();

  const maxMessages = deps.maxMessages ?? MAX_MESSAGES;
  const maxBytes = deps.maxBytes ?? MAX_MESSAGE_BYTES;

  // まず件数で切り、そのうえでバイト数でも切る。
  // 新しい方から積み、予算を超えた時点で打ち切って時系列へ戻す。
  const byCount = messages.slice(-maxMessages);

  const picked = [];
  let usedBytes = 0;

  for (let i = byCount.length - 1; i >= 0; i -= 1) {
    const size = Buffer.byteLength(JSON.stringify(byCount[i]), 'utf8');

    // 1件目だけは予算を超えても残す（履歴が空になるのを避ける）
    if (usedBytes + size > maxBytes && picked.length > 0) {
      break;
    }

    picked.push(byCount[i]);
    usedBytes += size;
  }

  const trimmed = picked.reverse();

  const result = await client.send(
    new UpdateCommand({
      TableName: deps.tableName || TABLE_NAME,
      Key: { sub, threadId },
      UpdateExpression: 'SET messages = :messages, trimmedAt = :now',
      ExpressionAttributeValues: {
        ':messages': trimmed,
        ':now': nowIso(deps),
      },
      ReturnValues: 'ALL_NEW',
    })
  );

  console.log(
    `[Thread] trimmed messages: sub=${sub} threadId=${threadId} ${messages.length} -> ${trimmed.length}`
  );

  return result.Attributes;
}

/**
 * スレッドのタイトルを更新する。
 *
 * 「新しい会話」のままだと一覧で区別がつかないため、
 * 最初のユーザー発話から生成するといった用途を想定。
 */
async function updateThreadTitle(sub, threadId, title, source = 'user', deps = {}) {
  if (!sub || !threadId || !title) {
    return null;
  }

  const client = deps.docClient || getDocClient();

  const result = await client.send(
    new UpdateCommand({
      TableName: deps.tableName || TABLE_NAME,
      Key: { sub, threadId },
      // 明示的なタイトル更新は 'user' 扱いにし、要約による自動差し替えを止める。
      UpdateExpression: 'SET title = :title, titleSource = :source, updatedAt = :now',
      ExpressionAttributeValues: {
        ':title': String(title).slice(0, 100),
        ':source': String(source || 'user'),
        ':now': nowIso(deps),
      },
      ReturnValues: 'ALL_NEW',
    })
  );

  return result.Attributes;
}

/**
 * 最初のユーザー発話からスレッドのタイトル候補を作る。
 *
 * LLM を呼ぶとコストとレイテンシがかかるため、単純な切り出しにする。
 */
function deriveTitle(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();

  if (!normalized) {
    return '新しい会話';
  }

  return normalized.length <= 20 ? normalized : `${normalized.slice(0, 20)}…`;
}

module.exports = {
  TABLE_NAME,
  MAX_MESSAGES,
  MAX_MESSAGE_BYTES,
  createThreadId,
  getThread,
  ensureThread,
  listThreads,
  appendTurn,
  updateThreadTitle,
  deriveTitle,
  buildMessageRecord,
};
