# Core Lambda コンソール用テストイベント

このファイルは、SQS Event Source Mappingがまだ未設定でも、AWS Lambdaコンソールの「テスト」からCore Lambdaを直接実行して、Titan Embedding・Scene選択・Mantle呼び出しを確認するためのイベント集です。

## 先に確認すること

Lambdaコンソールから直接実行する場合、SQS Request Queueは使いません。

```text
Lambda Console Test Event
  -> Core Lambda
  -> DynamoDB UserSession
  -> DynamoDB FewShot
  -> Titan Text Embeddings V2
  -> Bedrock Mantle
  -> Lambda実行結果として返る
```

そのため、まず確認したい内容が「MantleとEmbeddingが動くか」であれば、`Records` を含まない直接イベントを使ってください。

## 必要な環境変数

直接実行でも、Core Lambdaの本処理を通るため以下は設定が必要です。

```text
MANTLE_API_KEY_SECRET_ARN
MANTLE_API_KEY_SECRET_JSON_KEY
MANTLE_SECRET_REGION
OPENAI_BASE_URL
MANTLE_MODEL
USER_SESSION_TABLE_NAME
SCENE_TABLE_NAME
BEDROCK_REGION
TITAN_EMBEDDING_MODEL_ID
TITAN_EMBEDDING_DIMENSIONS
```

`RESPONSE_QUEUE_URL` と `REQUEST_STATE_TABLE_NAME` は、SQS経由で実行する時に必要です。  
直接実行のMantle/Embedding確認だけなら基本的には使いません。

ただし、最終構成では必要になるので、設定しておくのがおすすめです。

## 事前データ

`SCENE_TABLE_NAME`、通常は `RAiM-FewShot-dev` に、各Sceneの `textCentroid` が入っている必要があります。

まだ入っていない場合は、先にCloudShellで以下を実行してください。

```bash
node generate_scene_centroids.js --apply
```

`textCentroid` が無い場合、Core LambdaはScene選択でdefaultへfallbackします。  
Titan呼び出し自体は行われますが、意図したScene選択の確認にはなりません。

## テストイベント1: joke Scene想定

Lambdaコンソールのテストイベントに以下を貼り付けます。

```json
{
  "sub": "console-test-user-001",
  "requestId": "console-joke-001",
  "connectionId": "console-connection-001",
  "source": "lambda-console",
  "text": "つまんないダジャレ言うぞ",
  "images": []
}
```

確認ポイント:

- Titan Embeddingが成功する
- `RAiM-FewShot-dev` からScene一覧を読める
- `joke` に近いSceneが選ばれる
- MantleからJSON応答が返る
- Lambda結果が以下のような形になる

```json
{
  "ok": true,
  "type": "chat",
  "requestId": "console-joke-001",
  "text": "...",
  "emotion": "happy",
  "intensity": 0.5
}
```

## テストイベント2: gaming Scene想定

```json
{
  "sub": "console-test-user-001",
  "requestId": "console-gaming-001",
  "connectionId": "console-connection-001",
  "source": "lambda-console",
  "text": "マイクラのMOD入れた",
  "images": []
}
```

確認ポイント:

- `gaming` 系のSceneに近い入力として処理される
- Mantleの返答がゲームの話題に寄る

## テストイベント3: tired Scene想定

```json
{
  "sub": "console-test-user-001",
  "requestId": "console-tired-001",
  "connectionId": "console-connection-001",
  "source": "lambda-console",
  "text": "今日はもう疲れた",
  "images": []
}
```

確認ポイント:

- `tired` 系のSceneに近い入力として処理される
- Mantleの返答がいたわる方向に寄る

## テストイベント4: default Scene想定

```json
{
  "sub": "console-test-user-001",
  "requestId": "console-default-001",
  "connectionId": "console-connection-001",
  "source": "lambda-console",
  "text": "なんとなく話したい",
  "images": []
}
```

確認ポイント:

- 特定Sceneへ強く寄らない入力として処理される
- 類似度が閾値未満ならdefault Sceneへfallbackする

## テストイベント5: Edge Lambdaから来るRequest Queueメッセージ相当

SQSは使わず、Edge LambdaがRequest Queueへ送る本文と同じshapeを直接渡して確認するテストです。

