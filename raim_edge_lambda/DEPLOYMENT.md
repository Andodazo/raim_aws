# RAiM Edge Lambda デプロイメモ

このメモは、`raim_edge_lambda` の中身を `function.zip` としてAWS Lambdaへアップロードする前提で書いています。

Edge Lambdaは、API Gateway WebSocketとCore Lambda用SQS Queueの間に立つLambdaです。

## Edge Lambdaの役割

Edge Lambdaは大きく2つの処理を担当します。

1. WebSocket入口処理
   - `$connect` で接続情報をDynamoDBへ保存する
   - `$disconnect` で接続情報をDynamoDBから削除する
   - `$default` で受け取ったユーザー入力をCore Lambda用Request Queueへ送る

2. WebSocket返信処理
   - Core LambdaがResponse Queueへ送ったstreamイベントを受け取る
   - API Gateway Management APIで該当connectionIdへ返信する

MantleやTitanはEdge Lambdaでは呼びません。

## 必須環境変数

| 環境変数 | ダミー値 | 説明 |
|---|---|---|
| `AWS_REGION` | `ap-northeast-1` | DynamoDB / SQSを操作するリージョン |
| `REQUEST_QUEUE_URL` | `https://sqs.ap-northeast-1.amazonaws.com/990442281360/RAiM-CoreRequest-dev.fifo` | Core Lambdaが読むRequest QueueのURL |
| `CONNECTION_TABLE_NAME` | `RAiM-WebSocketConnection-dev` | WebSocket connectionIdを保存するDynamoDBテーブル名 |
| `WEBSOCKET_API_ENDPOINT` | `https://DUMMY_WEBSOCKET_API_ID.execute-api.ap-northeast-1.amazonaws.com/dev` | ApiGatewayManagementApiのendpoint |
| `CONNECTION_TTL_SECONDS` | `86400` | 接続情報をDynamoDB TTLで掃除するまでの秒数 |

`WEBSOCKET_API_ENDPOINT` は、WebSocket APIのInvoke URLです。

形式:

```text
https://{api-id}.execute-api.{region}.amazonaws.com/{stage}
```

例:

```text
https://abc123def4.execute-api.ap-northeast-1.amazonaws.com/dev
```

## 必要なAWSリソース

### API Gateway WebSocket API

想定route:

| Route | Edge Lambdaでの処理 |
|---|---|
| `$connect` | 接続情報をDynamoDBへ保存 |
| `$disconnect` | 接続情報をDynamoDBから削除 |
| `$default` | ユーザー入力をRequest Queueへ送信 |

`$connect` にはCognito Authorizerを設定し、Edge LambdaのeventにCognito `sub` が入る想定です。

### DynamoDB: WebSocket Connectionテーブル

想定テーブル名:

```text
RAiM-WebSocketConnection-dev
```

想定キー:

| 項目 | 型 | 説明 |
|---|---|---|
| `connectionId` | String | Partition Key。API Gateway WebSocketのconnectionId |

保存される主な属性:

| 属性 | 型 | 説明 |
|---|---|---|
| `connectionId` | String | WebSocket接続ID |
| `sub` | String | CognitoユーザーID |
| `domainName` | String | API GatewayのdomainName |
| `stage` | String | API Gateway stage |
| `connectedAt` | String | 接続日時 |
| `updatedAt` | String | 更新日時 |
| `expiresAt` | Number | DynamoDB TTL用のUNIX秒 |

TTL属性は `expiresAt` を指定してください。

### SQS Request Queue

Core Lambdaへユーザー入力を渡すFIFO Queueです。

想定名:

```text
RAiM-CoreRequest-dev.fifo
```

Edge LambdaはこのQueueへ次のようなJSONを送ります。

```json
{
  "schemaVersion": 1,
  "type": "chat.request",
  "requestId": "req-001",
  "connectionId": "websocket-connection-id",
  "sub": "cognito-user-sub",
  "source": "websocket",
  "text": "こんにちは",
  "images": [],
  "createdAt": "2026-06-25T00:00:00.000Z"
}
```

### SQS Response Queue

Core LambdaからEdge Lambdaへ生成結果を戻すFIFO Queueです。

Core Lambdaが送る想定イベント:

```text
stream.start
stream.delta
stream.completed
stream.error
```

Edge LambdaはこのQueueをEvent Source Mappingで購読し、各イベントをWebSocketへpostします。

作成済みのResponse Queue:

```text
RAiM-CoreResponse-dev.fifo
```

Edge Lambda側では、このQueue URLを環境変数に入れる必要はありません。
代わりに、Lambdaの「トリガーを追加」からSQSイベントソースとして紐づけます。

推奨イベントソースマッピング設定:

| 項目 | 設定値 |
|---|---|
| ソース | `SQS` |
| SQSキュー | `RAiM-CoreResponse-dev.fifo` |
| バッチサイズ | `1` |
| バッチウィンドウ | `0秒` |
| レポートバッチ項目の失敗 | `有効` |

バッチサイズは大きくしてもコード上は処理できますが、WebSocketへ順番に返す検証段階では `1` が分かりやすいです。

## 必要なIAM権限

Edge Lambdaの実行ロールには最低限次が必要です。

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ManageWebSocketConnections",
      "Effect": "Allow",
      "Action": [
        "execute-api:ManageConnections"
      ],
      "Resource": "arn:aws:execute-api:ap-northeast-1:990442281360:DUMMY_WEBSOCKET_API_ID/dev/POST/@connections/*"
    },
    {
      "Sid": "WriteCoreRequestQueue",
      "Effect": "Allow",
      "Action": [
        "sqs:SendMessage"
      ],
      "Resource": "arn:aws:sqs:ap-northeast-1:990442281360:RAiM-CoreRequest-dev.fifo"
    },
    {
      "Sid": "ReadCoreResponseQueue",
      "Effect": "Allow",
      "Action": [
        "sqs:ReceiveMessage",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes"
      ],
      "Resource": "arn:aws:sqs:ap-northeast-1:990442281360:RAiM-CoreResponse-dev.fifo"
    },
    {
      "Sid": "ManageConnectionTable",
      "Effect": "Allow",
      "Action": [
        "dynamodb:PutItem",
        "dynamodb:GetItem",
        "dynamodb:DeleteItem"
      ],
      "Resource": "arn:aws:dynamodb:ap-northeast-1:990442281360:table/RAiM-WebSocketConnection-dev"
    }
  ]
}
```

## `function.zip` に含めるもの

`raim_edge_lambda` の中で次を含めてzip化します。

```text
index.js
lib/
package.json
package-lock.json
node_modules/
```

`test/` やMarkdownはLambda実行には不要です。

## ローカルテスト

```bash
npm install
npm test
```

## CloudWatch Logsで見るポイント

- `$connect` でCognito `sub` が取得できているか
- `$default` でRequest Queueへ送れているか
- Response Queueイベントで `connectionId` が入っているか
- WebSocket post時に `GoneException` が出ていないか
- `batchItemFailures` に失敗messageIdだけが返っているか
