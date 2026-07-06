# RAiM Core Lambda ファイル説明

このドキュメントは、`raim_core_lambda` 配下の各ファイルが何を担当しているかを整理したものです。

Core Lambdaは、Edge Lambdaから渡されたユーザー入力を受け取り、DynamoDBの会話状態とFewShot Scene情報を参照しながら、Titan Text Embeddings V2でSceneを選択し、Bedrock Mantleへ会話生成を依頼します。SQS経由で呼ばれる場合は、生成中のテキストをResponse Queueへストリーミング通知します。

## ファイル群の全体図

```text
raim_core_lambda/
├── .gitignore                       ← node_modules・環境変数ファイル・zipなどをGit管理から除外する
├── index.js                         ← Lambdaの入口。通常呼び出し/SQS呼び出しを振り分ける
├── package.json                     ← Node.js依存パッケージとnpm testコマンドの定義
├── package-lock.json                ← 依存パッケージのバージョン固定
├── DEPLOYMENT.md                    ← Lambda環境変数・IAM権限・アップロード手順のメモ
├── FILES.md                         ← このファイル。Core Lambda各ファイルの説明
├── LAMBDA_CONSOLE_TEST_EVENTS.md    ← Lambdaコンソール用テストイベントをまとめた補足資料
├── lambda-console-tests/            ← Lambdaコンソールへ貼り付ける実AWSテストイベント
│   ├── README.md                     ← 実行順・事前条件・期待結果・エラーの見方
│   ├── 01-full-integration-initial.json  ← Titan/Mantleを含む初回会話テスト
│   ├── 02-full-integration-followup.json ← previous_response_idを使う継続会話テスト
│   ├── 03-invalid-empty-message.json     ← 空メッセージを拒否する入力検証テスト
│   └── 04-invalid-schema-version.json    ← 未対応schemaVersionの入力検証テスト
├── lib/                             ← Core Lambdaの実装コード本体
│   ├── core-chat-service.js          ← 会話処理の中心。Session/Scene/Mantle/Titanをつなぐ
│   ├── core-event.js                 ← Edge Lambda/SQSから来た入力イベントを正規化する
│   ├── core-response.js              ← Edge Lambdaへ返す正常/エラーレスポンスを作る
│   ├── mantle-client.js              ← Bedrock Mantle Responses APIをストリーミング呼び出しする
│   ├── mantle-secret-provider.js     ← Mantle API KeyをSecrets Managerから取得する
│   ├── mantle-session-policy.js      ← previous_response_idを使えるか判定する
│   ├── prompt-builder.js             ← Mantleへ渡すsystem/user/few-shotメッセージを作る
│   ├── request-state-store.js        ← SQSリクエストの冪等性・処理状態をDynamoDBで管理する
│   ├── response-queue-publisher.js   ← 生成中/完了/エラーイベントをResponse Queueへ送る
│   ├── response-validator.js         ← MantleのJSON出力を検証し、emotion/intensityを補正する
│   ├── scene-repository.js           ← FewShotテーブルからScene定義を取得・正規化する
│   ├── scene-selector.js             ← ユーザー入力EmbeddingとtextCentroidを比較してSceneを選ぶ
│   ├── sqs-core-handler.js           ← SQS batch処理と部分失敗レスポンスを担当する
│   ├── streaming-chat-json-extractor.js ← Mantleのstreaming JSONからtext差分だけを抽出する
│   ├── titan-embedding-client.js     ← Titan Text Embeddings V2をBedrock Runtimeで呼び出す
│   ├── types.js                      ← chat/error型・emotion・入力検証を定義する
│   ├── user-session-store.js         ← UserSessionテーブルの読み書きを担当する
│   └── prompts/
│       └── raim-system-prompt.js     ← RAiMの人格・出力JSON形式・emotion方針を定義する
└── test/                             ← Node.js標準テストランナー用の単体テスト
    ├── core-chat-service.test.js     ← 会話処理全体に近い流れのテスト
    ├── core-event.test.js            ← 入力イベント正規化のテスト
    ├── core-response.test.js         ← レスポンス生成のテスト
    ├── index.test.js                 ← Lambda入口の振り分けテスト
    ├── mantle-client.test.js         ← Mantle API呼び出し・stream処理のテスト
    ├── mantle-secret-provider.test.js ← Secrets ManagerからAPI Keyを読む処理のテスト
    ├── prompt-builder.test.js        ← Scene/few-shotをMantle入力へ変換するテスト
    ├── request-state-store.test.js   ← SQS冪等性管理のテスト
    ├── response-queue-publisher.test.js ← Response Queue送信のテスト
    ├── scene-repository.test.js      ← FewShot Scene正規化のテスト
    ├── scene-selector.test.js        ← Titan Embedding後のScene選択ロジックのテスト
    ├── sqs-core-handler.test.js      ← SQS batch処理のテスト
    ├── streaming-chat-json-extractor.test.js ← streaming JSONからtextを抽出するテスト
    └── titan-embedding-client.test.js ← Titan Embedding呼び出しのテスト
```

