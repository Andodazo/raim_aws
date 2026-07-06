# Core Lambda ローカル構成整合方針

## 1. この文書の目的

Core Lambdaを担当者のローカル実装に近づける際に、現在動作しているAWS基盤や
Edge Lambdaとの通信契約を壊さないため、変更範囲と保護対象を定めます。

`local_core_reference`は、人格・感情・会話処理・Tool・TTSなどの仕様を確認するための
参照資料です。ローカルWebSocketサーバーとして作られているため、ファイルをそのまま
Core Lambdaへ上書きすることは想定していません。

## 2. 基本方針

次の境界で移植対象を分けます。

- AWS接続、SQS、DynamoDB、Secrets Manager、Edge Lambdaとの通信契約は維持する
- 人格、口調、プロンプト、感情表現、会話処理はローカル構成へ近づけられる
- TTSとToolの実処理は、当初の構成どおり将来のTTS Lambda／Tool Lambdaへ分離する
- ローカル実装のコードを直接上書きせず、現行Core Lambdaのインターフェースへ移植する
- 既存テストを削除せず、仕様変更に応じて更新・追加する

## 3. 置換・削除してはいけないファイル

以下は、現在動作しているAWS連携や外部通信の基盤です。
内部の不具合修正は可能ですが、ローカル版での置換、削除、公開インターフェースの変更は
行わないでください。

### 3.1 Lambda・SQS基盤

| ファイル | 保護する役割 |
|---|---|
| `raim_core_lambda/index.js` | Lambdaの`index.handler`と通常／SQSイベントの振り分け |
| `raim_core_lambda/lib/core-event.js` | Edge Lambdaから受け取る入力形式の正規化 |
| `raim_core_lambda/lib/sqs-core-handler.js` | Request Queue処理、FIFO順序、部分的バッチ失敗 |
| `raim_core_lambda/lib/request-state-store.js` | SQS重複配信対策、lease、TTL、処理状態管理 |
| `raim_core_lambda/lib/response-queue-publisher.js` | Response Queueへの順序付きストリーミングイベント送信 |
| `raim_core_lambda/lib/streaming-chat-json-extractor.js` | Mantleの生成途中JSONから表示用テキストを抽出 |

次の情報は外部契約として維持します。

- Request Queueの`schemaVersion`、`type`、`sub`、`requestId`、`connectionId`
- Response Queueの`stream.start`、`stream.delta`、`stream.completed`、`stream.error`
- Responseイベントの`requestId`、`connectionId`、`sequence`
- FIFO QueueのMessageGroupIdと重複排除処理
- SQSの`batchItemFailures`形式

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

### 3.3 Edge Lambdaとの出力契約

| ファイル | 保護する役割 |
|---|---|
| `raim_core_lambda/lib/core-response.js` | `ok`、`type`、`requestId`を含む共通レスポンス形式 |

レスポンス形式を変更する場合は、Core Lambda単体では変更せず、必ず次を同時に確認します。

- Edge Lambdaの`client-message.js`
- Response Queueのメッセージ形式
- Flutterクライアント
- Unityの表情制御

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

### 4.2 インターフェースを維持すれば変更できるファイル

| ファイル | 変更時の条件 |
|---|---|
| `raim_core_lambda/lib/core-chat-service.js` | 既存の入力、戻り値、ストリーミングコールバックを維持する |
| `raim_core_lambda/lib/types.js` | Edge、Flutter、Unityとのメッセージ契約を同時に確認する |
| `raim_core_lambda/lib/response-validator.js` | `types.js`とMantle出力形式を一致させる |

`core-chat-service.js`では、次のインターフェースを維持します。

- `handleCoreChat(event, options)`として呼び出せる
- `fallbackRequestId`を受け取れる
- `onMantleStreamEvent`を受け取れる
- `onMantleTextDelta`を受け取れる
- 成功時に`ok: true`のCoreレスポンスを返す
- 失敗時に分類可能なエラーを返す

## 5. 単独では変更してはいけない仕様

以下はローカル構成に近づけられますが、Core Lambdaだけを変更すると互換性が壊れます。

### 5.1 12感情と複数感情

