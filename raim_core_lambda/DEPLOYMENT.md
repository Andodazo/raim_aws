# RAiM Core Lambda deployment parameters

Core Lambdaの対象範囲は次の経路です。

```text
Edge Lambda
  -> Request Queue (FIFO)
  -> Core Lambda
  -> Titan Text Embeddings V2
  -> Bedrock Mantle Responses API (stream=true)
  -> Response Queue (FIFO)
  -> Edge Lambda
```

TTS Lambda、Tool Lambda、Backup Lambdaはこの実装範囲に含みません。

## デプロイ前に置換が必要なダミー値

| CloudFormation parameter | ダミー値 | 用途 |
|---|---|---|
| `DeploymentBucketName` | `DUMMY_DEPLOYMENT_BUCKET_REPLACE_ME` | `function.zip`を配置するS3 bucket |
| `DeploymentObjectKey` | `function.zip` | Lambda deployment packageのS3 key |
| `MantleApiKeySecretArn` | `arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:DUMMY_MANTLE_API_KEY_SECRET_REPLACE_ME` | Mantle API keyを保存したSecret ARN |
| `MantleApiKeySecretJsonKey` | `apiKey` | Secret JSON内のAPI key項目名 |
| `MantleSecretRegion` | `ap-northeast-1` | Secretを保存したリージョン |
| `MantleModelId` | `DUMMY_GEMMA4_MODEL_ID_REPLACE_ME` | us-west-2で利用するGemma 4 model ID |

## 主な設定可能パラメータ

| 分類 | Parameters |
|---|---|
| Lambda | `CoreLambdaFunctionName`, `CoreLambdaRoleName` |
| DynamoDB | `UserSessionTableName`, `SceneTableName`, `RequestStateTableName` |
| Queue | `RequestQueueName`, `ResponseQueueName`, 各DLQ名、visibility、retention、max receive count |
| Mantle | `MantleApiKeySecretArn`, `MantleApiKeySecretJsonKey`, `MantleSecretRegion`, `MantleEndpointUrl`, `MantleModelId`, `MantleTimeoutMs`, `MantleMaxOutputTokens`, `MantleTemperature` |
| Titan | `TitanRegion`, `TitanModelId`, `TitanInvokeResourceArn`, `TitanEmbeddingDimensions` |
| Stream | `StreamChunkMinimumCharacters`, `RequestLeaseSeconds`, `RequestStateTtlSeconds` |

## Lambdaに設定する必須環境変数

CloudFormationからデプロイせず、`raim_core_lambda`の中身を`function.zip`として
Lambdaへ直接アップロードする場合は、Lambdaコンソールの
「設定 > 環境変数」に次を設定する。

| 環境変数 | 設定例 | 用途 |
|---|---|---|
| `MANTLE_API_KEY_SECRET_ARN` | `arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:raim/mantle-api-key-AbCdEf` | Mantle API keyを保存したSecretの完全なARN |
| `MANTLE_API_KEY_SECRET_JSON_KEY` | `apiKey` | SecretStringのJSONからAPI keyを読む項目名 |
| `MANTLE_SECRET_REGION` | `ap-northeast-1` | Secretを作成したリージョン |
| `OPENAI_BASE_URL` | `https://bedrock-mantle.us-west-2.api.aws/openai/v1` | Gemma 4を呼び出すMantle endpoint |
| `MANTLE_MODEL` | `実際のGemma 4 model ID` | Mantleへ送るmodel ID |
| `RESPONSE_QUEUE_URL` | `https://sqs.ap-northeast-1.amazonaws.com/123456789012/raim-core-response-dev.fifo` | streaming eventの送信先FIFO Queue URL |
| `USER_SESSION_TABLE_NAME` | `RAiM-UserSession-dev` | 会話状態を保存するDynamoDB table |
| `SCENE_TABLE_NAME` | `RAiM-FewShot-dev` | Sceneとfew-shotを読むDynamoDB table |
| `REQUEST_STATE_TABLE_NAME` | `RAiM-CoreRequest-dev` | SQS requestの重複実行防止状態を保存するtable |
| `BEDROCK_REGION` | `ap-northeast-1` | Titanを呼び出すAWSリージョン |
| `TITAN_EMBEDDING_MODEL_ID` | `amazon.titan-embed-text-v2:0` | 利用するTitan embedding model ID |
| `TITAN_EMBEDDING_DIMENSIONS` | `1024` | Scene centroidと一致させるベクトル次元 |

`OPENAI_API_KEY`と`TITAN_ENDPOINT_URL`は設定しない。
API key本体はSecrets Managerだけに保存し、Titanの接続先はAWS SDKが
`BEDROCK_REGION`から選ぶ標準Bedrock Runtime endpointを使用する。

`AWS_REGION`はLambdaが自動設定する予約済み環境変数なので、利用者が追加する必要はない。

### Secrets Managerに保存する値

上記の例ではSecret valueを次のJSONにする。

```json
{
  "apiKey": "実際のBedrock Mantle APIキー"
}
```

Lambda実行ロールには、対象Secret ARNに限定した
`secretsmanager:GetSecretValue`を付与する。Secretをcustomer managed KMS keyで
暗号化した場合は、そのkeyに対する`kms:Decrypt`も付与する。

## Request Queue message

Edge Lambdaは、WebSocketの `$default` で受け取ったユーザー入力を、
次の `chat.request` 形式でCore Lambda用Request Queueへ送ります。

FIFO Queueでは、同じWebSocket接続からの入力順序を守るため、
`MessageGroupId=connectionId` を使います。
重複送信を抑えるため、`MessageDeduplicationId=requestId` を使います。

```json
{
  "schemaVersion": 1,
  "type": "chat.request",
  "sub": "cognito-user-sub",
  "requestId": "req-001",
  "connectionId": "websocket-connection-id",
  "source": "websocket",
  "text": "こんにちは",
  "images": [],
  "createdAt": "2026-06-30T00:00:00.000Z"
}
```

Core Lambdaは `schemaVersion=1` と `type=chat.request` を正式なRequest Queue形式として検証します。
schemaVersionやtypeが異なるメッセージは入力不正として扱います。

## Response Queue events

Core Lambdaは`requestId`をFIFO MessageGroupIdとして、次の順序で送ります。

```text
stream.start
stream.delta (0回以上)
stream.completed または stream.error
```

`stream.delta`例:

```json
{
  "schemaVersion": 1,
  "type": "stream.delta",
  "requestId": "req-001",
  "connectionId": "websocket-connection-id",
  "sub": "cognito-user-sub",
  "sequence": 1,
  "attempt": 1,
  "textDelta": "こんにちは"
}
```

Edge Lambdaは`requestId + attempt + sequence`で重複を除去し、より大きいattemptを
受け取った場合は古いattemptの後続を破棄してから、API Gateway Management
APIの`postToConnection`でクライアントへ転送します。

## DynamoDB Scene prerequisite

`RAiM-FewShot-dev`の各Sceneには、`TitanModelId`と
`TitanEmbeddingDimensions`で生成した`textCentroid`が必要です。
centroidがないSceneは類似度選択の候補になりません。
