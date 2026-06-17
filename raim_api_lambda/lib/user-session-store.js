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

const ddbClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);

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
    await docClient.send(
      new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { sub },
        UpdateExpression: 'SET lastAccessedAt = :now, updatedAt = :now',
        ExpressionAttributeValues: {
          ':now': now,
        },
      })
    );

    return {
      ...getResult.Item,
      isNew: false,
    };
  }

  const item = {
    sub,
    memoryId: `memory-${sub}`,
    currentSessionId: `session-${crypto.randomUUID()}`,
    sessionSummary: '',
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

module.exports = {
  getOrCreateUserSession,
};