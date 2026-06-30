'use strict';

// ==============================================================================
// RAiM WebSocket Lambda Authorizer Entry Point
// ==============================================================================
//
// API Gateway WebSocket API の `$connect` に設定するLambda Authorizer。
//
// 役割:
//   1. wscat / Client から送られたCognito JWTを取り出す
//   2. Cognito User Poolの公開鍵でJWT署名・期限・aud/client_id等を検証する
//   3. subをprincipalId/context.subとしてAPI Gatewayへ返す
//
// Edge Lambdaは `$connect` event.requestContext.authorizer からsubを受け取り、
// connectionIdと紐づけてDynamoDBへ保存する。

const { authorize } = require('./lib/authorizer-service');

async function handler(event, context = {}) {
  return authorize(event, { requestId: context.awsRequestId });
}

module.exports = {
  handler,
};