まず全体を把握するなら、`index.js` → `lib/core-chat-service.js` → `lib/prompt-builder.js` / `lib/scene-selector.js` / `lib/mantle-client.js` の順に読むと流れを追いやすいです。

## 全体の処理フロー(エラー処理を除く)

```text
【Core Lambda 本番SQS経路：正常系の本筋処理フロー】

────────────────────────────────────────
フェーズ1: SQSイベントの受付と処理開始
────────────────────────────────────────

[1] index.js
     → SQSイベントであることを判定する

[2] index.js
     → sqs-core-handler.js にSQS batch処理を渡す

[3] sqs-core-handler.js
    → 現在はBatchSize=1のため、受信した1件のSQS recordを処理対象にする

  [3.1] sqs-core-handler.js
       → core-event.js にSQS recordの正規化を依頼する

  [3.2] core-event.js
       → schemaVersion、type、sub、requestId、connectionIdなどを検証する

  [3.3] core-event.js
       → sqs-core-handler.js にCore標準入力を返す

  [3.4] sqs-core-handler.js
       → request-state-store.js にrequestIdの処理権取得を依頼する

  [3.5] request-state-store.js
       → sqs-core-handler.js に処理権取得成功を返す

  [3.6] sqs-core-handler.js
       → response-queue-publisher.js を作成する

  [3.7] sqs-core-handler.js
       → streaming-chat-json-extractor.js を作成する

  [3.8] streaming-chat-json-extractor.js
       → 抽出したtextをresponse-queue-publisher.jsへ渡すよう設定する

  [3.9] sqs-core-handler.js
       → response-queue-publisher.js にstream.start送信を依頼する

  [3.10] response-queue-publisher.js
       → SQS Response Queueへstream.startを送る

  [3.11] sqs-core-handler.js
       → core-chat-service.js に会話生成を依頼する


  ────────────────────────────────────────
  フェーズ2: セッション取得とScene選択
  ────────────────────────────────────────

  [3.12] core-chat-service.js
       → core-event.js に入力検証・正規化を依頼する

  [3.13] core-event.js
       → core-chat-service.js にCore標準入力を返す

  [3.14] core-chat-service.js
       → user-session-store.js にUserSession取得を依頼する

  [3.15] user-session-store.js
       → core-chat-service.js にUserSessionを返す

  [3.16] core-chat-service.js
       → mantle-session-policy.js にprevious_response_id利用可否判定を依頼する

  [3.17] mantle-session-policy.js
       → core-chat-service.js にprevious_response_idを使うかどうかを返す

  [3.18] core-chat-service.js
       → scene-repository.js にScene一覧取得を依頼する

  [3.19] scene-repository.js
       → DynamoDBのFewShotテーブルからScene一覧を取得する

  [3.20] scene-repository.js
       → core-chat-service.js に正規化済みScene一覧を返す

  [3.21] core-chat-service.js
       → scene-selector.js にScene選択を依頼する

  [3.22] scene-selector.js
       → titan-embedding-client.js にユーザー発話Embedding生成を依頼する

  [3.23] titan-embedding-client.js
       → Bedrock RuntimeのTitan Text Embeddings V2を呼び出す

  [3.24] titan-embedding-client.js
       → scene-selector.js にEmbeddingを返す

  [3.25] scene-selector.js
       → ユーザー発話Embeddingと各SceneのtextCentroidを比較する

  [3.26] scene-selector.js
       → 最も適切なSceneをcore-chat-service.jsへ返す


  ────────────────────────────────────────
  フェーズ3: プロンプト作成とMantle呼び出し
  ────────────────────────────────────────

  [3.27] core-chat-service.js
       → prompt-builder.js にMantle input作成を依頼する

  [3.28] prompt-builder.js
       → 初回会話の場合はprompts/raim-system-prompt.jsの固定プロンプトを使用する

  [3.29] prompt-builder.js
       → 初回会話では固定プロンプト、SessionSummary、Scene、Few-shot、ユーザー入力を組み立てる

  [3.30] prompt-builder.js
       → 継続会話ではprevious_response_idを前提にSceneヒントとユーザー入力を組み立てる

  [3.31] prompt-builder.js
       → core-chat-service.js にMantle inputを返す

  [3.32] core-chat-service.js
       → mantle-client.js にMantle呼び出しを依頼する

  [3.33] mantle-client.js
       → mantle-secret-provider.js にAPI Key取得を依頼する

  [3.34] mantle-secret-provider.js
       → キャッシュまたはSecrets ManagerからAPI Keyを取得する

  [3.35] mantle-secret-provider.js
       → mantle-client.js にAPI Keyを返す

  [3.36] mantle-client.js
       → Bedrock Mantle Responses APIへstream=trueでPOSTする

  [3.37] Bedrock Mantle Responses API
       → mantle-client.js にSSE streamを返す


  ────────────────────────────────────────
  フェーズ4: Mantleストリーミング応答の中継
  ────────────────────────────────────────

  [3.38] while (MantleからSSEイベントが届く) {

    [3.38.1] mantle-client.js
         → response.output_text.deltaからraw JSON差分を取得する

    [3.38.2] mantle-client.js
         → sqs-core-handler.js から渡されたonTextDeltaを呼ぶ

    [3.38.3] onTextDelta
         → streaming-chat-json-extractor.js にraw JSON差分を渡す

    [3.38.4] streaming-chat-json-extractor.js
         → JSON内のtextフィールドから表示用テキストだけを抽出する

    [3.38.5] streaming-chat-json-extractor.js
         → response-queue-publisher.js にtext差分を渡す

    [3.38.6] response-queue-publisher.js
         → text差分を内部バッファへ追加する


    [3.38.7] if (内部バッファが一定文字数以上になった場合) {

      [3.38.7.1] response-queue-publisher.js
           → SQS Response Queueへstream.deltaを送る

      [3.38.7.2] response-queue-publisher.js
           → 送信済みの内部バッファを空にする

    } else {

      [3.38.7.3] response-queue-publisher.js
           → 次のtext差分を待つ

    }

  }


  ────────────────────────────────────────
  フェーズ5: 最終応答の検証と会話状態の保存
  ────────────────────────────────────────

  [3.39] mantle-client.js
       → SSE streamからresponseId、rawText、createdAtを組み立てる

  [3.40] mantle-client.js
       → core-chat-service.js にresponseId、rawText、createdAtを返す

  [3.41] core-chat-service.js
       → response-validator.js にrawText検証を依頼する

  [3.42] response-validator.js
       → rawTextからJSON部分を取り出してparseする

  [3.43] response-validator.js
       → types.jsを使ってchat形式へ正規化する

  [3.44] types.js
       → chat型、emotion定義、intensity補正を提供する

  [3.45] response-validator.js
       → core-chat-service.js に正規化済みchat outputを返す

  [3.46] core-chat-service.js
       → user-session-store.js に新しいresponse_id保存を依頼する

  [3.47] user-session-store.js
       → DynamoDBのUserSessionへresponse_idと作成日時を保存する

  [3.48] user-session-store.js
       → core-chat-service.js に保存完了を返す

  [3.49] core-chat-service.js
       → core-response.js にCore chatレスポンス作成を依頼する

  [3.50] core-response.js
       → ok、type、text、emotion、intensity、requestIdを持つCore responseを作る

  [3.51] core-response.js
       → core-chat-service.js にCore responseを返す

  [3.52] core-chat-service.js
       → sqs-core-handler.js にresult.ok === trueのresultを返す


  ────────────────────────────────────────
  フェーズ6: 完了イベント送信とrequest状態更新
  ────────────────────────────────────────

  [3.53] sqs-core-handler.js
       → response-queue-publisher.js にstream.completed送信を依頼する

  [3.54] response-queue-publisher.js
       → 内部バッファに残っているtextがあればstream.deltaとして先に送る

  [3.55] response-queue-publisher.js
       → SQS Response Queueへstream.completedを送る

  [3.56] sqs-core-handler.js
       → request-state-store.js にCOMPLETED記録を依頼する

  [3.57] request-state-store.js
       → request状態をCOMPLETEDへ更新してleaseを解放する

  [3.58] request-state-store.js
       → sqs-core-handler.js にCOMPLETED記録完了を返す

  [3.59] sqs-core-handler.js
       → このrecordの処理を完了する

[4] sqs-core-handler.js
     → 1件のrecord処理完了後、index.jsへbatchItemFailuresを返す

[5] index.js
     → Lambda Runtime / SQS Event Source Mappingへ結果を返す
```

