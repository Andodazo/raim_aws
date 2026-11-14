'use strict';

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');
const crypto = require('crypto');

/**
 * DynamoDB接続設定
 *
 * Core LambdaはRAiM-UserSession-devを使って、
 * ユーザーごとのMantle会話状態を管理する。
 */
const REGION = process.env.AWS_REGION || 'ap-northeast-1';
const TABLE_NAME = process.env.USER_SESSION_TABLE_NAME || 'RAiM-UserSession-dev';

/**
 * 固定プロンプトのバージョン。
 *
 * システムプロンプトを大きく変更した場合は、
 * この値を上げることで、UserSession側に
 * どの版のプロンプトで会話していたかを残せる。
 */
const PROMPT_VERSION = process.env.PROMPT_VERSION || 'raim-system-v1';

const ddbClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);

/** RAiM側の会話セッションID（currentSessionId）を作る。 */
function createNewSessionId() {
  return `session-${crypto.randomUUID()}`;
}

/**
 * UserSessionを取得する。
 * なければ新規作成する。
 *
 * Core Lambdaでは、ユーザーごとに以下の状態をDynamoDBへ保存する。
 *
 * - currentSessionId
 *   RAiM側の会話セッションID。
 *
 * - userMemory / activeThreadId / recentGreetings など
 *
 * 以前は Mantle の response_id（lastResponseId）もここに保存して会話をつないでいたが、
 * 2026-11 から毎回会話を入力に入れて送るので、保存しなくなった。
 *
 * @param {string} sub - Cognitoのユーザー識別子。
 * @returns {object} UserSession情報。新規作成時はisNew: true。
 */
async function getOrCreateUserSession(sub) {
  if (!sub) {
    throw new Error('sub is required');
  }

  const now = new Date().toISOString();

  /**
   * まず、subをキーに既存のUserSessionを取得する。
   */
  const getResult = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { sub },
    })
  );

  /**
   * 既存UserSessionがある場合。
   *
   * lastAccessedAt / updatedAt を更新しつつ、
   * 古いレコードに不足している属性があれば if_not_exists で補完する。
   *
   * これにより、テーブル設計を途中で拡張しても、
   * 既存ユーザーのレコードを安全に最新形式へ近づけられる。
   */
  if (getResult.Item) {
    const updateResult = await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { sub },
        UpdateExpression: [
          'SET lastAccessedAt = :now',
          'updatedAt = :now',
          'currentSessionId = if_not_exists(currentSessionId, :newSessionId)',
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

  /**
   * 既存UserSessionがない場合。
   *
   * 初回会話用のUserSessionを新規作成する。
   */
  const item = {
    sub,
    currentSessionId: createNewSessionId(),

    sessionSummary: '',

    // 固定プロンプトの版管理
    promptVersion: PROMPT_VERSION,

    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
  };

  /**
   * attribute_not_exists(#sub) を付けることで、
   * 同じsubのレコードが同時に作成される競合を防ぐ。
   */
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
 * sessionSummaryを保存する。
 *
 * 今回のCore Lambdaでは要約生成はしない。
 *
 * ただし、将来的に以下のような別処理で生成した要約を
 * UserSessionへ保存できるように、この関数だけ用意している。
 *
 * 例:
 * - Summary Lambda
 * - Backup Lambda
 * - EventBridgeで定期実行される月次・週次処理
 *
 * sessionSummaryは、Mantleのresponse_idが使えない場合の
 * 復旧用コンテキストとして利用する想定。
 *
 * @param {string} sub - Cognitoのユーザー識別子。
 * @param {string} sessionSummary - 保存する会話要約。
 * @returns {object} 更新後のUserSession。
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
 * 今アクティブなスレッドの ID を取得する。
 *
 * UserSession は「どのスレッドを開いているか」だけを持ち、
 * 会話の実体は ConversationThread テーブル側にある。
 */
async function getActiveThreadId(sub) {
  if (!sub) {
    throw new Error('sub is required');
  }

  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { sub },
    })
  );

  return result.Item ? String(result.Item.activeThreadId || '') : '';
}

/**
 * アクティブスレッドを切り替える。
 *
 * 「新しい会話」で別スレッドを開いたときや、新規作成時に呼ぶ。
 */
async function setActiveThreadId(sub, threadId) {
  if (!sub || !threadId) {
    throw new Error('sub and threadId are required');
  }

  const now = new Date().toISOString();

  const result = await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { sub },
      UpdateExpression: [
        'SET activeThreadId = :threadId',
        'lastAccessedAt = :now',
        'updatedAt = :now',
      ].join(', '),
      ExpressionAttributeValues: {
        ':threadId': threadId,
        ':now': now,
      },
      ReturnValues: 'ALL_NEW',
    })
  );

  return result.Attributes;
}

/**
 * 最近の話しかけ（新しい順、最大3つ）を覚える。
 *
 * 新しい会話の1回目でも、前の会話でした話しかけと同じことを言わないように使う（greeting.js）。
 */
async function updateRecentGreetings(sub, recentGreetings) {
  if (!sub) {
    throw new Error('sub is required');
  }
  const list = Array.isArray(recentGreetings)
    ? recentGreetings.filter((text) => typeof text === 'string' && text).slice(0, 3)
    : [];

  await docClient.send(
    new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { sub },
      UpdateExpression: 'SET recentGreetings = :list, updatedAt = :now',
      ExpressionAttributeValues: {
        ':list': list,
        ':now': new Date().toISOString(),
      },
    })
  );
}

module.exports = {
  getOrCreateUserSession,
  updateRecentGreetings,
  getActiveThreadId,
  setActiveThreadId,
  updateSessionSummary,
};