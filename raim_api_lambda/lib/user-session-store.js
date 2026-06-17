'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');
const crypto = require('crypto');

const REGION = process.env.AWS_REGION || 'ap-northeast-1';
const TABLE_NAME = process.env.USER_SESSION_TABLE_NAME || 'RAiM-UserSession-dev';

// Mantleのresponse_idは30日保持想定だが、安全側に倒して29日で期限切れ扱いにする
const RESPONSE_ID_VALID_DAYS = Number(process.env.RESPONSE_ID_VALID_DAYS || 29);

// 固定プロンプトを変更したときに上げる
const PROMPT_VERSION = process.env.PROMPT_VERSION || 'raim-system-v1';

const ddbClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);

function addDaysIso(baseIso, days) {
  const base = baseIso ? new Date(baseIso) : new Date();
  base.setDate(base.getDate() + days);
  return base.toISOString();
}

function createNewSessionId() {
  return `session-${crypto.randomUUID()}`;
}

/**
 * UserSessionを取得する。
 * なければ新規作成する。
 *
 * Mantle構成では、Bed日保持想定だが、安全側に倒して29日で期限切れ扱いにする
const RESPONSE_ID_VALID_DAYS = Number(process.env.RESPONSE_ID_VALID_DAYS || 29);

// 固定プロンプトを変更したときに上げる
const PROMPT_VERSION = process.env.PROMPT_VERSION || 'raim-system-v1';

const ddbClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);

function addDaysIso(baseIso, days) {
  const base = baseIso ? new Date(baseIso) : new Date();
  base.setDate(base.getDate() + days);
  return base.toISOString();
}

function createNewSessionId() {
  return `rock Agent用のmemoryIdは使わない。
 * 代わりに、Mantleが返すresponse_idを lastResponseId として保存する。
 */
async function getOrCreateUserSession(sub) {
  if (!sub) {
    throw new Error('sub is required');
  }

  const now = new Date().toISOString();

  const getResult = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { sub },
    })
  );

  if (getResult.Item) {
    const updateResult = await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { sub },
        UpdateExpression: [
          'SET lastAccessedAt = :now',
          'updatedAt = :now',
          'currentSessionId = if_not_exists(currentSessionId, :newSessionId)',
          'lastResponseId = if_not_exists(lastResponseId, :empty)',
          'lastResponseCreatedAt = if_not_exists(lastResponseCreatedAt, :empty)',
          'lastResponseExpiresAt = if_not_exists(lastResponseExpiresAt, :empty)',
          'sessionSummary = if_not_exists(sessionSummary, :empty)',
          'promptVersion = if_not_exists(promptVersion, :promptVersion)',
        ].join(', '),
        ExpressionAttributeValues: {
          ':now': now,
          ':newSessionId': createNewSessionId(),
          ':empty': '',
          ':promptVersion': PROMPT_VERSION,
        },
        ReturnValues: 'ALL_NEW',
      })
    );

    return {
      ...updateResult.Attributes,
      isNew: false,
    };
  }

  const item = {
    sub,
    currentSessionId: createNewSessionId(),

    // Mantle response_id管理用
    lastResponseId: '',
    lastResponseCreatedAt: '',
    lastResponseExpiresAt: '',

    // response_idが使えないときにMantleへ渡す復旧用コンテキスト
    sessionSummary: '',

    // 固定プロンプトの版管理
    promptVersion: PROMPT_VERSION,

    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
  };

  await docClient.send(
    new PutCommand({
      TableName: TABLE_NAME,
      Item: item,
      ConditionExpression: 'attribute_not_exists(#sub)',
      ExpressionAttributeNames: {
        '#sub': 'sub',
      },
    })
  );

  return {
    ...item,
    isNew: true,
  };
}

