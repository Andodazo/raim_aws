# Core Lambda：Lambdaコンソール用テストイベント

このフォルダーには、SQS Event Source Mappingを設定する前でも、AWS Lambdaコンソールの
「テスト」からCore Lambdaを確認できるイベントを置いています。

## このテストで通る処理

正常系のイベントはCore Lambdaを直接呼び出し、次の処理を実AWS上で実行します。

1. 入力イベントの検証と正規化
2. `RAiM-UserSession-dev`からユーザーの会話状態を取得または作成
3. `RAiM-FewShot-dev`からSceneとFew-shotを取得
4. Titan Text Embeddings V2でユーザー入力をEmbedding
5. `textCentroid`との類似度からSceneを選択
6. Secrets ManagerからMantle API Keyを取得
7. MantleのGemma 4へリクエストを送信
8. Mantleの`response_id`をUserSessionへ保存
9. Core Lambda形式の応答をLambdaコンソールへ返却

直接呼び出しのため、Request Queue、`RAiM-CoreRequest-dev`、Response Queue、
Edge Lambda、API Gateway WebSocketへの送信は実行しません。

## 事前条件

Lambdaの環境変数と実行ロールを先に設定してください。特に次が必要です。

- `OPENAI_BASE_URL=https://bedrock-mantle.us-east-1.api.aws/openai/v1`
- `MANTLE_MODEL=google.gemma-4-31b`
- Mantle API Keyを保存したSecrets Manager関連の環境変数
- `USER_SESSION_TABLE_NAME=RAiM-UserSession-dev`
- `SCENE_TABLE_NAME=RAiM-FewShot-dev`
- `BEDROCK_REGION=ap-northeast-1`
- `TITAN_EMBEDDING_MODEL_ID=amazon.titan-embed-text-v2:0`
- `TITAN_EMBEDDING_DIMENSIONS=1024`

Lambda実行ロールには、少なくとも対象Secretの`secretsmanager:GetSecretValue`、
Titanの`bedrock:InvokeModel`、2つのDynamoDBテーブルに対する必要な読み書き権限が必要です。

`RAiM-FewShot-dev`の各Sceneには、1024次元の`textCentroid`を登録しておいてください。

## Lambdaコンソールへの登録手順

1. AWS LambdaコンソールでCore Lambdaを開きます。
2. 「テスト」タブから「新しいイベントを作成」を選択します。
3. イベント名を入力します。
4. 対応するJSONファイルの内容をイベントJSONへ貼り付けます。
5. 「保存」してから「テスト」を実行します。

## ケース1：初回の実接続テスト

使用ファイル：`01-full-integration-initial.json`

推奨イベント名：`CoreFullIntegrationInitial`

Titan、Scene選択、Mantle、DynamoDBを含む一連の処理を確認します。成功時は概ね次の形式になります。

```json
{
  "ok": true,
  "type": "chat",
  "requestId": "console-initial-001",
  "text": "Mantleが生成した返答",
  "emotion": "happy",
  "intensity": 0.5
}
```

同じ`sub`のUserSessionが既に存在する場合は、保存済みの`response_id`を使った継続会話に
なることがあります。完全な初回として再試験する場合は、JSON内の`sub`を未使用の値へ変更してください。

## ケース2：継続会話テスト

使用ファイル：`02-full-integration-followup.json`

推奨イベント名：`CoreFullIntegrationFollowup`

ケース1が成功した後に実行してください。同じ`sub`を使い、ケース1で保存した
`lastResponseId`がMantleの`previous_response_id`として利用される経路を確認します。

`requestId`はケース1と異なる値にしています。テストを繰り返す場合も、CloudWatch Logsで
実行を区別しやすいように末尾の番号を変更してください。

## ケース3：空メッセージの入力検証

使用ファイル：`03-invalid-empty-message.json`

推奨イベント名：`CoreInvalidEmptyMessage`

`text`と`images`が両方空なので、外部サービスを呼び出す前に`INVALID_INPUT`が返ることを確認します。

```json
{
  "ok": false,
  "type": "error",
  "code": "INVALID_INPUT",
  "retriable": false,
  "requestId": "console-invalid-empty-001"
}
```

## ケース4：未対応schemaVersionの入力検証

使用ファイル：`04-invalid-schema-version.json`

推奨イベント名：`CoreInvalidSchemaVersion`

`schemaVersion=999`を拒否し、Titan、Mantle、DynamoDBを呼び出さずに
`INVALID_INPUT`を返すことを確認します。

## エラー結果の見方

- `EMBED_ERROR`: Titanの権限、リージョン、model ID、Embedding次元を確認
- `LLM_ERROR`: Mantle URL、model ID、Secret取得権限、API Keyを確認
- `LLM_TIMEOUT`: Mantleの応答時間とLambdaのタイムアウト設定を確認
- `INTERNAL_ERROR`: DynamoDB権限、テーブル名、CloudWatch Logsの例外を確認

正常系がタイムアウトする場合、Lambdaのタイムアウトを最低でも60秒程度に設定してから
再確認してください。