## 用語集（変数名と役割）

Core LambdaのコードやJSONに登場する主な変数名を、用途ごとにまとめます。
同じ「ID」でも役割が異なるため、特に `requestId`、`messageId`、`connectionId`、`responseId` の違いに注意してください。

### リクエストとユーザーを識別する変数

| 変数名 | 説明 |
|---|---|
| `event` | Lambdaが受け取る入力全体です。本番ではSQSイベント、Lambdaコンソールの単体テストではCore標準入力などが入ります。 |
| `event.Records` | SQS Event Source MappingがLambdaへ渡したSQSレコードの配列です。現在は `BatchSize=1` のため、通常は1件だけ入ります。 |
| `record` | `event.Records` に含まれる1件分のSQSレコードです。実際のリクエストJSONは `record.body` に文字列として格納されています。 |
| `schemaVersion` | リクエストまたはレスポンスのJSON形式のバージョンです。現在は `1` を使用します。 |
| `type` | メッセージの種類です。入力では `chat.request`、出力では `stream.start`、`stream.delta`、`stream.completed`、`stream.error` などを使用します。 |
| `sub` | Cognitoがユーザーごとに発行する一意な識別子です。UserSessionの取得など、ユーザー単位の処理に使用します。 |
| `requestId` | クライアントが送信した1回の会話リクエストを識別するIDです。Request QueueからResponse Queueまで同じ値を引き継ぎます。 |
| `connectionId` | API Gateway WebSocketの接続を識別するIDです。Edge Lambdaが、どの接続へ応答を返すか判断するために使用します。 |
| `source` | リクエストの送信元を表します。例として `websocket`、`sqs`、`lambda-console` などがあります。 |
| `text` | ユーザーの入力文、または最終的なRAiMの返答本文です。どちらを指すかは、そのJSONや処理の文脈で決まります。 |
| `images` | ユーザー入力に添付された画像情報の配列です。画像がない場合は空配列 `[]` になります。 |