/**
 * Mantleから返ってきたresponse_idを保存する。
 *
 * responseId:
 *   Mantleが返した id / response_id。
 *   Lambda側では生成しない。
 *
 * createdAt:
 *   response_idを受け取った時刻。
 *
 * expiresAt:
 *   指定がなければ createdAt + 29日 で保存する。
 */
async function updateMantleResponseState(sub, { responseId, createdAt, expiresAt }) {
  if (!sub) {
    throw new Error('sub is required');
  }

  if (!responseId) {
    throw new Error('responseId is required');
  }

  const now = new Date().toISOString();
  const responseCreatedAt = createdAt || now;
  const responseExpiresAt = expiresAt || addDaysIso(responseCreatedAt, RESPONSE_ID_VALID_DAYS);

  const updateResult = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { sub },
      UpdateExpression: [
        'SET lastResponseId = :responseId',
        'lastResponseCreatedAt = :responseCreatedAt',
        'lastResponseExpiresAt = :responseExpiresAt',
        'lastAccessedAt = :now',
        'updatedAt = :now',
      ].join(', '),
      ExpressionAttributeValues: {
        ':responseId': responseId,
        ':responseCreatedAt': responseCreatedAt,
        ':responseExpiresAt': responseExpiresAt,
        ':now': now,
      },
      ReturnValues: 'ALL_NEW',
    })
  );

  return updateResult.Attributes;
}

/**
 * 古いresponse_idを使わない状態に戻す。
 *
 * Mantle側で previous_response_id が期限切れ・削除済みだった場合に使う。
 * sessionSummaryは消さない。
 */
async function clearMantleResponseState(sub) {
  if (!sub) {
    throw new Error('sub is required');
  }

  const now = new Date().toISOString();

  const updateResult = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { sub },
      UpdateExpression: [
        'SET lastResponseId = :empty',
        'lastResponseCreatedAt = :empty',
        'lastResponseExpiresAt = :empty',
        'updatedAt = :now',
      ].join(', '),
      ExpressionAttributeValues: {
        ':empty': '',
        ':now': now,
      },
      ReturnValues: 'ALL_NEW',
    })
  );

  return updateResult.Attributes;
}

/**
 * sessionSummaryを保存する。
 *
 * 今回のAPI Lambdaでは要約生成はしない。
 * ただし、別のSummary Lambdaなどで生成した要約を保存できるように関数だけ用意しておく。
 */
async function updateSessionSummary(sub, sessionSummary) {
  if (!sub) {
    throw new Error('sub is required');
  }

  const now = new Date().toISOString();

  const updateResult = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { sub },
      UpdateExpression: [
        'SET sessionSummary = :sessionSummary',
        'summaryUpdatedAt = :now',
        'updatedAt = :now',
      ].join(', '),
      ExpressionAttributeValues: {
        ':sessionSummary': String(sessionSummary || ''),
        ':now': now,
      },
      ReturnValues: 'ALL_NEW',
    })
  );

  return updateResult.Attributes;
}

/**
 * RAiM側の会話セッションを明示的に切り替える。
 *
 * Mantleのresponse_idもクリアする。
 * sessionSummaryは残す。
 */
async function startNewMantleSession(sub) {
  if (!sub) {
    throw new Error('sub is required');
  }

  const now = new Date().toISOString();

  const updateResult = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { sub },
      UpdateExpression: [
        'SET currentSessionId = :newSessionId',
        'lastResponseId = :empty',
        'lastResponseCreatedAt = :empty',
        'lastResponseExpiresAt = :empty',
        'lastAccessedAt = :now',
        'updatedAt = :now',
      ].join(', '),
      ExpressionAttributeValues: {
        ':newSessionId': createNewSessionId(),
        ':empty': '',
        ':now': now,
      },
      ReturnValues: 'ALL_NEW',
    })
  );

  return updateResult.Attributes;
}

module.exports = {
  getOrCreateUserSession,
  updateMantleResponseState,
  clearMantleResponseState,
  updateSessionSummary,
  startNewMantleSession,
};