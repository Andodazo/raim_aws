# Core Lambda ローカル構成整合方針

## 1. この文書の目的

Core Lambdaを担当者のローカル実装に近づける際に、現在動作しているAWS基盤を
維持しながら、入力・返答形式を含む変更範囲と保護対象を定めます。

`local_core_reference`は、人格・感情・会話処理・Tool・TTSなどの仕様を確認するための
参照資料です。ローカルWebSocketサーバーとして作られているため、ファイルをそのまま
Core Lambdaへ上書きすることは想定していません。

## 2. 基本方針

次の境界で移植対象を分けます。

- AWS接続、SQS、DynamoDB、Secrets Managerの実行基盤は維持する
- 入力・返答形式は変更可能とするが、関係コンポーネントと同時に設計・移行する
- 人格、口調、プロンプト、感情表現、会話処理はローカル構成へ近づけられる
- TTSとToolの実処理は、当初の構成どおり将来のTTS Lambda／Tool Lambdaへ分離する
- ローカル実装のコードを直接上書きせず、現行Core LambdaのAWS実行基盤に適合する形で移植する
- 既存テストを削除せず、仕様変更に応じて更新・追加する

## 3. 置換・削除してはいけないファイル

以下は、現在動作しているAWS連携や非同期処理の基盤です。
内部の不具合修正や入出力形式への対応は可能ですが、ローカル版での置換・削除は
行わないでください。

### 3.1 Lambda・SQS基盤

| ファイル | 保護する役割 |
|---|---|
| `raim_core_lambda/index.js` | Lambdaの`index.handler`と通常／SQSイベントの振り分け |
| `raim_core_lambda/lib/core-event.js` | Edge Lambdaから受け取る入力形式の正規化とバージョン判定 |
| `raim_core_lambda/lib/sqs-core-handler.js` | Request Queue処理、FIFO順序、部分的バッチ失敗 |
| `raim_core_lambda/lib/request-state-store.js` | SQS重複配信対策、lease、TTL、処理状態管理 |
| `raim_core_lambda/lib/response-queue-publisher.js` | Response Queueへの順序・重複排除付きイベント送信 |

入力・返答のJSON項目やイベント種別は変更対象になり得ます。形式変更の方針は
「5. 入力・返答形式の変更方針」へまとめます。一方、FIFO Queueの順序制御、
重複排除、SQSの`batchItemFailures`処理は維持します。

### 3.2 AWSサービス接続

| ファイル | 保護する役割 |
|---|---|
| `raim_core_lambda/lib/mantle-client.js` | Mantle Responses API、API Key認証、SSE、`previous_response_id` |
| `raim_core_lambda/lib/mantle-secret-provider.js` | Secrets ManagerからのAPI Key取得とキャッシュ |
| `raim_core_lambda/lib/mantle-session-policy.js` | Mantle response IDの期限・失効判定 |
| `raim_core_lambda/lib/titan-embedding-client.js` | Titan Text Embeddings V2の実呼び出し |
| `raim_core_lambda/lib/scene-repository.js` | DynamoDB FewShotテーブルの読み取りと正規化 |
| `raim_core_lambda/lib/user-session-store.js` | DynamoDB UserSessionの読み書きと会話継続状態 |

特に、次の実装を維持します。

- Mantle API Keyを環境変数へ平文保存せず、Secrets Managerから取得する
- Gemma 4へ非対応の`temperature`を送信しない
- Titan独自エンドポイントを使わず、Bedrock Runtimeの`InvokeModel`を使用する
- SceneとFew-shotはローカルJSONではなくDynamoDBから取得する
- 会話状態をプロセス内MapではなくDynamoDBへ保存する
- Mantleの`previous_response_id`が失効した場合に状態をクリアして復旧する

## 4. ローカル構成へ近づけるために変更できるファイル

### 4.1 自由度が高いファイル

| ファイル | 移植を検討できる内容 |
|---|---|
| `raim_core_lambda/lib/prompts/raim-system-prompt.js` | 人格、口調、禁止表現、時刻への反応 |
| `raim_core_lambda/lib/prompt-builder.js` | Few-shot、画像、時刻、Tool用のプロンプト構築 |

