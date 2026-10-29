'use strict';

// ==============================================================================
// UserSession（ユーザー記憶）の操作
// ==============================================================================
//
// スレッドを削除したときに、スレッドを跨いだ記憶（userMemory）をその場で空にする。
//
// 【なぜ Edge で空にするのか】
//
// 以前は削除のあと Summary Lambda に記憶の作り直しを「依頼」するだけだった。
// 作り直しが終わるまで（または依頼が失敗すると週次バッチまで）、
// 消した会話の内容が記憶に残り、次の会話でライムが話してしまえた。
// 画面では「覚えたことも消えます」と出しているので、削除の完了を返す前に空にする。
// 残っている会話からの作り直しは、これまでどおり Summary Lambda が非同期で行う。
//
// 【memoryGeneration（世代番号）】
//
// 削除のたびに1つ進める。Summary Lambda は記憶を作り始める前にこの番号を読み、
// 保存するときに番号が変わっていなければだけ書き込む。
// 削除より前に作り始めた古い記憶が、空にしたあとで書き戻されるのを防ぐため。
// 空にする操作と番号を進める操作は、必ず1回の更新でまとめて行う。

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
 * 削除に合わせて userMemory を空にし、世代番号を進める。
 *
 * UserSession がまだ無いユーザーでも番号だけは作る。
 * 作っておかないと、同時に走っている記憶の作り直しが古い内容を書き込めてしまう。
 *
 * @returns {Promise<number>} 進めたあとの世代番号
 */
async function clearMemoryForDeletion(sub, deps = {}) {
  if (!sub) {
    throw new Error('sub is required');
  }

  const client = deps.docClient || getDocClient();
  const now = (deps.now ? deps.now() : new Date()).toISOString();

  const result = await client.send(
    new UpdateCommand({
      TableName: deps.tableName || TABLE_NAME,
      Key: { sub },
      UpdateExpression:
        'SET userMemory = :empty, userMemoryUpdatedAt = :now ADD memoryGeneration :one',
      ExpressionAttributeValues: {
        ':empty': '',
        ':now': now,
        ':one': 1,
      },
      ReturnValues: 'UPDATED_NEW',
    })
  );

  return Number(result?.Attributes?.memoryGeneration || 0);
}

// ==============================================================================
// 覚えていることの表示と、項目ごとの削除
// ==============================================================================
//
// userMemory は Summary Lambda が次の形で書く（summarize-service.js の formatSummary）。
//
//   【事実】
//   - 卒業制作でアプリを作っている
//   【関係性】
//   - 制作の話になると楽しそうな様子
//
// アプリには項目の配列にして渡し、利用者が選んだ項目を消す。
//
// 【消した項目を forgottenMemories に残す理由】
// userMemory は各会話の要約から作り直される（週次・会話の削除のとき）。
// userMemory の行を消すだけだと、作り直したときに同じことをまた覚えてしまう。
// 消した項目を残しておき、Summary Lambda が作り直すときに書かないようにする。

/** 消した項目をいくつまで覚えておくか（古いものから捨てる） */
const MAX_FORGOTTEN = 100;

const SECTION_FACTS = '【事実】';
const SECTION_RELATIONSHIP = '【関係性】';

/**
 * userMemory の文字列を、事実と関係性の項目に分ける。
 * 見出しが無い古い形式の行は、事実として扱う。
 */
function parseMemory(text) {
  const facts = [];
  const relationship = [];
  let current = facts;

  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line === SECTION_FACTS) {
      current = facts;
      continue;
    }
    if (line === SECTION_RELATIONSHIP) {
      current = relationship;
      continue;
    }
    const item = line.replace(/^[-・*]\s*/, '').trim();
    if (item) current.push(item);
  }

  return { facts, relationship };
}

