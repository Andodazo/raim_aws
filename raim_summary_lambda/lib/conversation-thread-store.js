'use strict';

// ==============================================================================
// ConversationThread ストア
// ==============================================================================
//
// DynamoDB テーブル `RAiM-ConversationThread-dev` の読み書き。
//
// キー構成:
//   パーティションキー sub      … ユーザー識別子
//   ソートキー         threadId … スレッド識別子
//
// これにより
//   - sub で Query      → そのユーザーの全スレッド（「新しい会話」一覧）
//   - (sub, threadId)   → 1スレッドだけ取得（スレッド再開・要約対象）
//   - 400KB の項目上限がスレッド単位にかかる（全スレッド合計ではない）
//
// 【注意】DynamoDB では `sub` が予約語のため、KeyConditionExpression や
// UpdateExpression の中では ExpressionAttributeNames で別名にする必要がある。
// GetItem / PutItem の Key は式ではないのでそのまま書ける。

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');

const TABLE_NAME =
  process.env.CONVERSATION_THREAD_TABLE_NAME || 'RAiM-ConversationThread-dev';

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

// ─────────────────────────────────────────────
// 取得
// ─────────────────────────────────────────────

/**
 * 1スレッドを取得する。
 *
 * @param {string} sub
 * @param {string} threadId
 * @param {Object} [deps] テスト用に docClient を差し替える
 * @returns {Promise<Object|null>} 見つからなければ null
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
 * あるユーザーの全スレッドを取得する。
 *
 * 「新しい会話」一覧や、週次バッチでユーザー単位に集約するときに使う。
 * messages は重いため、一覧用途では projection で省ける。
 *
 * @param {string} sub
 * @param {Object} [options]
 * @param {boolean} [options.includeMessages] true なら messages も取得（既定 false）
 */
