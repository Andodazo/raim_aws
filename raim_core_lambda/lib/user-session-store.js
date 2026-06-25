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
 * Mantleのresponse_idは一定期間だけ利用できる想定。
 *
 * Mantle側の保持期間が30日だとしても、
 * 期限ギリギリまで使うと失敗する可能性があるため、
 * RAiM側では安全側に倒して29日で期限切れ扱いにする。
 */
const RESPONSE_ID_VALID_DAYS = Number(process.env.RESPONSE_ID_VALID_DAYS || 29);

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

/**
 * ISO形式の日付に指定日数を加算する。
 *
 * 主に lastResponseExpiresAt を作るために使う。
 *
 * @param {string} baseIso - 基準日時。未指定の場合は現在時刻。
 * @param {number} days - 加算する日数。
 * @returns {string} ISO形式の日時文字列。
 */
function addDaysIso(baseIso, days) {
  const base = baseIso ? new Date(baseIso) : new Date();
  base.setDate(base.getDate() + days);
  return base.toISOString();
}

/**
 * RAiM側で管理する会話セッションIDを生成する。
 *
 * これはMantleのresponse_idとは別物。
 * RAiM内部で「明示的に新しい会話を始めた」ことを表すために使う。
 *
 * @returns {string} session-xxxx形式のセッションID。
 */
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
 * - lastResponseId
 *   Mantleから返ってきたresponse_id。
 *   次回Mantleへprevious_response_idとして渡すことで、
 *   Mantle側の短期会話コンテキストを継続する。
 *
 * - sessionSummary
 *   response_idが使えない場合の復旧用コンテキスト。
 *   今回のCore Lambdaでは生成しないが、別Lambdaで保存できるようにしている。
 *
 * Mantle構成では、Bedrock Agent用のmemoryIdは使わない。
 * 代わりに、Mantleが返すresponse_idを lastResponseId として保存する。
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

  /**
   * 既存UserSessionがない場合。
   *
   * 初回会話用のUserSessionを新規作成する。
   * この時点では、まだMantleからresponse_idを受け取っていないため、
   * lastResponseId関連は空文字で初期化する。
   */
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
 * Mantleから返ってきたresponse_idを保存する。
 *
 * Core LambdaがMantle呼び出しに成功した後、
 * 次回の会話継続に使うために lastResponseId として保存する。
 *
 * responseId:
 *   Mantleが返した id / response_id。
 *   Lambda側では生成しない。
 *
 * createdAt:
 *   response_idを受け取った時刻。
 *   未指定の場合は現在時刻を使う。
 *
 * expiresAt:
 *   response_idの有効期限。
 *   指定がなければ createdAt + 29日 で保存する。
 *
 * @param {string} sub - Cognitoのユーザー識別子。
 * @param {object} params - response_id関連情報。
 * @param {string} params.responseId - Mantleから返ったresponse_id。
 * @param {string} [params.createdAt] - response_idを受け取った時刻。
 * @param {string} [params.expiresAt] - response_idの有効期限。
 * @returns {object} 更新後のUserSession。
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

  /**
   * Mantleの最新response_idを保存する。
   *
   * ここで保存された lastResponseId は、
   * 次回Mantle inputを作るときに previous_response_id として利用する。
   */
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
 *
 * lastResponseId関連だけを空に戻し、
 * sessionSummaryは消さない。
 *
 * sessionSummaryを残す理由:
 *   response_idが使えなくなった場合でも、
 *   Summary Lambdaなどで作った要約をMantleへ渡して
 *   会話を復旧できる可能性があるため。
 *
 * @param {string} sub - Cognitoのユーザー識別子。
 * @returns {object} 更新後のUserSession。
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
 * RAiM側の会話セッションを明示的に切り替える。
 *
 * たとえば、ユーザーが「新しい会話を始める」操作をした場合に使う。
 *
 * この関数では以下を行う。
 *
 * - currentSessionIdを新しくする
 * - MantleのlastResponseIdをクリアする
 * - lastResponseCreatedAtをクリアする
 * - lastResponseExpiresAtをクリアする
 * - sessionSummaryは残す
 *
 * sessionSummaryを残す理由:
 *   新しい会話に切り替えても、長期的な要約やユーザー文脈を
 *   後から使える可能性があるため。
 *
 * @param {string} sub - Cognitoのユーザー識別子。
 * @returns {object} 更新後のUserSession。
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