ローカル構成では、従来の8感情に次を加えた12感情を使用します。

- `curious`
- `amused`
- `thoughtful`
- `playful`

また、単一の`emotion`／`intensity`ではなく、`emotions` Mapと
`overall_intensity`を使用します。

この変更には、少なくとも次の同時変更が必要です。

- Core Lambdaのプロンプト、型、応答検証
- Response Queueイベント
- Edge Lambdaのクライアント向け変換
- FlutterのJSON処理
- UnityのBlendShape／表情制御
- TTSの感情マッピング

移行期間中は、従来の`emotion`／`intensity`も後方互換として残す方針を推奨します。

### 5.2 ストリーミングメッセージ

ローカル構成の`metadata`、`text_chunk`、`audio_chunk`、`chat_end`へ変更する場合も、
Core Lambdaだけでは変更しません。現行の`stream.*`形式から段階的に拡張してください。

### 5.3 ToolとTTS

ローカル構成の次の処理は、そのままCore Lambdaへ統合しません。

- Tavily Web検索
- OpenWeatherMap天気取得
- VOICEVOX音声合成
- Base64 WAVのWebSocket送信

Core Lambdaには、将来のTool Lambda／TTS Lambdaを呼び出すための判断・イベント生成だけを
追加し、外部API呼び出しや音声合成本体は別Lambdaへ配置します。

## 6. 禁止する直接置換

以下の直接置換は行わないでください。

| ローカル側 | 置換してはいけない現行ファイル | 理由 |
|---|---|---|
| `local_core_reference/server.js` | `raim_core_lambda/index.js` | 常駐WebSocketサーバーとLambda Handlerは実行方式が異なる |
| `local_core_reference/lib/llm.js` | `raim_core_lambda/lib/mantle-client.js` | ローカル版のAWS LLM処理は未実装 |
| `local_core_reference/lib/embed.js` | `raim_core_lambda/lib/titan-embedding-client.js` | ローカル版のAWS Embedding処理は未実装 |
| `local_core_reference/lib/memory-store.js` | `raim_core_lambda/lib/user-session-store.js` | ローカルMapは再起動で履歴が消える |
| `local_core_reference/lib/pick-scene.js` | `raim_core_lambda/lib/scene-selector.js` | Scene保存場所、Embeddingモデル、閾値が異なる |

## 7. ローカル参照構成の注意点

ローカル構成には、移植前に解消すべき不整合があります。

- `scripts/build-embeddings.js`は存在しない`scene.examples`を参照している
- `pick-scene.js`が必要とする`scenes-embedded.json`はclone直後には存在しない
- Sceneの`default_emotions`と`server.js`が参照する`defaultEmotions`が一致していない
- コメントではLLMストリーミングを使用するとされているが、主経路は非ストリーミングである
- LLM、Embedding、Memory、Function CallingのAWSモードは未実装である
- 自動テストが用意されていない

そのため、ローカル構成のコメントを仕様の正本として扱わず、実コードと現行AWS構成を
照合したうえで必要な機能だけを移植します。

## 8. 変更時の確認手順

1. 変更対象が保護ファイルか確認する
2. Edge Lambda、SQS、DynamoDB、Flutter、Unityへの影響を確認する
3. 既存のCore Lambda単体テストを実行する
4. 新仕様の単体テストを追加する
5. Lambdaコンソールの直接イベントでTitan／Mantleを確認する
6. CloudFrontからのエンドツーエンドテストを実行する
7. `stream.start`から`stream.completed`までの`sequence`を確認する

テストコマンド:

```powershell
cd .\raim_core_lambda
npm.cmd test
```

## 9. 完了条件

ローカル構成への整合後も、次をすべて満たすことを完了条件とします。

- Cognito認証済みクライアントからCloudFront経由で接続できる
- Edge LambdaからRequest Queueへ入力が送られる
- Core LambdaがTitanでSceneを選択できる
- Secrets ManagerのAPI KeyでMantleを呼び出せる
- Response Queueへ順序付きストリーミングイベントを送れる
- Edge LambdaからWebSocketクライアントへ回答が返る
- SQS再配信時に同一リクエストを二重処理しない
- 既存テストと追加テストがすべて成功する
