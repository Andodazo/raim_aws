# RAiM Edge Lambda ファイル説明

このドキュメントは、`raim_edge_lambda` 配下の各ファイルが何を担当しているかを整理したものです。

Edge Lambdaは、クライアントのWebSocket接続を受け付け、ユーザー入力をCore Lambda用Request Queueへ送り、Core Lambdaから戻ってきたResponse QueueイベントをWebSocketへ返す役割を持ちます。

Response Queueは環境変数ではなく、Edge LambdaのSQSイベントソースマッピングとして紐づけます。

## 目次

- [ファイル群の全体図](#ファイル群の全体図)
- [全体の処理フロー](#全体の処理フロー)
- [ルート直下のファイル](#ルート直下のファイル)
- [`lib` 配下の実装ファイル](#lib-配下の実装ファイル)
- [`test` 配下のテストファイル](#test-配下のテストファイル)
- [Core Lambdaとの接続点](#core-lambdaとの接続点)

## ファイル群の全体図

```text
raim_edge_lambda/
├── index.js                         ← Lambdaの入口。WebSocketイベント/SQSイベントを振り分ける
├── package.json                     ← Node.js依存パッケージとnpm testコマンドの定義
├── package-lock.json                ← npm install後に作られる依存バージョン固定ファイル
├── DEPLOYMENT.md                    ← 環境変数・IAM権限・アップロード手順のメモ
├── FILES.md                         ← このファイル。Edge Lambda各ファイルの説明
├── lib/                             ← Edge Lambdaの実装コード本体
│   ├── client-message.js             ← Coreのstreamイベントをクライアント向けJSONへ変換する
│   ├── config.js                     ← 必須環境変数を読み取り、設定ミスを早めに検出する
│   ├── connection-store.js           ← WebSocket connectionIdをDynamoDBへ保存/取得/削除する
│   ├── request-queue-publisher.js    ← ユーザー入力をCore Lambda用Request Queueへ送る
│   ├── response-queue-handler.js     ← Core Response QueueイベントをWebSocketへ中継する
│   ├── websocket-event.js            ← API Gateway WebSocketイベントを正規化する
│   ├── websocket-handler.js          ← $connect/$disconnect/$default routeを処理する
│   ├── websocket-postback.js         ← ApiGatewayManagementApiでconnectionIdへpostする
│   └── websocket-response.js         ← API Gatewayへ返すHTTP形式レスポンスを作る
└── test/                             ← Node.js標準テストランナー用の単体テスト
    ├── client-message.test.js        ← streamイベント変換のテスト
    ├── index.test.js                 ← WebSocket/SQSイベント判定のテスト
    ├── response-queue-handler.test.js ← Response QueueからWebSocket返信までのテスト
    ├── websocket-event.test.js       ← WebSocketイベント正規化のテスト
    ├── websocket-handler.test.js     ← $connect/$disconnect/$default処理のテスト
    └── websocket-postback.test.js    ← WebSocket送信サイズ制限のテスト
```

まず全体を把握するなら、`index.js` → `lib/websocket-handler.js` → `lib/request-queue-publisher.js` → `lib/response-queue-handler.js` の順に読むと流れを追いやすいです。

## 全体の処理フロー

```mermaid
flowchart TD
  A["Client WebSocket"] --> B["API Gateway WebSocket"]
  B --> C["Edge Lambda index.js"]
  C --> D["websocket-handler.js"]
  D --> E["connection-store.js"]
  D --> F["request-queue-publisher.js"]
  F --> G["Core Request Queue"]
  G --> H["Core Lambda"]
  H --> I["Core Response Queue"]
  I --> C
  C --> J["response-queue-handler.js"]
  J --> K["websocket-postback.js"]
  K --> A
```

## ルート直下のファイル

### `index.js`

Edge Lambdaのエントリーポイントです。

主な役割:

- API Gateway WebSocketイベントかSQSイベントかを判定する
- WebSocketイベントなら `websocket-handler.js` へ渡す
- SQSイベントなら `response-queue-handler.js` へ渡す
- 想定外イベントの場合は400レスポンスを返す

### `package.json`

Edge Lambdaで使うAWS SDKとテストコマンドを定義します。

主な依存:

- `@aws-sdk/client-apigatewaymanagementapi`
  - WebSocket connectionIdへpostするために使用
- `@aws-sdk/client-dynamodb`
  - DynamoDB低レベルクライアント
- `@aws-sdk/lib-dynamodb`
  - DynamoDB DocumentClient
- `@aws-sdk/client-sqs`
  - Core Request Queueへメッセージを送るために使用

### `DEPLOYMENT.md`

Lambda環境変数、IAM権限、必要なAWSリソース、`function.zip` に含めるものをまとめたメモです。

### `FILES.md`

このファイルです。

Edge Lambdaの各ファイルの役割を把握するための引き継ぎ資料です。

## `lib` 配下の実装ファイル

### `lib/config.js`

環境変数を読み取り、必須値が無い場合は明確なエラーにします。

扱う主な環境変数:

- `AWS_REGION`（任意。未指定時は `ap-northeast-1`）
- `REQUEST_QUEUE_URL`
- `CONNECTION_TABLE_NAME`
- `WEBSOCKET_API_ENDPOINT`
- `CONNECTION_TTL_SECONDS`
- `MAX_WEBSOCKET_MESSAGE_BYTES`

### `lib/websocket-event.js`

API Gateway WebSocketイベントをEdge Lambda内部形式へ正規化します。

主な役割:

- `routeKey` を取り出す
- `connectionId` を取り出す
- Cognito Authorizerから `sub` を取り出す
- JSON bodyをparseする
- `text` / `images` / `requestId` を正規化する
- 入力不正を `WebSocketEventError` として返す

### `lib/websocket-handler.js`

WebSocket routeごとの処理を担当します。

主な処理:

- `$connect`
  - `connection-store.js` で接続情報を保存する
- `$disconnect`
  - `connection-store.js` で接続情報を削除する
- `$default`
  - ユーザー入力を `request-queue-publisher.js` でCore Request Queueへ送る

### `lib/connection-store.js`

DynamoDBのWebSocket接続管理テーブルを操作します。

保存する主な情報:

- `connectionId`
- `sub`
- `domainName`
- `stage`
- `connectedAt`
- `updatedAt`
- `expiresAt`

`expiresAt` はTTL用です。切断イベントが取りこぼされた場合でも、古い接続情報を自動削除できるようにします。

`$default` イベントにCognito `sub` が含まれない場合は、このテーブルからconnectionIdに紐づく `sub` を取得してCore Lambdaへ渡します。

### `lib/request-queue-publisher.js`

ユーザー入力をCore Lambda用Request Queueへ送信します。

送信する主な情報:

- `requestId`
- `connectionId`
- `sub`
- `source: "websocket"`
- `text`
- `images`

FIFO Queueを想定し、`MessageGroupId` にはconnectionIdを使います。同じ接続から送られたメッセージを順番にCore Lambdaへ渡すためです。

### `lib/response-queue-handler.js`

Core LambdaがResponse Queueへ送ったstreamイベントを処理します。

主な役割:

- SQSレコードのbodyをJSON parseする
- Coreのstreamイベントをクライアント向けメッセージへ変換する
- `websocket-postback.js` でWebSocketへ送信する
- `GoneException` の場合はDynamoDBの接続情報を削除し、SQS再試行はしない
- 一時的な失敗だけ `batchItemFailures` に入れて再試行対象にする

### `lib/websocket-postback.js`

API Gateway Management APIを使って、指定connectionIdへJSONを送ります。

Response Queue経由のLambdaイベントにはAPI Gatewayのdomain/stageが無いため、`WEBSOCKET_API_ENDPOINT` 環境変数が必要です。

### `lib/client-message.js`

Core Lambda内部のstreamイベントを、クライアントへ送りやすいJSONへ変換します。

対応イベント:

- `stream.start`
- `stream.delta`
- `stream.audio`
- `stream.bubble_break`
- `stream.tool`
- `stream.completed`
- `stream.error`

`stream.audio` はTTS連携時にCore Lambdaから送信される音声イベントです。
Edge側では受信した音声パーツをクライアント向けの `audio_chunk` に変換します。

変換後にWebSocketへ送るクライアント向けイベント:

| Core / Response Queue内部イベント | クライアント向けWebSocketイベント | 説明 |
|---|---|---|
| `stream.start` | `metadata` | 応答開始と感情メタ情報を伝える |
| `stream.delta` | `text_chunk` | 画面へ追記する本文断片を伝える |
| `stream.audio` | `audio_chunk` | 対応するWAV音声のBase64。分割時はpart情報を含む |
| `stream.bubble_break` | `bubble_break` | 表示上の吹き出し区切りを伝える |
| `stream.tool` | `tool_call` | ツール実行中のローディング表示に使う情報を伝える |
| `stream.completed` | `chat_end` | 最終本文と最終感情を伝える |
| `stream.error` | `error` | エラー内容と再試行可否を伝える |

`stream.audio`は`audio_chunk`へ変換されます。クライアントは`chunk_id`ごとに
`part_index`順でBase64を連結してWAVを再構成してください。

`audio_chunk` はCore/TTS側がResponse Queueへ送る `stream.audio` を変換して送ります。
Edge LambdaではBase64音声の分割・結合は行わず、届いたパーツをそのまま中継します。

`tool_call` は、Core LambdaがResponse Queueへ送った `stream.tool` を変換して送ります。
実際のTool Lambda呼び出し自体はCore Lambda側の責務で、Edge Lambdaは表示用イベントを中継するだけです。

Core Lambdaの `stream.tool` は `tool`、`description`、`estimatedSeconds`（camelCase）を
送ります。Edge Lambdaはクライアント向けに `estimated_seconds`（snake_case）へ変換します。
Coreから `isFiller` または `is_filler` が届いた場合も、現在のクライアント仕様では
Edgeはそのフィールドをクライアント向けJSONへ含めません。
待機中の表示は `tool_call`、吹き出しの区切りは `bubble_break` で表現します。
CoreがchunkIdを送らない場合、EdgeがrequestIdとsequenceからchunk_idを補います。

`session_start` と `proactive_message` はクライアント統合仕様上のイベントですが、
現時点のEdge Lambdaではまだ生成しません。
上流イベント設計が決まった段階で追加する想定です。

`RAiM-CoreResponse-dev.fifo` は、LambdaのSQSトリガーとしてEdge Lambdaへ紐づけます。
Edge Lambdaの環境変数にResponse Queue URLを設定する必要はありません。

### `lib/websocket-response.js`

API Gateway WebSocket route呼び出しに返すHTTP形式レスポンスを作ります。

主に `$connect` / `$disconnect` / `$default` の受付結果を返すために使います。

## `test` 配下のテストファイル

### `test/index.test.js`

Lambda入口がAPI Gateway WebSocketイベントとSQSイベントを正しく判定し、
それぞれのHandlerへ振り分けられることを確認します。

### `test/websocket-event.test.js`

WebSocketイベントの正規化を確認します。

### `test/websocket-handler.test.js`

`$connect` / `$disconnect` / `$default` の処理を確認します。

### `test/response-queue-handler.test.js`

Core Response QueueからWebSocket postまでの処理を確認します。

### `test/client-message.test.js`

Coreのstreamイベントをクライアント向けJSONへ変換できることを確認します。

### `test/websocket-postback.test.js`

WebSocketへ送るJSONがサイズ上限を超えた場合に、
非再試行エラーとして止められることを確認します。

## Core Lambdaとの接続点

Edge LambdaがCore Lambdaへ渡すRequest Queueメッセージは、Core Lambdaの `core-event.js` が受け取れる形式です。

```json
{
  "schemaVersion": 1,
  "type": "chat.request",
  "requestId": "req-001",
  "connectionId": "connection-id",
  "sub": "cognito-user-sub",
  "source": "websocket",
  "text": "こんにちは",
  "images": [],
  "createdAt": "2026-06-25T00:00:00.000Z"
}
```

Core LambdaからEdge Lambdaへ戻るResponse Queueメッセージは、`stream.*` イベントとして処理されます。
