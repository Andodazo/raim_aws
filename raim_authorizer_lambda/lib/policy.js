'use strict';

// ==============================================================================
// API Gateway Authorizer Policy Builder
// ==============================================================================
//
// WebSocket API GatewayのLambda Authorizerへ返すIAM policy形式のレスポンスを作る。
// principalIdにはCognito subを入れる。
//
// contextに入れた値は、Edge Lambda側で
// event.requestContext.authorizer.sub として参照できる。

function createPolicy({ principalId, effect, resource, context = {} }) {
  return {
    principalId,
    policyDocument: {
      Version: '2012-10-17',
      Statement: [
        {
          Action: 'execute-api:Invoke',
          Effect: effect,
          Resource: resource,
        },
      ],
    },
    context,
  };
}

function createAllowPolicy({ sub, methodArn, claims = {} }) {
  return createPolicy({
    principalId: sub,
    effect: 'Allow',
    resource: methodArn,
    context: {
      sub,
      username: String(claims.username || claims['cognito:username'] || ''),
      email: String(claims.email || ''),
      tokenUse: String(claims.token_use || ''),
      // トークンの期限（UNIX 秒）。Edge が接続に保存し、期限切れの接続を切るのに使う
      exp: Number(claims.exp) || 0,
    },
  });
}

function createDenyPolicy({ methodArn, reason = 'Unauthorized' }) {
  return createPolicy({
    principalId: 'anonymous',
    effect: 'Deny',
    resource: methodArn || '*',
    context: {
      reason,
    },
  });
}

module.exports = {
  createAllowPolicy,
  createDenyPolicy,
  createPolicy,
};
