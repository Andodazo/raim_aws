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
      'lastResponseCreatedAt, sessionInputTokens, summarizedAtInputTokens, ' +
      'turnCount, createdAt, updatedAt';
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
    // 次の要約は「ここからどれだけ伸びたか」で判断する。
    // usage.input_tokens は履歴込みの累計なので、
    // カウンタを 0 に戻すのではなく、今の文脈サイズを基準点として残す。
    setParts.push(
      'summarizedAtInputTokens = if_not_exists(sessionInputTokens, :zero)',
      'turnCount = :zero'
    );
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
        // 鎖を切ったので Mantle 側の文脈もゼロから積み直しになる
        'sessionInputTokens = :zero',
        'summarizedAtInputTokens = :zero',
        'updatedAt = :now',
      ].join(', '),
      ExpressionAttributeValues: { ':empty': '', ':zero': 0, ':now': now },
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

// ─────────────────────────────────────────────
// タイトル
// ─────────────────────────────────────────────
//
// スレッド作成時のタイトルは「最初のユーザー発話を20文字で切ったもの」だが、
// 挨拶から始まる会話が多いと一覧が「こんにちは」だらけになり区別できない。
//
// そこで要約が生成されたタイミングで、要約の中身からタイトルを付け直す。
// 要約は既に生成済みなので **追加の LLM 呼び出しは発生しない**。
//
// titleSource でタイトルの出所を管理する。
//   'message' … 最初の発話から自動生成（差し替え対象）
//   'summary' … 要約から生成（より新しい要約が出れば差し替える）
//   'user'    … ユーザーが手で付けた（差し替えない）

/**
 * 要約テキストの【事実】1件目からタイトルを作る。
 *
 * 入力例:
 *   【事実】
 *   - ユーザーは卒業制作でAIコンパニオンアプリを制作している
 *   - ...
 *
 * 出力例: 「卒業制作でAIコンパニオンアプリを制作」
 *
 * 主語の「ユーザーは」は一覧では冗長なので落とす。
 */
function deriveTitleFromSummary(summary) {
  const text = String(summary || '');

  // 【事実】セクションの最初の箇条書きを拾う。
  // 【関係性】側は推測なのでタイトルには使わない。
  const factsSection = text.split('【関係性】')[0];

  const firstFact = factsSection
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.startsWith('-'));

  if (!firstFact) {
    return '';
  }

  let title = firstFact.replace(/^-\s*/, '').trim();

  // 「ユーザーは〜」「ユーザーが〜」は一覧で意味がないので落とす。
  title = title.replace(/^ユーザー[はが]\s*/, '');

  // 文末の句点は不要。
  title = title.replace(/[。．]$/, '').trim();

  if (!title) {
    return '';
  }

  return title.length <= 20 ? title : `${title.slice(0, 20)}…`;
}

/**
 * 要約からタイトルを付け直す。
 *
 * titleSource が 'user' の場合は上書きしない（手で付けた名前を尊重する）。
 * 条件付き更新なので、読み取ってから判定する必要がない。
 */
async function updateTitleFromSummary(sub, threadId, summary, deps = {}) {
  const title = deriveTitleFromSummary(summary);

  if (!title) {
    return null;
  }

  const client = deps.docClient || getDocClient();
  const now = (deps.now ? deps.now() : new Date()).toISOString();

  try {
    const result = await client.send(
      new UpdateCommand({
        TableName: deps.tableName || TABLE_NAME,
        Key: { sub, threadId },
        UpdateExpression: 'SET title = :title, titleSource = :source, updatedAt = :now',
        // ユーザーが手で付けたタイトルは上書きしない。
        // titleSource が未設定の古いスレッドは対象に含める。
        ConditionExpression:
          'attribute_not_exists(titleSource) OR titleSource <> :user',
        ExpressionAttributeValues: {
          ':title': title,
          ':source': 'summary',
          ':now': now,
          ':user': 'user',
        },
        ReturnValues: 'ALL_NEW',
      })
    );

    // タイトルは要約の【事実】から作られる。会話由来の文字列なのでログには残さない。
    console.log(
      `[Thread] title updated from summary: sub=${sub} threadId=${threadId} ` +
      `titleLength=${String(title).length}`
    );
    return result.Attributes;
  } catch (error) {
    // 条件不一致（ユーザー命名済み）は正常系。それ以外もタイトルなので致命的ではない。
    if (error.name === 'ConditionalCheckFailedException') {
      return null;
    }
    console.warn(`[Thread] title update failed (non-fatal): ${error.message}`);
    return null;
  }
}

module.exports = {
  TABLE_NAME,
  getThread,
  listThreads,
  scanIdleThreads,
  saveThreadSummary,
  resetThreadSession,
  toSummaryHistory,
  deriveTitleFromSummary,
  updateTitleFromSummary,
};