#### `lib/prompts`フォルダーの役割

`raim_core_lambda/lib/prompts`は、RAiMの人格や会話方針を、AWS接続や入力処理などの
実装ロジックから分離するためのフォルダーです。

現在は次のファイルを配置しています。

```text
lib/prompts/
└── raim-system-prompt.js
```

`raim-system-prompt.js`では、主に次を管理します。

- RAiMの人格と口調
- 返答の長さと会話方針
- Scene／Few-shotの扱い方
- 画像入力への対応方針
- 許可する感情
- Mantleへ要求するJSON出力形式
- プロンプトのバージョン

一方、`prompt-builder.js`は固定プロンプトそのものを管理するのではなく、
`raim-system-prompt.js`を読み込み、次の動的な情報と組み合わせる役割を持ちます。

- DynamoDBから取得したSceneとFew-shot
- UserSessionの`sessionSummary`
- 今回のユーザー入力
- 添付画像
- Mantleの`previous_response_id`を利用するかどうか

この分離により、人格や口調の調整だけであれば、Mantle通信、SQS、DynamoDBなどの
基盤処理を変更せずに対応できます。また、長いプロンプトによって
`prompt-builder.js`の処理が読みづらくなることを防ぎます。

ローカル構成から移植する次の内容は、原則として`lib/prompts`配下へ配置します。

- 詳細なRAiMの口調
- AI的な自己紹介やアシスタント口調の禁止
- 時間帯に応じた応答方針
- 複数感情の選択ルール
- 画像応答の方針
- Tool利用時の判断・応答ルール

将来、プロンプトが用途別に大きくなった場合は、次のように分割できます。

```text
lib/prompts/
├── raim-system-prompt.js
├── tool-use-prompt.js
├── image-response-prompt.js
└── summary-prompt.js
```

ただし、プロンプトを分割しても、Mantleへ渡す最終的なメッセージ構造の組み立ては
`prompt-builder.js`へ集約します。

ローカル構成から移植を検討できる主な内容は次のとおりです。

- 「友達感」のあるRAiMの口調
- AI的な自己紹介やアシスタント口調の禁止
- 現在日時と時間帯のコンテキスト
- 複数画像に対する応答方針
- `image_description`を履歴へ活用する考え方
- Tool利用前後の会話表現

### 4.2 関係箇所と整合させながら変更できるファイル

| ファイル | 変更時の条件 |
|---|---|
| `raim_core_lambda/lib/core-chat-service.js` | 呼び出し元、戻り値、ストリーミング処理を同時に更新する |
| `raim_core_lambda/lib/core-event.js` | Edge Lambdaの送信形式とschemaVersionを同時に更新する |
| `raim_core_lambda/lib/core-response.js` | Response Queue、Edge、クライアントの返答形式を同時に更新する |
| `raim_core_lambda/lib/response-queue-publisher.js` | Edge LambdaのResponse Queue処理と同時に更新する |
| `raim_core_lambda/lib/streaming-chat-json-extractor.js` | Mantle出力と新しいストリーミング形式に合わせて変更・置換できる |
| `raim_core_lambda/lib/types.js` | Edge、Flutter、Unityの型定義を同時に更新する |
| `raim_core_lambda/lib/response-validator.js` | `types.js`とMantle出力形式を一致させる |

現時点の`core-chat-service.js`は次のインターフェースを持ちますが、これらも新しい設計に
合わせて変更できます。変更する場合は、`sqs-core-handler.js`、`index.js`、テストを
同じ変更単位で更新します。

- `handleCoreChat(event, options)`として呼び出せる
- `fallbackRequestId`を受け取れる
- `onMantleStreamEvent`を受け取れる
- `onMantleTextDelta`を受け取れる
- 成功時に`ok: true`のCoreレスポンスを返す
- 失敗時に分類可能なエラーを返す

## 5. 入力・返答形式の変更方針

