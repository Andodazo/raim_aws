'use strict';

// ==============================================================================
// Core Request Idempotency Store
// ==============================================================================
//
// SQSとLambdaは同じメッセージを複数回処理する可能性がある。
// そのたびにMantleを呼ぶと、回答・課金・WebSocket通知が重複する。
//
// このStoreはrequestId単位の処理状態をDynamoDBへ保存し、同じ要求を同時または
// 短期間に重複実行しないためのleaseを提供する。
//
// 状態:
// - PROCESSING : あるLambda Invocationが処理中
// - COMPLETED  : 最終イベントまでResponse Queueへ送信済み
// - FAILED     : 処理に失敗し、SQS再試行で再取得可能
//
// leaseExpiresAtを設ける理由:
// Lambdaが強制終了するとPROCESSINGのまま残る。その場合もlease期限後には
// SQS再配信されたメッセージが処理を引き継げるようにする。
// ==============================================================================

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');

const REGION = process.env.AWS_REGION || 'ap-northeast-1';
const TABLE_NAME = process.env.REQUEST_STATE_TABLE_NAME || 'RAiM-CoreRequest-dev';
const LEASE_SECONDS = Number(process.env.REQUEST_LEASE_SECONDS || 120);
const TTL_SECONDS = Number(process.env.REQUEST_STATE_TTL_SECONDS || 86400);

const ddbClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);

function createRequestKey(sub, requestId) {
  return `${String(sub)}#${String(requestId)}`;
}

/**
 * requestの処理権を取得する。
 * 新規・FAILED・lease切れPROCESSINGだけがclaimed=trueになる。
 */
async function claimRequest({ sub, requestId, connectionId, ownerId }, options = {}) {
  const client = options.client || docClient;
  const tableName = options.tableName || TABLE_NAME;
  const leaseSeconds = Number(options.leaseSeconds || LEASE_SECONDS);
  const ttlSeconds = Number(options.ttlSeconds || TTL_SECONDS);
  const nowEpoch = Math.floor(Date.now() / 1000);
  const nowIso = new Date().toISOString();
  const requestKey = createRequestKey(sub, requestId);

  try {
    await client.send(new UpdateCommand({
      TableName: tableName,
      Key: { requestKey },
      UpdateExpression: [
        'SET #status = :processing',
        '#sub = :sub',
        'requestId = :requestId',
        'connectionId = :connectionId',
        'ownerId = :ownerId',
        'startedAt = :nowIso',
        'updatedAt = :nowIso',
        'leaseExpiresAt = :leaseExpiresAt',
        'expiresAt = :expiresAt',
      ].join(', '),
      ConditionExpression: [
        'attribute_not_exists(requestKey)',
        '#status = :failed',
        '(#status = :processing AND leaseExpiresAt < :nowEpoch)',
      ].join(' OR '),
      ExpressionAttributeNames: {
        '#status': 'status',
        '#sub': 'sub',
      },
      ExpressionAttributeValues: {
        ':processing': 'PROCESSING',
        ':failed': 'FAILED',
        ':sub': sub,
        ':requestId': requestId,
        ':connectionId': connectionId || '',
        ':ownerId': ownerId,
        ':nowIso': nowIso,
        ':nowEpoch': nowEpoch,
        ':leaseExpiresAt': nowEpoch + leaseSeconds,
        ':expiresAt': nowEpoch + ttlSeconds,
      },
    }));

    return { claimed: true, requestKey, status: 'PROCESSING' };
  } catch (error) {
    if (error.name !== 'ConditionalCheckFailedException') {
      throw error;
    }

    const existing = await client.send(new GetCommand({
      TableName: tableName,
      Key: { requestKey },
      ConsistentRead: true,
    }));

    return {
      claimed: false,
      requestKey,
      status: existing.Item?.status || 'UNKNOWN',
    };
  }
}

async function updateRequestStatus({ requestKey, ownerId, status, details }, options = {}) {
  const client = options.client || docClient;
  const tableName = options.tableName || TABLE_NAME;
  const nowIso = new Date().toISOString();

  await client.send(new UpdateCommand({
    TableName: tableName,
    Key: { requestKey },
    UpdateExpression: [
      'SET #status = :status,',
      'updatedAt = :nowIso,',
      'completedAt = :nowIso,',
      'resultDetails = :details',
      'REMOVE leaseExpiresAt',
    ].join(' '),
    ConditionExpression: 'ownerId = :ownerId',
    ExpressionAttributeNames: {
      '#status': 'status',
    },
    ExpressionAttributeValues: {
      ':status': status,
      ':nowIso': nowIso,
      ':details': details || {},
      ':ownerId': ownerId,
    },
  }));
}

function markRequestCompleted({ requestKey, ownerId, details }, options) {
  return updateRequestStatus({
    requestKey,
    ownerId,
    status: 'COMPLETED',
    details,
  }, options);
}

function markRequestFailed({ requestKey, ownerId, details }, options) {
  return updateRequestStatus({
    requestKey,
    ownerId,
    status: 'FAILED',
    details,
  }, options);
}

module.exports = {
  claimRequest,
  createRequestKey,
  markRequestCompleted,
  markRequestFailed,
};
