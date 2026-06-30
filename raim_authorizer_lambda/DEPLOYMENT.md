# RAiM Authorizer Lambda デプロイメモ

このLambdaは、WebSocket API Gatewayの `$connect` に設定する検証用Lambda Authorizerです。

## 役割

`wscat` やアプリから送られたCognito JWTを検証し、Cognitoユーザーの `sub` をAPI Gateway経由でEdge Lambdaへ渡します。

流れ:

```text
wscat / Client
  ↓ Authorization: Bearer {Cognito JWT}
WebSocket API Gateway $connect
  ↓ Lambda Authorizer
raim_authorizer_lambda
  ↓ principalId/context.sub
Edge Lambda $connect
  ↓ connectionId + sub をDynamoDBへ保存
```

## 必須環境変数

| 環境変数 | ダミー値 | 説明 |
|---|---|---|
| `COGNITO_USER_POOL_ID` | `ap-northeast-1_DUMMY_REPLACE_ME` | Cognito User Pool ID |
| `COGNITO_CLIENT_ID` | `DUMMY_COGNITO_APP_CLIENT_ID_REPLACE_ME` | Cognito App Client ID |
| `COGNITO_TOKEN_USE` | `access` | 許可するトークン種別。`access` / `id` / `any` |

`wscat` でAccess Tokenを使う想定なら、`COGNITO_TOKEN_USE=access` のままで大丈夫です。

ID Tokenでも試したい場合は、検証中だけ `COGNITO_TOKEN_USE=any` にできます。

## WebSocket API Gateway側の設定

`$connect` routeにLambda Authorizerを設定してください。

AuthorizerのIdentity Sourceは、まず以下がおすすめです。

```text
route.request.header.Authorization
```

wscatでクエリパラメータ方式も使いたい場合は、API Gateway側で許可するIdentity Sourceに以下も追加します。

```text
route.request.querystring.access_token
```

ただし、本番ではHeader方式を推奨します。

## wscatでの接続例

PowerShellではまず1行で実行するのが安全です。

```powershell
wscat -c "wss://{api-id}.execute-api.ap-northeast-1.amazonaws.com/dev" -H "Authorization: Bearer {ACCESS_TOKEN}"
```

クエリパラメータで試す場合:

```powershell
wscat -c "wss://{api-id}.execute-api.ap-northeast-1.amazonaws.com/dev?access_token={ACCESS_TOKEN}"
```

## Lambda Authorizerが返す値

認証成功時:

```json
{
  "principalId": "cognito-user-sub",
  "policyDocument": {
    "Version": "2012-10-17",
    "Statement": [
      {
        "Action": "execute-api:Invoke",
        "Effect": "Allow",
        "Resource": "methodArn"
      }
    ]
  },
  "context": {
    "sub": "cognito-user-sub",
    "username": "user name if present",
    "email": "email if present",
    "tokenUse": "access"
  }
}
```

Edge Lambdaは、`requestContext.authorizer.principalId` または `requestContext.authorizer.sub` から `sub` を取得します。

## `function.zip` に含めるもの

```text
index.js
lib/
package.json
package-lock.json
node_modules/
```

`test/`、`DEPLOYMENT.md`、`FILES.md` はLambda実行には不要です。

## 必要なIAM権限

このLambdaはCognitoの公開JWKをHTTPSで取得してJWTを検証します。

通常、追加のAWS API権限は不要です。

CloudWatch Logs出力のため、Lambda基本実行ロールは必要です。

## よくあるエラー

### まだ400/401になる

以下を確認してください。

- `$connect` routeにAuthorizerが設定されているか
- Identity Sourceが `route.request.header.Authorization` になっているか
- `wscat` の `-H "Authorization: Bearer ..."` がPowerShellで正しく渡っているか
- `COGNITO_USER_POOL_ID` と `COGNITO_CLIENT_ID` が実際のCognitoに合っているか
- Access Tokenを使う場合、`COGNITO_TOKEN_USE=access` になっているか
- ID Tokenを使う場合、`COGNITO_TOKEN_USE=id` または `any` になっているか

### Edge Lambdaでsubが取れない

Authorizerの戻り値に `principalId` または `context.sub` が入っているか確認してください。

この実装では両方にCognito `sub` を入れています。
