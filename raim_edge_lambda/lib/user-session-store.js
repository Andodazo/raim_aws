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
const { DynamoDBDocumentClient, UpdateCommand } = require('@aws-sdk/lib-dynamodb');

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

module.exports = {
  TABLE_NAME,
  clearMemoryForDeletion,
};
