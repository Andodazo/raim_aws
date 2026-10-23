'use strict';

// ==============================================================================
// Chat Rate Limiter（C-04）
// ==============================================================================
//
// チャット1回ごとに Bedrock（Mantle）と読み上げの料金がかかる。
// 以前は WebSocket のチャットに人ごとの上限が無く（REST の Usage Plan は
// WebSocket には効かない）、登録した人なら誰でも、アプリの不具合でも、
// 送った分だけ料金が増えた。
//
// sub ごとに「1分」と「1日」の回数を数え、超えたら断る。
// 数える場所は Core の要求状態テーブル（RAiM-CoreRequest-dev）を相乗りする。
// TTL（expiresAt）が有効なので、数えた項目は自動で消える。
// キーは `rate#` で始めるので、Core の `${sub}#${requestId}` とは重ならない。
// ==============================================================================

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  UpdateCommand,
} = require('@aws-sdk/lib-dynamodb');

const WINDOWS = Object.freeze([
  { name: 'minute', seconds: 60, envName: 'CHAT_RATE_LIMIT_PER_MINUTE', fallback: 20 },
  { name: 'day', seconds: 24 * 60 * 60, envName: 'CHAT_RATE_LIMIT_PER_DAY', fallback: 500 },
]);

function readLimit(env, name, fallback) {
  const value = Number(env[name] ?? fallback);
  // 0 以下にすると、その上限は使わない
  return Number.isFinite(value) ? Math.floor(value) : fallback;
}

function createRateLimiter({ client, env = process.env, now = () => Date.now() } = {}) {
  const tableName = String(env.REQUEST_STATE_TABLE_NAME || 'RAiM-CoreRequest-dev');
  let ddb = client || null;
  const getClient = () => ddb ||= DynamoDBDocumentClient.from(
    new DynamoDBClient({ region: env.AWS_REGION || 'ap-northeast-1' })
  );

  /**
   * 1回分を数える。上限を超えていたら { allowed: false, window } を返す。
   *
   * 数えるのに失敗したとき（DynamoDB の障害など）は通す。
   * 上限は料金の守りなので、障害でチャット全体を止めるほうが困る。
   */
  async function consume(sub) {
    const nowSeconds = Math.floor(now() / 1000);

    for (const window of WINDOWS) {
      const limit = readLimit(env, window.envName, window.fallback);
      if (limit <= 0) continue;

      const bucket = Math.floor(nowSeconds / window.seconds);
      try {
        await getClient().send(new UpdateCommand({
          TableName: tableName,
          Key: { requestKey: `rate#${window.name}#${sub}#${bucket}` },
          UpdateExpression: 'ADD #count :one SET expiresAt = if_not_exists(expiresAt, :expiresAt)',
          // 上限に届いていたら数えずに断る
          ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
          ExpressionAttributeNames: { '#count': 'count' },
          ExpressionAttributeValues: {
            ':one': 1,
            ':limit': limit,
            ':expiresAt': (bucket + 1) * window.seconds + 60,
          },
        }));
      } catch (error) {
        if (error?.name === 'ConditionalCheckFailedException') {
          return { allowed: false, window: window.name, limit };
        }
        console.warn(`[RateLimit] could not count: ${error.message}`);
        return { allowed: true };
      }
    }

    return { allowed: true };
  }

  return { consume };
}

module.exports = {
  createRateLimiter,
};