async function listThreads(sub, options = {}, deps = {}) {
  if (!sub) {
    throw new Error('sub is required');
  }

  const client = deps.docClient || getDocClient();

  const params = {
    TableName: deps.tableName || TABLE_NAME,
    // sub は予約語なので別名を使う
    KeyConditionExpression: '#sub = :sub',
    ExpressionAttributeNames: { '#sub': 'sub' },
    ExpressionAttributeValues: { ':sub': sub },
  };

  // 一覧表示や集約では messages（最も重い属性）が不要なことが多い。
  // 取得サイズを抑えるため既定では除外する。
  if (!options.includeMessages) {
    params.ProjectionExpression =
      '#sub, threadId, title, sessionSummary, lastResponseId, ' +
      'lastResponseCreatedAt, cumulativeInputTokens, turnCount, createdAt, updatedAt';
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

  return items;
}

/**
 * 全ユーザーのスレッドを走査する（週次バッチ用）。
 *
 * 放置スレッドの検出に使う。GSI を作っていないため Scan になるが、
 * スレッド数が数百程度のうちは問題にならない。
 * 重くなったら updatedAt の GSI を後から追加できる。
 *
 * @param {Object} [options]
 * @param {number} [options.idleDays] 何日以上更新されていないものを対象にするか
 * @param {number} [options.limit] 1回の実行で処理する最大件数（暴走防止）
 */
async function scanIdleThreads(options = {}, deps = {}) {
  const idleDays = Number(options.idleDays ?? 7);
  const limit = Number(options.limit ?? 100);
  const now = deps.now ? deps.now() : new Date();

  const threshold = new Date(now.getTime() - idleDays * 24 * 60 * 60 * 1000)
    .toISOString();

  const client = deps.docClient || getDocClient();

  const items = [];
  let lastEvaluatedKey;

  do {
    const result = await client.send(
      new ScanCommand({
        TableName: deps.tableName || TABLE_NAME,
        // updatedAt が閾値より古いものだけ。属性が無い項目は対象外。
        FilterExpression: 'attribute_exists(updatedAt) AND updatedAt < :threshold',
        ExpressionAttributeValues: { ':threshold': threshold },
        ExclusiveStartKey: lastEvaluatedKey,
      })
    );

    items.push(...(result.Items || []));
    lastEvaluatedKey = result.LastEvaluatedKey;

    // 1回の実行で処理しすぎないよう打ち切る。
    // 残りは次回の週次実行で拾われる。
    if (items.length >= limit) {
      return items.slice(0, limit);
    }
  } while (lastEvaluatedKey);

  return items;
}

// ─────────────────────────────────────────────
// 更新
// ─────────────────────────────────────────────

/**
 * スレッドの要約を保存する。
 *
 * 要約を保存したら、そのスレッドの累積トークンと往復数はリセットする。
 * 次の圧縮判定を新しいセッションとして数え直すため。
 *
 * @param {string} sub
 * @param {string} threadId
 * @param {string} summary 整形済みの要約テキスト
 * @param {Object} [options]
 * @param {boolean} [options.resetCounters] 既定 true
 */
async function saveThreadSummary(sub, threadId, summary, options = {}, deps = {}) {
  if (!sub || !threadId) {
    throw new Error('sub and threadId are required');
  }
  if (!summary || !String(summary).trim()) {
    // 空要約で既存を潰さない。
    return null;
  }

  const client = deps.docClient || getDocClient();
  const now = (deps.now ? deps.now() : new Date()).toISOString();
  const resetCounters = options.resetCounters !== false;

  const setParts = [
    'sessionSummary = :summary',
    'summarizedAt = :now',
    'updatedAt = :now',
  ];
  const values = { ':summary': String(summary).trim(), ':now': now };

  if (resetCounters) {
    setParts.push('cumulativeInputTokens = :zero', 'turnCount = :zero');
    values[':zero'] = 0;
  }

  const result = await client.send(
    new UpdateCommand({
      TableName: deps.tableName || TABLE_NAME,
      Key: { sub, threadId },
      UpdateExpression: `SET ${setParts.join(', ')}`,
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW',
    })
  );

  return result.Attributes;
}

/**
 * 圧縮に伴い Mantle のセッションを切り直す。
 *
 * lastResponseId をクリアすると、次の会話が初回モードになる。
 * 初回モードでは人格プロンプト全文 + few-shot + sessionSummary が送られるため、
 * 履歴の積み上がりがリセットされつつ文脈は要約で引き継がれる。
 */
async function resetThreadSession(sub, threadId, deps = {}) {
  if (!sub || !threadId) {
    throw new Error('sub and threadId are required');
  }

  const client = deps.docClient || getDocClient();
  const now = (deps.now ? deps.now() : new Date()).toISOString();

  const result = await client.send(
    new UpdateCommand({
      TableName: deps.tableName || TABLE_NAME,
      Key: { sub, threadId },
      UpdateExpression: [
        'SET lastResponseId = :empty',
        'lastResponseCreatedAt = :empty',
        'updatedAt = :now',
      ].join(', '),
      ExpressionAttributeValues: { ':empty': '', ':now': now },
      ReturnValues: 'ALL_NEW',
    })
  );

  return result.Attributes;
}

// ─────────────────────────────────────────────
// ヘルパ
// ─────────────────────────────────────────────

/**
 * DynamoDB の messages を、要約サービスが期待する形へ変換する。
 *
 * 保存形式:
 *   { role: 'user' | 'assistant', text, imageDescription?, createdAt }
 *
 * 画像はバイナリではなく imageDescription（マルチモーダルで生成済みの説明文）
 * を保存しているため、要約時はテキストとして扱える。
 */
function toSummaryHistory(messages) {
  if (!Array.isArray(messages)) {
    return [];
  }

  return messages
    .map((m) => {
      if (!m || typeof m !== 'object') return null;

      const parts = [];
      if (m.text) parts.push(String(m.text));
      if (m.imageDescription) parts.push(`[画像: ${m.imageDescription}]`);

      const content = parts.join(' ').trim();
      if (!content) return null;

      return {
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content,
      };
    })
    .filter(Boolean);
}

module.exports = {
  TABLE_NAME,
  getThread,
  listThreads,
  scanIdleThreads,
  saveThreadSummary,
  resetThreadSession,
  toSummaryHistory,
};