入力・返答形式は、ローカル構成との整合やクライアント仕様の確定に伴って変更される
可能性があります。そのため、現在のJSON形式を変更禁止事項にはしません。
ただし、Core Lambdaだけを先行変更すると通信できなくなるため、形式の定義、影響範囲、
移行方法をこの節へ集約します。

### 5.1 現在の入力形式

FlutterからEdge Lambdaへ送る現在の主な項目は次のとおりです。

```json
{
  "requestId": "req-001",
  "text": "こんにちは",
  "images": []
}
```

Edge LambdaはCognitoの`sub`とWebSocketの`connectionId`を補い、Request Queueへ
次の形式で送ります。

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
  "createdAt": "ISO-8601"
}
```

入力形式を変更する場合は、次をまとめて更新します。

- Flutterの送信処理
- Edge Lambdaの`websocket-event.js`
- Edge Lambdaの`request-queue-publisher.js`
- Core Lambdaの`core-event.js`
- 入力検証を行う`types.js`
- 関連する単体テストとLambdaコンソール用テストイベント

認証済みユーザーと接続先を特定するため、`sub`と`connectionId`に相当する情報は
新形式でも失わないようにします。項目名や配置は変更可能です。

### 5.2 現在の返答・ストリーミング形式

現在はResponse Queueへ次のイベントを送ります。

- `stream.start`
- `stream.delta`
- `stream.completed`
- `stream.error`

Core LambdaからResponse Queueへ送る現在のJSON例は次のとおりです。

生成開始時:

```json
{
  "schemaVersion": 1,
  "type": "stream.start",
  "requestId": "req-001",
  "connectionId": "connection-id",
  "sub": "cognito-user-sub",
  "source": "websocket",
  "sequence": 0,
  "attempt": 1,
  "createdAt": "ISO-8601"
}
```

生成途中のテキスト差分:

```json
{
  "schemaVersion": 1,
  "type": "stream.delta",
  "requestId": "req-001",
  "connectionId": "connection-id",
  "sub": "cognito-user-sub",
  "source": "websocket",
  "sequence": 1,
  "attempt": 1,
  "createdAt": "ISO-8601",
  "textDelta": "こんにちは！"
}
```

生成完了時:

```json
{
  "schemaVersion": 1,
  "type": "stream.completed",
  "requestId": "req-001",
  "connectionId": "connection-id",
  "sub": "cognito-user-sub",
  "source": "websocket",
  "sequence": 2,
  "attempt": 1,
  "createdAt": "ISO-8601",
  "text": "こんにちは！今日はどうしたの？",
  "emotion": "happy",
  "intensity": 0.6
}
```

処理失敗時:

```json
{
  "schemaVersion": 1,
  "type": "stream.error",
  "requestId": "req-001",
  "connectionId": "connection-id",
  "sub": "cognito-user-sub",
  "source": "websocket",
  "sequence": 2,
  "attempt": 1,
  "createdAt": "ISO-8601",
  "code": "LLM_ERROR",
  "message": "Core Lambda processing failed",
  "retriable": true
}
```

Edge LambdaはResponse Queueイベントから内部配送用の`connectionId`、`sub`、`source`、
`attempt`、`createdAt`などを取り除き、Flutterへ必要な項目をWebSocketで送ります。
例えば生成完了時のクライアント向けJSONは次の形式です。

```json
{
  "type": "stream.completed",
  "requestId": "req-001",
  "sequence": 2,
  "text": "こんにちは！今日はどうしたの？",
  "emotion": "happy",
  "intensity": 0.6
}
```

`stream.delta`の場合は`textDelta`、`stream.error`の場合は`code`、`message`、
`retriable`をクライアントへ送ります。

各イベントには、追跡・順序制御に使う`requestId`、`connectionId`、`sequence`などを
含めています。イベント名やpayloadは変更可能ですが、非同期処理で次を判定できる情報は
新形式でも保持します。

- どのリクエストに対する返答か
- どのWebSocket接続へ送るか
- どの順番で処理するか
- 正常終了かエラーか
- SQS再配信による重複か

ローカル構成の`metadata`、`text_chunk`、`audio_chunk`、`tool_call`、`chat_end`へ
近づけることも可能です。ただし、現行のMantle SSE、Response Queue、Edge Lambdaを
経由できる形式へ設計し直します。

返答形式を変更する場合は、次をまとめて更新します。

- Core Lambdaの`types.js`と`core-response.js`
- Core Lambdaの`response-validator.js`
- Core Lambdaの`response-queue-publisher.js`
- 必要に応じて`streaming-chat-json-extractor.js`
- Edge Lambdaの`response-queue-handler.js`と`client-message.js`
- Flutterの受信・重複排除・画面更新処理
- Unityの表情制御
- TTS Lambda／Tool Lambdaとのイベント形式

### 5.3 感情形式

ローカル構成では、従来の8感情へ`curious`、`amused`、`thoughtful`、`playful`を
加えた12感情を使用します。また、単一の`emotion`／`intensity`ではなく、
`emotions` Mapと`overall_intensity`を使用します。

この形式への変更も可能です。移行期間中は、次のように新旧形式を併記し、古い
Flutter／Unity実装でも動作できる後方互換期間を設けることを推奨します。

```json
{
  "emotion": "happy",
  "intensity": 0.6,
  "emotions": {
    "happy": 0.7,
    "caring": 0.3
  },
  "overall_intensity": 0.8
}
```

### 5.4 形式変更の進め方

入力・返答形式を変更する際は、次の順で進めます。

1. 新しいJSON例と必須・任意項目を文書で定義する
2. `schemaVersion`を更新するか、旧形式との判別方法を決める
3. Core、Edge、Flutter、Unityの影響ファイルを一覧化する
4. 先に新旧両形式を読み取れる受信側を実装する
5. 送信側を新形式へ切り替える
6. 後方互換期間後に旧形式を削除する
7. 直接実行、SQS、CloudFront経由の全経路をテストする

## 6. ToolとTTS

ローカル構成の次の処理は、そのままCore Lambdaへ統合しません。

- Tavily Web検索
- OpenWeatherMap天気取得
- VOICEVOX音声合成
- Base64 WAVのWebSocket送信

Core Lambdaには、将来のTool Lambda／TTS Lambdaを呼び出すための判断・イベント生成だけを
追加し、外部API呼び出しや音声合成本体は別Lambdaへ配置します。

## 7. 禁止する直接置換

以下の直接置換は行わないでください。

| ローカル側 | 置換してはいけない現行ファイル | 理由 |
|---|---|---|
| `local_core_reference/server.js` | `raim_core_lambda/index.js` | 常駐WebSocketサーバーとLambda Handlerは実行方式が異なる |
| `local_core_reference/lib/llm.js` | `raim_core_lambda/lib/mantle-client.js` | ローカル版のAWS LLM処理は未実装 |
| `local_core_reference/lib/embed.js` | `raim_core_lambda/lib/titan-embedding-client.js` | ローカル版のAWS Embedding処理は未実装 |
| `local_core_reference/lib/memory-store.js` | `raim_core_lambda/lib/user-session-store.js` | ローカルMapは再起動で履歴が消える |
| `local_core_reference/lib/pick-scene.js` | `raim_core_lambda/lib/scene-selector.js` | Scene保存場所、Embeddingモデル、閾値が異なる |

## 8. ローカル参照構成の注意点

ローカル構成には、移植前に解消すべき不整合があります。

- `scripts/build-embeddings.js`は存在しない`scene.examples`を参照している
- `pick-scene.js`が必要とする`scenes-embedded.json`はclone直後には存在しない
- Sceneの`default_emotions`と`server.js`が参照する`defaultEmotions`が一致していない
- コメントではLLMストリーミングを使用するとされているが、主経路は非ストリーミングである
- LLM、Embedding、Memory、Function CallingのAWSモードは未実装である
- 自動テストが用意されていない

そのため、ローカル構成のコメントを仕様の正本として扱わず、実コードと現行AWS構成を
照合したうえで必要な機能だけを移植します。

## 9. 変更時の確認手順

1. 変更対象が保護ファイルか確認する
2. Edge Lambda、SQS、DynamoDB、Flutter、Unityへの影響を確認する
3. 既存のCore Lambda単体テストを実行する
4. 新仕様の単体テストを追加する
5. Lambdaコンソールの直接イベントでTitan／Mantleを確認する
6. CloudFrontからのエンドツーエンドテストを実行する
7. 採用した返答形式で、開始から完了までの識別子・順序・重複排除を確認する

テストコマンド:

```powershell
cd .\raim_core_lambda
npm.cmd test
```

## 10. 完了条件

ローカル構成への整合後も、次をすべて満たすことを完了条件とします。

- Cognito認証済みクライアントからCloudFront経由で接続できる
- Edge LambdaからRequest Queueへ入力が送られる
- Core LambdaがTitanでSceneを選択できる
- Secrets ManagerのAPI KeyでMantleを呼び出せる
- Response Queueへ順序付きストリーミングイベントを送れる
- Edge LambdaからWebSocketクライアントへ回答が返る
- SQS再配信時に同一リクエストを二重処理しない
- 既存テストと追加テストがすべて成功する

## 11. `local_core_reference` と Core Lambda のファイル対応

`local_core_reference`は、ローカルPC上で動く常駐WebSocketサーバーとして、会話処理、Ollama、VOICEVOX、Toolなどを確認するための参照実装です。

Core Lambdaはこのコードをそのまま移植したものではありません。AWS上でSQS、DynamoDB、Titan Text Embeddings V2、Bedrock Mantleを利用できるように、local側の役割を複数ファイルへ分割・置換しています。

### 11.1 local側から見た対応表

| local側のファイル | 対応するCore側のファイル | 対応内容・実装状況 |
|---|---|---|
| `local_core_reference/server.js` | `raim_core_lambda/index.js`、`raim_core_lambda/lib/sqs-core-handler.js`、`raim_core_lambda/lib/core-chat-service.js` | localではWebSocket受付から応答返却までを1ファイルで統括する。CoreではLambda入口、SQS処理、会話生成へ分割している |
| `local_core_reference/lib/types.js` | `raim_core_lambda/lib/types.js`、`raim_core_lambda/lib/core-event.js`、`raim_core_lambda/lib/core-response.js`、`raim_core_lambda/lib/response-validator.js` | localでは通信型、入力検証、LLM出力補正をまとめている。Coreでは入力、出力、Mantle応答検証へ分割している |
| `local_core_reference/lib/llm.js` | `raim_core_lambda/lib/mantle-client.js` | localのOllama呼び出しを、Bedrock Mantle Responses API呼び出しへ置き換えている |
| `local_core_reference/lib/llm.js` のAPIキー・会話継続部分 | `raim_core_lambda/lib/mantle-secret-provider.js`、`raim_core_lambda/lib/mantle-session-policy.js` | APIキーはSecrets Managerから取得し、`previous_response_id`の期限・失効を管理する。localに同等のAWS処理はない |
| `local_core_reference/lib/embed.js` | `raim_core_lambda/lib/titan-embedding-client.js` | localのOllama `bge-m3`を、Titan Text Embeddings V2へ置き換えている |
| `local_core_reference/lib/memory-store.js` | `raim_core_lambda/lib/user-session-store.js` | localはプロセス内Mapへ会話イベントを保存する。CoreはDynamoDBへ`sessionSummary`やMantle response IDを保存する |
| `local_core_reference/lib/prompt-builder.js` | `raim_core_lambda/lib/prompt-builder.js`、`raim_core_lambda/lib/prompts/raim-system-prompt.js` | localで同居していた固定人格プロンプトと動的な入力組み立てを分離している |
| `local_core_reference/lib/pick-scene.js` | `raim_core_lambda/lib/scene-selector.js`、`raim_core_lambda/lib/scene-repository.js` | localのScene JSON読込と類似度判定を、DynamoDB取得とTitan類似度判定へ分割している |
| `local_core_reference/lib/streaming-parser.js` | `raim_core_lambda/lib/streaming-chat-json-extractor.js` | どちらも生成JSONから`text`部分だけを抽出する。local版は現在の主経路では未使用だが、Core版はMantle SSE処理で使用している |
| `local_core_reference/scenes/*.json` | `raim_core_lambda/lib/scene-repository.js`とDynamoDB FewShotテーブル | Coreは静的JSONではなく、DynamoDBのScene/Few-shotを読み込む |
| `local_core_reference/scripts/build-embeddings.js` | Core Lambda内に直接対応する実行時ファイルはない | AWS側の事前準備に相当する処理は、`raim_test/generate_scene_centroids.js`でDynamoDBの`textCentroid`を生成する |

### 11.2 Core側にのみ存在するAWS基盤処理

次のファイルにはlocal側の直接対応ファイルがありません。常駐WebSocketサーバーでは不要だった、SQSやDynamoDB向けの処理です。

| Core側のファイル | Coreで追加された役割 |
|---|---|
| `raim_core_lambda/lib/request-state-store.js` | SQS再配信によるMantleの二重実行、二重通知、二重課金を防ぐ |
| `raim_core_lambda/lib/response-queue-publisher.js` | `stream.start`、`stream.delta`、`stream.completed`、`stream.error`をResponse Queueへ順番付きで送る |
| `raim_core_lambda/lib/sqs-core-handler.js` | Request Queueのレコード処理、部分失敗、重複排除を統括する |
| `raim_core_lambda/lib/core-event.js` | Edge Lambda、SQS、Lambdaコンソールの入力形式をCore標準形式へ揃える |
| `raim_core_lambda/lib/core-response.js` | Edge Lambdaへ返す成功・失敗レスポンスを統一する |
| `raim_core_lambda/lib/mantle-secret-provider.js` | Mantle API KeyをSecrets Managerから取得・キャッシュする |
| `raim_core_lambda/lib/mantle-session-policy.js` | Mantleの`previous_response_id`を再利用できるか判定する |

### 11.3 未実装・部分実装の機能

#### TTS

local側では、`local_core_reference/lib/tts.js`、`local_core_reference/lib/voice-mapper.js`、`local_core_reference/voice-config.json`でVOICEVOX連携が実装されています。

Core Lambda側には対応するTTS実装がありません。設計上は専用のTTS LambdaまたはTTSサービスへ分離する予定です。`audio_chunk`の生成とResponse Queueへの送信も未実装です。

#### Tool

local側では、`local_core_reference/lib/tools/index.js`、`local_core_reference/lib/tools/web-search.js`、`local_core_reference/lib/tools/get-weather.js`でTavily検索とOpenWeatherMap天気取得が実装されています。

Core Lambda側にはTool実行処理がありません。`raim_core_lambda/lib/types.js`に`tool_call`関連のコードが将来拡張用として残っていますが、現在は定数とexportが無効化されており、処理経路から呼ばれません。将来は専用のTool Lambdaへ分離する予定です。

#### その他

- `filler_audio`: Core Lambdaでは未使用
- `proactive_message`: Core Lambdaでは未実装
- `session_start`: Core Lambdaでは未使用
- Backup Lambda: 未実装
- 画像入力: Core LambdaからMantleへ画像を渡す処理は実装済み。ただしScene選択は画像Embeddingではなく、テキストEmbeddingのみを使用する
- local側のAWSモード: `llm.js`、`embed.js`、`memory-store.js`内のAWS分岐は未実装。実際のAWS処理はCore Lambda側の別ファイルとして実装している
- local側のLLMストリーミング: パーサーは存在するが、現在の主経路は`callLLMWithTools()`で全文取得後に分割送信する。Core Lambda側はMantle SSEを実際に逐次処理する

主要な対応だけを簡略化すると、次の関係になります。

```text
local server.js
  ├── Core index.js
  ├── lib/sqs-core-handler.js
  └── lib/core-chat-service.js

local lib/llm.js          → Core lib/mantle-client.js
local lib/embed.js        → Core lib/titan-embedding-client.js
local lib/memory-store.js → Core lib/user-session-store.js
local lib/pick-scene.js   → Core lib/scene-repository.js + lib/scene-selector.js
local TTS / Tool          → Core未実装（将来、別Lambdaへ分離予定）
```
