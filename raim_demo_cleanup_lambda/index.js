'use strict';

// ============================================================================
// RAiM Demo Cleanup Lambda
// ============================================================================
//
// EventBridge Scheduler から毎分呼び出し、デモ用 sub のうち一定時間更新
// されていない ConversationThread を削除する。
//
// この Lambda は会話を要約しない。無操作5分になった場合は、スレッドと
// UserSessionをまとめて削除する。まだ操作中のUserSessionについては、
// userMemoryだけを空にする。Summary Lambdaのmemory.refreshは呼ばない。
// Summary Lambdaを呼ぶと、残っているスレッドから新しい要約が生成される
// 可能性があるためである。
//
// 必須環境変数:
//   DEMO_SUB
//
// 任意環境変数:
//   CONVERSATION_THREAD_TABLE_NAME (既定: RAiM-ConversationThread-dev)
//   USER_SESSION_TABLE_NAME       (既定: RAiM-UserSession-dev)
//   DEMO_THREAD_IDLE_SECONDS      (既定: 300)
//   DEMO_CLEANUP_MAX_DELETES      (既定: 100)
// ============================================================================

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');

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

function getConfig(env = process.env) {
  const idleSeconds = Number(env.DEMO_THREAD_IDLE_SECONDS || 300);
  const maxDeletes = Number(env.DEMO_CLEANUP_MAX_DELETES || 100);

  if (!Number.isInteger(idleSeconds) || idleSeconds <= 0) {
    throw new Error('DEMO_THREAD_IDLE_SECONDS must be a positive integer');
  }

  if (!Number.isInteger(maxDeletes) || maxDeletes <= 0) {
    throw new Error('DEMO_CLEANUP_MAX_DELETES must be a positive integer');
  }

  return {
    demoSub: String(env.DEMO_SUB || '').trim(),
    threadTableName:
      env.CONVERSATION_THREAD_TABLE_NAME || 'RAiM-ConversationThread-dev',
    userSessionTableName: env.USER_SESSION_TABLE_NAME || 'RAiM-UserSession-dev',
    idleSeconds,
    maxDeletes,
  };
}

function toDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isIdle(updatedAt, cutoff) {
  const updated = toDate(updatedAt);
  return Boolean(updated && updated.getTime() <= cutoff.getTime());
}

/**
 * デモ用 sub のスレッドを全ページ取得する。
 *
 * updatedAt は sort key ではないため DynamoDB の KeyConditionExpression
 * には入れられない。デモ用 sub は固定の1ユーザーなので、その sub の
 * Query をページングし、Lambda 側で判定する。
 */
async function findThreads({ config, now, docClient, idleOnly, maxItems }) {
  const cutoff = new Date(now.getTime() - config.idleSeconds * 1000);
  const candidates = [];
  let exclusiveStartKey;

  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: config.threadTableName,
        KeyConditionExpression: '#sub = :sub',
        ExpressionAttributeNames: {
          '#sub': 'sub',
        },
        ExpressionAttributeValues: {
          ':sub': config.demoSub,
        },
        ProjectionExpression: '#sub, threadId, updatedAt, turnCount',
        ExclusiveStartKey: exclusiveStartKey,
      })
    );

    for (const item of result.Items || []) {
      if (!item.threadId || (idleOnly && !isIdle(item.updatedAt, cutoff))) {
        continue;
      }

      const turnCount = Number(item.turnCount);

      candidates.push({
        sub: config.demoSub,
        threadId: String(item.threadId),
        updatedAt: String(item.updatedAt),
        ...(Number.isFinite(turnCount) ? { turnCount } : {}),
      });

      if (candidates.length >= maxItems) {
        return { candidates, truncated: Boolean(result.LastEvaluatedKey) };
      }
    }

    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return { candidates, truncated: false };
}

async function findIdleThreads({ config, now, docClient }) {
  const result = await findThreads({
    config,
    now,
    docClient,
    idleOnly: true,
    maxItems: config.maxDeletes,
  });

  return result.candidates;
}

async function findAllThreads({ config, now, docClient }) {
  return findThreads({
    config,
    now,
    docClient,
    idleOnly: false,
    maxItems: config.maxDeletes,
  });
}

async function getUserSessionState({ config, docClient }) {
  const result = await docClient.send(
    new GetCommand({
      TableName: config.userSessionTableName,
      Key: { sub: config.demoSub },
      ProjectionExpression: 'lastAccessedAt, updatedAt, userMemory',
    })
  );

  if (!result.Item) {
    return null;
  }

  // 古いUserSessionにlastAccessedAtがない場合はupdatedAtへフォールバックする。
  const activityAt = result.Item.lastAccessedAt || result.Item.updatedAt || '';

  return {
    activityAt: String(activityAt),
    activityAttribute: result.Item.lastAccessedAt
      ? 'lastAccessedAt'
      : 'updatedAt',
    userMemory: String(result.Item.userMemory || ''),
  };
}

/**
 * Query 後に会話が更新されていた場合は削除しない。
 * 条件不一致は正常な競合として扱い、次回の実行に任せる。
 */