### SQSとストリーミングで使用する変数

| 変数名 | 説明 |
|---|---|
| `messageId` | AWS SQSが各SQSメッセージへ付与するIDです。RAiMが発行する `requestId` とは別物です。 |
| `MessageGroupId` | FIFO Queue内で順序を保証する単位です。同じ値を持つメッセージは順番に処理され、異なる値のグループは並列処理できます。 |
| `MessageDeduplicationId` | FIFO Queueが同じメッセージの重複登録を抑止するために使用するIDです。コード内では `deduplicationId` として生成します。 |
| `batchItemFailures` | 処理に失敗し、SQSから再配信してほしいレコードをLambda Runtimeへ伝える配列です。成功時は空配列になります。 |
| `itemIdentifier` | `batchItemFailures` の各要素に設定する識別子です。値には、失敗したSQSレコードの `messageId` を指定します。 |
| `attempt` | SQSメッセージが何回目の受信・処理であるかを表します。SQSの `ApproximateReceiveCount` から取得します。 |
| `sequence` | 同じ `requestId` のストリーミングイベントを並べる連番です。`stream.start` を0として、送信するたびに1増えます。 |
| `textDelta` | Mantleの返答のうち、今回の `stream.delta` で追加送信する部分文字列です。 |
| `textBuffer` | 小さすぎる文字列をSQSへ毎回送らないように、複数の `textDelta` を一時的にまとめておく内部バッファです。 |
| `publisher` | `stream.start`、`stream.delta`、`stream.completed`、`stream.error` をResponse Queueへ送る処理をまとめたオブジェクトです。 |
| `extractor` | Mantleから届く生成途中のraw JSON文字列から、クライアントへ表示する `text` の差分だけを取り出すオブジェクトです。 |

### 会話状態・Scene・Mantleで使用する変数

| 変数名 | 説明 |
|---|---|
| `session` | DynamoDBのUserSessionテーブルから取得したユーザーの会話状態です。要約や直前のMantleレスポンス情報などを保持します。 |
| `sessionSummary` | 過去の会話内容を短くまとめた文字列です。初回用プロンプトへ会話の前提として含めます。 |
| `scenes` | FewShotテーブルから取得したScene定義の一覧です。 |
| `sceneSelection` | ユーザー入力のEmbeddingと各Sceneを比較した選択結果です。選ばれた `scene` などを保持します。 |
| `textCentroid` | Sceneに属する例文をTitan Text Embeddings V2でEmbeddingし、平均化したベクトルです。Scene選択時の比較対象になります。 |
| `mantleInput` | system prompt、Scene、Few-shot、ユーザー入力などを組み立てたMantleへの入力です。 |
| `previousResponseId` | コード内部で使用する、直前のMantle Responses APIのレスポンスIDです。Mantleへ送信するときは `previous_response_id` という項目名になります。 |
| `responseId` | 今回のMantle Responses API呼び出しで新しく発行されたレスポンスIDです。次回の継続会話に備えてUserSessionへ保存します。 |
| `rawText` | Mantleが生成した未検証の文字列です。`response-validator.js` がJSONとして解析・検証する前の状態を指します。 |
| `output` | `rawText`を検証し、RAiMのchat形式またはerror形式へ正規化した結果です。 |

### 処理結果と状態管理で使用する変数

| 変数名 | 説明 |
|---|---|
| `result` | Core Lambdaの会話処理結果です。成功時は返答本文や感情、失敗時はエラー情報を保持します。 |
| `ok` | 処理が成功したかを表す真偽値です。`true` は成功、`false` は業務上のエラー応答を表します。 |
| `emotion` | RAiMの返答に付与する感情名です。Flutter／Unity側の表情や演出の選択に使用します。 |
| `intensity` | `emotion` の強さを表す数値です。コード側で許容範囲に補正されます。 |
| `code` | エラーの種類を機械的に識別する文字列です。例として `INVALID_INPUT`、`LLM_ERROR` などがあります。 |
| `retriable` | 同じ処理を再試行する価値があるエラーかを表す真偽値です。`false` の場合、そのSQSレコードは `batchItemFailures` に追加しません。 |
| `ownerId` | REQUEST_STATE_TABLE上で、現在のリクエストの処理権を持つLambda実行を識別するIDです。通常はLambdaの `awsRequestId` を使用します。 |
| `claim` | `requestId` の処理権を取得した結果です。`claimed`、`status`、`requestKey` などを保持します。 |
| `requestKey` | REQUEST_STATE_TABLE上で対象リクエストを特定し、`PROCESSING`、`COMPLETED`、`FAILED` の状態を更新するためのキーです。 |