```json
{
  "schemaVersion": 1,
  "type": "chat.request",
  "requestId": "console-edge-shape-001",
  "connectionId": "console-connection-001",
  "sub": "console-test-user-001",
  "source": "websocket",
  "text": "笑わせて",
  "images": [],
  "createdAt": "2026-06-30T00:00:00.000Z"
}
```

確認ポイント:

- Core LambdaがEdge Lambdaの正式Request Queue形式を受け付ける
- `schemaVersion=1` / `type=chat.request` の検証を通る
- SQSなしでもMantle/Embedding本処理まで進む

## テストイベント6: SQSイベントをLambdaコンソールで擬似実行する場合

これはSQS Event Source Mappingを使わず、LambdaコンソールからSQS形式のイベントを直接渡すテストです。

注意:

- この形式ではCore LambdaはSQS処理パスに入ります
- `RESPONSE_QUEUE_URL` が必要です
- Core LambdaはResponse Queueへ `stream.start` / `stream.delta` / `stream.completed` を送ります
- Response QueueがEdge Lambdaに紐づいている場合、`connectionId` 宛のWebSocket postも発生する可能性があります

まずMantle/Embeddingだけ確認したい場合は、テストイベント1〜5を使ってください。

```json
{
  "Records": [
    {
      "messageId": "console-sqs-message-001",
      "receiptHandle": "console-receipt-handle",
      "body": "{\"schemaVersion\":1,\"type\":\"chat.request\",\"requestId\":\"console-sqs-001\",\"connectionId\":\"console-connection-001\",\"sub\":\"console-test-user-001\",\"source\":\"websocket\",\"text\":\"笑わせて\",\"images\":[],\"createdAt\":\"2026-06-30T00:00:00.000Z\"}",
      "attributes": {
        "ApproximateReceiveCount": "1",
        "SentTimestamp": "1782777600000",
        "SenderId": "console",
        "ApproximateFirstReceiveTimestamp": "1782777600000",
        "MessageGroupId": "console-connection-001",
        "MessageDeduplicationId": "console-sqs-001"
      },
      "messageAttributes": {},
      "md5OfBody": "00000000000000000000000000000000",
      "eventSource": "aws:sqs",
      "eventSourceARN": "arn:aws:sqs:ap-northeast-1:990442281360:RAiM-CoreRequest-dev.fifo",
      "awsRegion": "ap-northeast-1"
    }
  ]
}
```

成功時のLambda実行結果は次のようになります。

```json
{
  "batchItemFailures": []
}
```

この場合、最終応答本文はLambdaの戻り値ではなく、Response Queueへ送られます。

## エラー別の見方

### `EMBED_ERROR`

Titan Embedding呼び出しに失敗しています。

確認するもの:

- Lambda実行ロールに `bedrock:InvokeModel` があるか
- `BEDROCK_REGION=ap-northeast-1` になっているか
- `TITAN_EMBEDDING_MODEL_ID=amazon.titan-embed-text-v2:0` になっているか
- FewShotの `textCentroid` と `TITAN_EMBEDDING_DIMENSIONS` が一致しているか

### `LLM_ERROR` / `LLM_TIMEOUT`

Mantle呼び出しに失敗しています。

確認するもの:

- `OPENAI_BASE_URL` が正しいか
- `MANTLE_MODEL` が `/models` に出てきたIDか
- Secrets ManagerにMantle API Keyが保存されているか
- Lambda実行ロールに `secretsmanager:GetSecretValue` があるか

### `INVALID_INPUT`

テストイベントの形式がCore Lambdaの期待と違います。

確認するもの:

- `sub` があるか
- `requestId` が文字列か
- `text` または `images` のどちらかがあるか
- `schemaVersion` を指定する場合は `1` か
- `type` を指定する場合は `chat.request` か

## 最初におすすめする実行順

1. テストイベント5
   - Edge Lambdaの正式message shapeをSQSなしで確認
2. テストイベント1
   - joke Scene想定でScene選択とMantleを確認
3. テストイベント2〜4
   - Scene選択の傾向を確認
4. テストイベント6
   - Response Queue送信まで含めたSQSパスを擬似確認