async function deleteIfUnchanged(candidate, config, docClient) {
  const expressionAttributeNames = {
    '#updatedAt': 'updatedAt',
  };
  const expressionAttributeValues = {
    ':updatedAt': candidate.updatedAt,
  };
  let conditionExpression = '#updatedAt = :updatedAt';

  // 現行スキーマでは turnCount が存在する。古い項目も安全に扱えるよう、
  // 取得できた場合だけ追加条件にする。
  if (Number.isFinite(candidate.turnCount)) {
    expressionAttributeNames['#turnCount'] = 'turnCount';
    expressionAttributeValues[':turnCount'] = candidate.turnCount;
    conditionExpression += ' AND #turnCount = :turnCount';
  }

  try {
    await docClient.send(
      new DeleteCommand({
        TableName: config.threadTableName,
        Key: {
          sub: candidate.sub,
          threadId: candidate.threadId,
        },
        ConditionExpression: conditionExpression,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
      })
    );

    return true;
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      console.log(
        `[DemoCleanup] skipped changed thread: threadId=${candidate.threadId}`
      );
      return false;
    }

    throw error;
  }
}

/**
 * 既存の userMemory がある場合だけ空にする。
 * 毎分無条件 Update しないことで、不要な書き込みと updatedAt 更新を避ける。
 */
async function clearUserMemoryIfPresent({ config, now, docClient }) {
  const result = await docClient.send(
    new GetCommand({
      TableName: config.userSessionTableName,
      Key: { sub: config.demoSub },
      ProjectionExpression: 'userMemory',
    })
  );

  if (!result.Item || !String(result.Item.userMemory || '').trim()) {
    return false;
  }

  await docClient.send(
    new UpdateCommand({
      TableName: config.userSessionTableName,
      Key: { sub: config.demoSub },
      UpdateExpression: [
        'SET userMemory = :empty',
        'userMemoryUpdatedAt = :now',
        'updatedAt = :now',
      ].join(', '),
      ExpressionAttributeValues: {
        ':empty': '',
        ':now': now.toISOString(),
      },
    })
  );

  return true;
}

/**
 * 無操作状態が変わっていないことを確認してUserSession本体を削除する。
 */
async function deleteUserSessionIfUnchanged({
  config,
  session,
  docClient,
}) {
  if (!session || !session.activityAt) {
    return false;
  }

  try {
    await docClient.send(
      new DeleteCommand({
        TableName: config.userSessionTableName,
        Key: { sub: config.demoSub },
        ConditionExpression: '#activityAt = :activityAt',
        ExpressionAttributeNames: {
          '#activityAt': session.activityAttribute,
        },
        ExpressionAttributeValues: {
          ':activityAt': session.activityAt,
        },
      })
    );

    return true;
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') {
      console.log('[DemoCleanup] skipped UserSession changed during cleanup');
      return false;
    }

    throw error;
  }
}

async function handler(event = {}, deps = {}) {
  const config = getConfig(deps.env || process.env);

  // DEMO_SUB 未設定時は全ユーザーを対象にしないよう fail closed にする。
  if (!config.demoSub) {
    throw new Error('DEMO_SUB is required');
  }

  const now = toDate(deps.now || new Date());
  if (!now) {
    throw new Error('now must be a valid Date');
  }

  const docClient = deps.docClient || getDocClient();
  const session = await getUserSessionState({ config, docClient });
  const cutoff = new Date(now.getTime() - config.idleSeconds * 1000);
  const sessionIdle = Boolean(session && isIdle(session.activityAt, cutoff));

  // UserSessionが無操作5分以上なら、残っているスレッドも全件削除する。
  // 上限超過時は次回実行へ継続し、UserSession本体はまだ削除しない。
  const threadResult = sessionIdle
    ? await findAllThreads({ config, now, docClient })
    : {
        candidates: await findIdleThreads({ config, now, docClient }),
        truncated: false,
      };
  const candidates = threadResult.candidates;

  let deleted = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    if (await deleteIfUnchanged(candidate, config, docClient)) {
      deleted += 1;
    } else {
      skipped += 1;
    }
  }

  const userSessionDeleted =
    sessionIdle &&
    !threadResult.truncated &&
    skipped === 0
      ? await deleteUserSessionIfUnchanged({ config, session, docClient })
      : false;

  const memoryCleared = userSessionDeleted
    ? false
    : await clearUserMemoryIfPresent({ config, now, docClient });

  const result = {
    demoSub: config.demoSub,
    cutoff: cutoff.toISOString(),
    sessionIdle,
    candidates: candidates.length,
    deleted,
    skipped,
    userSessionDeleted,
    memoryCleared,
  };

  console.log(`[DemoCleanup] completed: ${JSON.stringify(result)}`);
  return result;
}

exports.handler = (event) => handler(event);

// テスト用に内部関数も公開する。
exports.getConfig = getConfig;
exports.findIdleThreads = findIdleThreads;
exports.findAllThreads = findAllThreads;
exports.getUserSessionState = getUserSessionState;
exports.deleteIfUnchanged = deleteIfUnchanged;
exports.deleteUserSessionIfUnchanged = deleteUserSessionIfUnchanged;
exports.clearUserMemoryIfPresent = clearUserMemoryIfPresent;
exports.isIdle = isIdle;
