# AWS でやること（2026-10 のセキュリティ修正の続き）

コードの修正（バッチ4・5、プロンプト注入の予防、C-04）と一緒に、AWS 側で要る作業をまとめる。
API Gateway の上限・Budgets・IAM・C-03 は対応済み・不要なので載せていない。
CloudShell（bash）で行う。コマンドは **1つずつ** 貼って、結果を見てから次へ進む。

最初に、毎回使う値を CloudShell に入れておく（CloudShell を開き直したら入れ直す）。

```bash
export AWS_REGION=ap-northeast-1
```

```bash
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
```

```bash
echo $ACCOUNT_ID
```

---

## 1. Lambda を出す順番

今回は Authorizer は変わっていない。受け取る側から出す。

1. Summary（墓標を読まない・書かない）
2. Core（actionId、THREAD_DELETED、駅アラームの確かめ、記憶の分離）
3. Edge（墓標、失敗を WebSocket で返す、回数の上限）

各フォルダで `npm.cmd test` → `npm.cmd run package` → コンソールからアップロード。
アプリはサーバーより先でも後でも動く（どちらの組み合わせでも壊れない）。

### Edge の環境変数（入れなくても既定値で動く）

| 名前 | 既定 | 意味 |
|---|---|---|
| `CHAT_RATE_LIMIT_PER_MINUTE` | 20 | 1人が1分に送れるチャットの数。0 で使わない |
| `CHAT_RATE_LIMIT_PER_DAY` | 500 | 1人が1日に送れるチャットの数。0 で使わない |
| `REQUEST_STATE_TABLE_NAME` | RAiM-CoreRequest-dev | 回数を数えるテーブル |
| `THREAD_TOMBSTONE_DAYS` | 30 | 消したスレッドの墓標を残す日数 |

### 出したあとの確認

- スレッドを1つ消して、一覧から消えること。Edge のログに `[ThreadDelete] ... failed` が出ないこと
- 消したスレッドを別の端末で開いたまま送ると、アプリに「この会話は消されていたので、新しい会話にしました」と出ること
- 「新宿で起こして」で駅アラームが始まること（確かめの言葉に入っているので通る）

---

## 2. 消したスレッドの墓標を自動で消す（TTL）

Edge は、消したスレッドを `expiresAt` 付きの墓標に置き換える。
`RAiM-ConversationThread-dev` の TTL を `expiresAt` で有効にすると、30日で消える。
有効にしなくても動く（墓標が残り続けるだけ。1件あたり数十バイト）。

今の設定を見る:

```bash
aws dynamodb describe-time-to-live --table-name RAiM-ConversationThread-dev
```

`TimeToLiveStatus` が `DISABLED` なら有効にする:

```bash
aws dynamodb update-time-to-live --table-name RAiM-ConversationThread-dev --time-to-live-specification "Enabled=true,AttributeName=expiresAt"
```

> 権限が無いと言われたら東に頼む。

---

## 3. 掃除 Lambda を消す（決まったら）

`RAiM-DemoCleanup-Lambda-dev` は同時実行数 0 で止めてあるだけ。消すなら関数と、呼んでいる
EventBridge のルールの両方。ルールは安藤の権限では見られない（`events:ListRules` が無い）ので東に頼む。

```bash
aws lambda delete-function --function-name RAiM-DemoCleanup-Lambda-dev
```