## ルート直下のファイル

### `index.js`

Core Lambdaのエントリーポイントです。

主な役割:

- Lambdaに渡されたイベントが通常呼び出しかSQS呼び出しかを判定する
- SQSイベントの場合は `sqs-core-handler.js` に処理を委譲する
- 通常イベントの場合は `core-chat-service.js` を直接呼び出す
- 最終的にEdge Lambdaが扱いやすいレスポンス形式へ整える

このファイル自体には、MantleやTitanの細かい呼び出しロジックは置かず、ルーティング役に徹しています。

### `lambda-console-tests/`

SQSトリガーを関連付ける前でも、LambdaコンソールからCore Lambdaを直接実行できる
テストイベント一式です。正常系ではDynamoDB、Titan、Mantleまで実際に接続し、
入力不正系では外部サービスを呼び出す前に検証エラーになることを確認できます。

登録手順と各ケースの期待結果は、フォルダー内の`README.md`にまとめています。

### `LAMBDA_CONSOLE_TEST_EVENTS.md`

Lambdaコンソールから直接実行するテストイベントを、用途別にまとめた補足資料です。
個別JSONファイルを使って実行する場合は、`lambda-console-tests/README.md`を優先して参照します。

### `.gitignore`

`node_modules/`、`.env`、生成したzipなど、リポジトリへ登録しないファイルを定義します。

### `package.json`

Node.js Lambdaとして必要な依存パッケージとテストコマンドを定義しています。

主な依存:

- `@aws-sdk/client-bedrock-runtime`
  - Titan Text Embeddings V2のInvokeModelに使用
- `@aws-sdk/client-dynamodb`
  - DynamoDB低レベルクライアント
- `@aws-sdk/lib-dynamodb`
  - DynamoDB DocumentClient
- `@aws-sdk/client-sqs`
  - Response Queueへの送信に使用
- `@aws-sdk/client-secrets-manager`
  - Mantle API KeyをSecrets Managerから取得するために使用

テストは次で実行します。

```bash
npm test
```

### `package-lock.json`

依存パッケージのバージョン固定ファイルです。

`function.zip` を作成する前に `npm install` した状態を安定させるために使います。Lambdaへアップロードする場合は、`node_modules` も含めた状態で圧縮する必要があります。

### `DEPLOYMENT.md`

Core LambdaをAWS Lambdaへアップロードして動かすための設定メモです。

主に次を記載しています。

- 必須環境変数
- Secrets Manager方式でMantle API Keyを扱う方法
- DynamoDB / SQS / Bedrock / Secrets ManagerのIAM権限
- `function.zip` 作成時の注意点

CloudFormationを実デプロイに使わない場合でも、このファイルはLambda手動設定のチェックリストとして使えます。

### `FILES.md`

このファイルです。

Core Lambdaの各ファイルの役割を把握するための引き継ぎ資料です。

## `lib` 配下の実装ファイル

### `lib/core-event.js`

Core Lambdaに渡された入力イベントを、内部処理で扱いやすい形へ正規化します。

主な役割:

- Edge Lambdaから直接渡されたイベントを正規化する
- SQSメッセージ内のJSONを取り出して正規化する
- `sub`、`requestId`、`connectionId`、`text`、`images` などを統一形式へ変換する
- 必須項目が不足している場合は入力エラーとして扱う

Core Lambdaの後続処理は、このファイルが整えた共通形式を前提に動きます。

### `lib/core-chat-service.js`

Core Lambdaの中心となる会話処理サービスです。

主な役割:

- ユーザーセッションをDynamoDBから取得する
- FewShot Scene一覧を取得する
- ユーザー入力をもとにSceneを選択する
- Mantleへ渡すプロンプト入力を作る
- Mantleを呼び出して応答を受け取る
- Mantleの応答JSONを検証する
- `lastResponseId` などの会話継続情報をUserSessionへ保存する
- SQS処理時はストリーミング中の差分をコールバックで外へ流す

Core Lambdaの実処理はほぼこのファイルに集約されています。各AWSサービスへの細かいアクセスは専用ファイルへ分離しています。

### `lib/core-response.js`

Core LambdaからEdge Lambdaへ返すレスポンス形式を作ります。

主な役割:

- 正常なチャットレスポンスを作る
- エラーレスポンスを作る
- 内部用フィールドをレスポンスから除外する
- `types.js` の型生成関数を通して、`text` / `emotion` / `intensity` の形式を安定させる