/** parseMemory の逆。Summary Lambda と同じ形に戻す */
function formatMemory({ facts = [], relationship = [] }) {
  const lines = [];
  if (facts.length > 0) {
    lines.push(SECTION_FACTS);
    for (const f of facts) lines.push(`- ${f}`);
  }
  if (relationship.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(SECTION_RELATIONSHIP);
    for (const r of relationship) lines.push(`- ${r}`);
  }
  return lines.join('\n');
}

async function readSession(sub, deps) {
  const client = deps.docClient || getDocClient();
  const result = await client.send(
    new GetCommand({
      TableName: deps.tableName || TABLE_NAME,
      Key: { sub },
      ProjectionExpression: 'userMemory, userMemoryUpdatedAt, forgottenMemories',
      // 消した直後に開き直したとき、消したものが見えないように
      ConsistentRead: true,
    })
  );
  return result?.Item || {};
}

/**
 * 覚えていること（userMemory）を項目に分けて返す。
 *
 * @returns {Promise<{facts: string[], relationship: string[], updatedAt: string}>}
 */
async function getMemory(sub, deps = {}) {
  if (!sub) {
    throw new Error('sub is required');
  }
  const item = await readSession(sub, deps);
  return {
    ...parseMemory(item.userMemory),
    updatedAt: String(item.userMemoryUpdatedAt || ''),
  };
}

/**
 * 覚えていることから項目を消す。
 *
 * - items に書いた項目だけを消す。all が true なら全部消す
 * - 消した項目は forgottenMemories に足す（作り直しで戻らないように）
 * - 世代番号も進める。作り直しの途中だった記憶が、消す前の内容で書き戻されないため
 *
 * 読んでから書くまでの間に Summary Lambda が書き換えていたら、読み直してやり直す。
 *
 * @returns {Promise<{facts: string[], relationship: string[], updatedAt: string}>} 消したあとの内容
 */
async function forgetMemory(sub, { items = [], all = false } = {}, deps = {}) {
  if (!sub) {
    throw new Error('sub is required');
  }
  const targets = new Set(
    (Array.isArray(items) ? items : [])
      .map((v) => String(v || '').trim())
      .filter(Boolean)
  );
  const client = deps.docClient || getDocClient();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await readSession(sub, deps);
    const oldText = String(current.userMemory || '');
    const memory = parseMemory(oldText);
    const shouldForget = (v) => all || targets.has(v);
    const removed = [...memory.facts, ...memory.relationship].filter(shouldForget);
    const kept = {
      facts: memory.facts.filter((v) => !shouldForget(v)),
      relationship: memory.relationship.filter((v) => !shouldForget(v)),
    };
    const newText = formatMemory(kept);
    const now = (deps.now ? deps.now() : new Date()).toISOString();

    const previous = Array.isArray(current.forgottenMemories) ? current.forgottenMemories : [];
    const forgotten = [...previous.filter((v) => !removed.includes(v)), ...removed]
      .slice(-MAX_FORGOTTEN);

    try {
      await client.send(
        new UpdateCommand({
          TableName: deps.tableName || TABLE_NAME,
          Key: { sub },
          UpdateExpression:
            'SET userMemory = :memory, userMemoryUpdatedAt = :now, ' +
            'forgottenMemories = :forgotten ADD memoryGeneration :one',
          // 読んだときと同じ内容のときだけ書く
          ConditionExpression: oldText
            ? 'userMemory = :old'
            : 'attribute_not_exists(userMemory) OR userMemory = :old',
          ExpressionAttributeValues: {
            ':memory': newText,
            ':now': now,
            ':forgotten': forgotten,
            ':one': 1,
            ':old': oldText,
          },
        })
      );
      return { ...kept, updatedAt: now };
    } catch (error) {
      if (error?.name !== 'ConditionalCheckFailedException') throw error;
      // Summary Lambda が書き換えていた。読み直してやり直す
    }
  }

  throw new Error('userMemory kept changing while forgetting');
}

module.exports = {
  TABLE_NAME,
  MAX_FORGOTTEN,
  clearMemoryForDeletion,
  parseMemory,
  formatMemory,
  getMemory,
  forgetMemory,
};