Edge Lambdaやクライアント側へ余計な内部情報を漏らさないための出口です。

### `lib/mantle-client.js`

Bedrock MantleのOpenAI互換Responses APIを呼び出すクライアントです。

主な役割:

- MantleエンドポイントURLを組み立てる
- Secrets Managerから取得したAPI KeyをAuthorizationヘッダーへ設定する
- `stream: true` でMantleへリクエストする
- Gemma 4でサポートされない `temperature` はリクエストへ含めず、モデル側の既定値を使用する
- Server-Sent Events形式のストリーミングレスポンスを解析する
- テキスト差分を `onTextDelta` コールバックへ流す
- 最終的な `response_id` と出力テキストを返す
- `previous_response_id` が期限切れ・無効だった場合の情報を上位へ伝える

MantleのHTTP通信の詳細はこのファイルに閉じ込めています。

### `lib/mantle-secret-provider.js`

Mantle API KeyをAWS Secrets Managerから取得します。

主な役割:

- `MANTLE_API_KEY_SECRET_ARN` で指定されたSecretを取得する
- `MANTLE_API_KEY_SECRET_JSON_KEY` で指定されたJSONキーからAPI Keyを取り出す
- `MANTLE_SECRET_REGION` のリージョンでSecrets Managerへアクセスする
- 取得済みのSecretをLambda実行環境内でキャッシュする
- Secret取得失敗時はリトライしやすいよう、失敗キャッシュを残さない

API KeyをLambda環境変数へ平文で置かないための重要なファイルです。

### `lib/mantle-session-policy.js`

Mantleの `previous_response_id` を使ってよいかを判定します。

主な役割:

- UserSessionに保存された `lastResponseId` が存在するか確認する
- `lastResponseExpiresAt` を見て期限切れかどうかを判断する
- 期限内なら継続会話として `previous_response_id` を使う
- 期限切れなら初回相当のプロンプトへ戻す

Mantle側の会話継続状態に依存しすぎないための安全弁です。

### `lib/prompt-builder.js`

Mantleへ渡す入力メッセージを組み立てます。

主な役割:

- RAiMの固定システムプロンプトを読み込む
- セッション要約をMantleへ渡す文脈に変換する
- 選択されたScene情報をMantleへ渡す文脈に変換する
- FewShot例をMantleのuser/assistantメッセージへ変換する
- ユーザー入力テキストと画像をMantle入力形式へ変換する
- 初回会話用と継続会話用で入力構成を切り替える

現在のFewShotテーブル形式では、次の属性を利用します。

- `embedding_text`
  - Scene選択用の代表テキスト
  - Mantleには「検索用テキスト」として補助的に渡す
- `default_emotions`
  - Sceneで出やすい感情傾向
  - Mantleのemotion選択の参考情報として渡す
- `few_shots[].emotions`
  - FewShot例に含まれる複数感情Map
  - Mantleの出力例では、最も強い感情を単一の `emotion` / `intensity` に変換する

### `lib/prompts/raim-system-prompt.js`

RAiMの固定システムプロンプトを定義します。

主な役割:

- RAiMの人格・話し方・応答方針を定義する
- Mantleに必ずJSON形式で返すよう指示する
- 出力形式を `text` / `emotion` / `intensity` に固定する
- 許可するemotion一覧を示す
- FewShotやScene情報の扱い方を指示する

Core Lambda全体の会話品質に強く影響するファイルです。

### `lib/scene-repository.js`

DynamoDBのFewShotテーブルからScene定義を取得します。

主な役割:

- `RAiM-FewShot-dev` からScene一覧をScanする
- `id` 指定で特定SceneをGetItemする
- fallback用のdefault Sceneを取得する
- DynamoDB ItemをCore Lambda内部で扱いやすい形へ正規化する

現在のFewShotテーブルでは、主に次を扱います。

- `id`
- `description`
- `embedding_text`
- `default_emotions`
- `few_shots`
- `textCentroid`

旧形式の `text_examples` / `examples` も互換用に保持していますが、現在のScene選択では `embedding_text` から作った `textCentroid` を使います。

### `lib/scene-selector.js`

ユーザー入力に最も近いSceneを選択します。

主な役割:

- ユーザー入力テキストをTitan Text Embeddings V2でEmbeddingする
- 各Sceneの `textCentroid` とコサイン類似度を計算する
- 最も類似度が高いSceneを選ぶ
- 類似度が閾値未満ならdefault Sceneへfallbackする
- テキストが空、centroid未整備、次元不一致などの場合もfallbackする

`textCentroid` は、FewShotテーブルの `embedding_text` を事前にEmbeddingした値です。ユーザー入力Embeddingと `textCentroid` は同じモデル・同じ次元数で生成されている必要があります。

### `lib/titan-embedding-client.js`

Amazon Bedrock Runtime経由でTitan Text Embeddings V2を呼び出します。

主な役割:

- Titan V2用のInvokeModelリクエストBodyを作る
- `inputText`、`dimensions`、`normalize`、`embeddingTypes` を設定する
- Bedrock Runtimeの標準リージョナルエンドポイントへアクセスする
- Titanのレスポンスからfloat embeddingを取り出す
- 次元数不一致や不正レスポンスを検出する

独自Titanエンドポイントは使用しません。`BEDROCK_REGION` または `AWS_REGION` に基づいてAWS SDKが標準エンドポイントを選びます。

### `lib/response-validator.js`

Mantleから返ってきたJSON応答を検証・補正します。

主な役割:

- Mantleの出力文字列をJSONとしてparseする
- `text` が空でないか確認する
- 未定義emotionを `neutral` に補正する
- `intensity` を0.0〜1.0の範囲へ丸める
- JSONでない応答や不完全な応答をCore Lambda用エラーに変換する

Mantleの出力が多少揺れても、クライアントへ返す形式を安定させるための防波堤です。

### `lib/streaming-chat-json-extractor.js`

Mantleのストリーミング出力から、`text` フィールド部分だけを差分抽出します。

主な役割:

- MantleがJSON文字列を少しずつ返す状況に対応する
- `{"text":"..."}` の `text` 値だけを途中経過として取り出す
- JSONエスケープやUnicodeエスケープが分割されても破綻しにくく処理する
- SQS Response Queueへ送る `stream.delta` の材料を作る

クライアントに「生成中の文章だけ」を見せるための補助です。

### `lib/response-queue-publisher.js`

Core LambdaからEdge Lambda側へ、SQS Response Queue経由でストリーミングイベントを送ります。

主な役割:

- `stream.start` を送る
- Mantle生成中のテキスト差分を `stream.delta` として送る
- 最終結果を `stream.completed` として送る
- エラーを `stream.error` として送る
- FIFO Queue向けにMessageGroupIdやDeduplicationIdを設定する
- 小さすぎるdeltaをまとめて送る

WebSocketへ直接返さず、SQSを介してEdge Lambdaへ戻す構成に対応するためのファイルです。

### `lib/request-state-store.js`

SQS経由で処理するリクエストの状態をDynamoDBへ保存します。

主な役割:

- 同じ `requestId` が重複処理されないようにする
- `PROCESSING` / `COMPLETED` / `FAILED` の状態を管理する
- Lambda再実行やSQS再配信時の二重応答を抑制する
- 処理中leaseとTTLを管理する

SQSは少なくとも1回配信のため、冪等性を保つために必要です。

### `lib/sqs-core-handler.js`

SQSイベントとしてCore Lambdaが呼ばれた場合の処理を担当します。

主な役割:

- SQS batchを1件ずつ処理する
- `request-state-store.js` で処理権を取得する
- `core-chat-service.js` を呼び出す
- `response-queue-publisher.js` でstreamイベントを送る
- 失敗したSQSレコードだけを `batchItemFailures` として返す

LambdaのSQS部分的バッチ失敗レスポンスに対応しています。

### `lib/user-session-store.js`

DynamoDBのUserSessionテーブルを読み書きします。

主な役割:

- ユーザーごとの現在セッション情報を取得する
- Mantleの `lastResponseId` を保存する
- `lastResponseExpiresAt` を保存する
- `sessionSummary` を保存・取得する
- 会話継続に必要な状態をCore Lambdaから分離する

Mantleの `previous_response_id` を使うための状態管理ファイルです。

### `lib/types.js`

Core Lambda内部で使うレスポンス型・イベント型の生成補助をまとめています。

主な役割:

- `chat` レスポンスを作る
- `error` レスポンスを作る
- emotion一覧を定義する
- intensityを0.0〜1.0へ丸める
- MantleのJSON出力をCore Lambda内部型へ変換する

`filler_audio`、`tool_call`、`proactive_message`、`session_start` は将来拡張用として
コード内にコメントで残していますが、現在は生成・exportしていません。

クライアントへ返すデータ形式の基本定義に近いファイルです。

## `test` 配下のテストファイル

### `test/core-chat-service.test.js`

Core Lambdaの会話処理全体に近い単体テストです。

主な確認:

- 既存会話フローで正常応答できる
- 入力不正時に依存サービスを呼ばない
- Mantle応答検証エラーを正しく扱う
- `previous_response_id` 期限切れ時にリトライする
- Mantleストリーミング差分を順番に外へ流す

### `test/core-event.test.js`

入力イベント正規化のテストです。

主な確認:

- 直接呼び出しイベントを正規化できる
- SQSレコードを取り出せる
- 画像のみ入力を許可する
- `sub` など必須項目不足を検出する
- 複数SQSレコードを誤って1件扱いしない

### `test/core-response.test.js`

Core Lambdaのレスポンス生成テストです。

主な確認:

- Edge Lambda向けの正常レスポンスを作れる
- エラーレスポンスに `requestId` とエラー情報を含められる
- 内部用フィールドを外部レスポンスから除外できる
- エラー分類が想定どおり動く

### `test/index.test.js`

Lambdaエントリーポイントのルーティングテストです。

主な確認:

- SQSイベントが来た場合にSQS処理パスへ流れる
- 通常イベントとSQSイベントを区別できる

### `test/mantle-client.test.js`

Mantleクライアントのテストです。

主な確認:

- Mantleリクエストに `previous_response_id` を必要時だけ含める
- Gemma 4で非対応の `temperature` をリクエストへ含めない
- Bedrock Mantleのリージョナルエンドポイントを組み立てる
- OpenAI互換Responses APIのストリーミング形式を扱える
- Mantle応答から `response_id` や出力テキストを取り出せる

### `test/mantle-secret-provider.test.js`

Secrets ManagerからMantle API Keyを取得する処理のテストです。

主な確認:

- 指定したJSONキーからAPI Keyを取得できる
- 取得結果をキャッシュできる
- 失敗時は次回リトライできる
- 必須環境変数不足を検出する
- SecretBinaryも扱える

### `test/prompt-builder.test.js`

Mantleへ渡すプロンプト生成のテストです。

主な確認:

- Scene文脈に `embedding_text` と `default_emotions` が含まれる
- `few_shots[].emotions` Mapを単一 `emotion` / `intensity` の応答例へ変換できる
- 継続会話時のSceneヒントがsystem messageとして入る

### `test/request-state-store.test.js`

SQSリクエスト状態管理のテストです。

主な確認:

- 処理中leaseを作れる
- 完了済みリクエストの重複を検出できる
- 完了時にleaseを解放できる

### `test/response-queue-publisher.test.js`

Response Queueへ送るストリーミングイベントのテストです。

主な確認:

- FIFO SQSへ順序付きイベントを送れる
- 小さなdeltaをバッファリングできる
- completedイベントに最終結果を含められる

### `test/scene-repository.test.js`

FewShotテーブルのScene正規化テストです。

主な確認:

- 新形式の `embedding_text` を保持できる
- `default_emotions` を保持できる
- `few_shots[].emotions` を保持できる
- `hasEmbeddingText` のデバッグサマリを作れる

### `test/scene-selector.test.js`

Scene選択ロジックのテストです。

主な確認:

- コサイン類似度で最も近いSceneを選べる
- Titan Embedding結果を使ってScene選択できる
- `textCentroid` が未整備の場合にdefaultへfallbackできる

### `test/sqs-core-handler.test.js`

SQS経由のCore処理テストです。

主な確認:

- ストリーミング抽出結果をResponse Queueへ流せる
- 成功・失敗したSQSレコードを正しく扱える
- `batchItemFailures` を必要な分だけ返せる

### `test/streaming-chat-json-extractor.test.js`

MantleのストリーミングJSONから `text` を抽出するテストです。

主な確認:

- JSON文字列が分割されても `text` の中身だけを取り出せる
- Unicodeエスケープが途中で分割されても処理できる

### `test/titan-embedding-client.test.js`

Titan Embeddingクライアントのテストです。

主な確認:

- Titan V2用のリクエストBodyを作れる
- Bedrock Runtime InvokeModelを呼び出せる
- 返ってきたEmbeddingの次元数を検証できる
- 独自TitanエンドポイントではなくAWS SDK標準エンドポイントを使う

## `raim_test` 配下の関連補助スクリプト

以下は `raim_core_lambda` 配下ではなく、ワークスペース直下の`raim_test`にあります。
Core LambdaのScene選択準備・検証に使う補助スクリプトです。

### `raim_test/generate_scene_centroids.js`

FewShotテーブルの `embedding_text` をTitan Text Embeddings V2でEmbeddingし、同じDynamoDBアイテムの `textCentroid` に保存します。

Core LambdaのScene選択を実AWSで動かす前に、まずこのスクリプトで `textCentroid` を作成します。

### `raim_test/generate_scene_centroids.py`

Scene centroid生成処理のPython版です。現在のFewShot形式に合わせたNode.js版を利用する場合は、
`generate_scene_centroids.js`を使用します。

### `raim_test/test_scene_selection.js`

ユーザー入力をTitanでEmbeddingし、FewShotテーブルの `textCentroid` と比較して、どのSceneが選ばれるかをCloudShell上で確認するスクリプトです。

Mantleは呼ばないため、Scene選択だけを切り分けてテストできます。

## Lambdaへアップロードするときの注意

`function.zip` としてアップロードする対象は、基本的に `raim_core_lambda` の中身です。

必要なもの:

- `index.js`
- `lib/**`
- `package.json`
- `package-lock.json`
- `node_modules/**`

不要なもの:

- `test/**`
- `DEPLOYMENT.md`
- `FILES.md`

ただし、ファイルサイズに余裕があり、検証目的で含めたい場合は `test/**` やMarkdownを含めてもLambda実行自体には通常影響しません。
