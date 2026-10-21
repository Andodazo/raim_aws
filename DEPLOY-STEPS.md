# RAiM Core Lambda デプロイ手順

作業ディレクトリ: `H:\dev\RAiM_prot\raim_aws`

---

## 1. ソースを更新する

`raim-migration-changed-files.zip` を **`raim_aws` 直下**に展開して上書きします。

zip の中はリポジトリと同じフォルダ構造になっているため、
`lib/tools/` などの新規フォルダも自動で作られます。

> この zip は「変更したソースだけ」が入っています。
> Lambda へアップロードする `function.zip` とは別物です。

---

## 2. テストで確認する

```powershell
cd H:\dev\RAiM_prot\raim_aws\raim_core_lambda
npm.cmd install
npm.cmd test
```

期待結果:

```
# tests 69
# pass 69
# fail 0
```

Edge Lambda 側も確認する場合:

```powershell
cd H:\dev\RAiM_prot\raim_aws\raim_edge_lambda
npm.cmd install
npm.cmd test
```

期待結果: `18 pass`

---

## 3. function.zip を作り直す

```powershell
cd H:\dev\RAiM_prot\raim_aws\raim_core_lambda

npm.cmd run package
```

zip に入れるファイルは `package.json` の `package` に書いてあります。
手で `tar` のコマンドを打つと入れ忘れが起きるので、この1行で作ってください
（Edge / Summary / Authorizer も同じく `npm.cmd run package`）。

> `voice-config.json` を入れ忘れると、感情ごとの声の調整が効かず、
> どの感情でも同じ平らな声になります（ログに `[VoiceMapper] voice-config.json unavailable`）。

> `Compress-Archive` は使わないこと。
> Windows PowerShell 5.1 の `Compress-Archive` はパス区切りを `\` で書き込むため、
> Lambda（Linux）側でフォルダとして展開されず `Cannot find module` になります。
> `tar` は `/` で書き込むので正しく展開されます。

### 中身の確認

```powershell
tar -tf function.zip | Select-String "lib/tools"
tar -tf function.zip | Select-String "voice-config"
(Get-Item function.zip).Length / 1MB
```

期待結果:

- `lib/tools/index.js` のように **`/` 区切り**で表示される
- サイズは 50MB 未満（コンソールから直接アップロード可能）

---

## 4. Lambda へアップロードする

1. Lambda コンソール → `RAiM-Core-Lambda-dev`
2. 「コード」タブ → 右上「アップロード元」→ 「.zip ファイル」
3. `H:\dev\RAiM_prot\raim_aws\raim_core_lambda\function.zip` を選択
4. 「保存」

アップロード後、コードタブのファイルツリーで次を目視確認します。

- `lib/tools/` が**フォルダとして**開けること
- `lib/tool-secret-provider.js` があること

---

## 5. 環境変数（今回は追加不要）

今回の変更で追加した環境変数は 2 つですが、
**どちらも未設定でも既定値で動作します**。

| 環境変数 | 既定値 | 効く場面 |
|---|---|---|
| `FOLLOWUP_PERSONA_MODE` | `digest` | 2回目以降の会話のみ |
| `FOLLOWUP_FEW_SHOT_COUNT` | `1` | 2回目以降の会話のみ |

いずれも「継続会話で人格が崩れる」問題への対策です。
1回目の会話の挙動は変わりません。

### FOLLOWUP_PERSONA_MODE

2回目以降に、ライムの人格説明をどれだけ送り直すか。

| 値 | 送る内容 | 継続会話の送信量 |
|---|---|---|
| `none` | 送らない（元の設計） | 281 文字 |
| `digest` | 口調ルール + 12感情 + 出力形式の短縮版 | 749 文字 |
| `full` | 1回目と同じ全文 | 2513 文字 |

`digest` で口調が安定しない場合のみ、`full` へ変更して比較します。
値の変更だけならデプロイのやり直しは不要です。

### FOLLOWUP_FEW_SHOT_COUNT

2回目以降に、会話のお手本（DynamoDB の `few_shots`）を何組入れるか。
`0` で無効。お手本は口調を安定させる効果があるため、既定は 1 組です。

---

## 6. 動作確認

### 6.1 初回モードの確認

テストイベントの `sub` を**未使用の値**にして実行します。

```json
{
  "schemaVersion": 1,
  "type": "chat.request",
  "sub": "test-user-A",
  "requestId": "console-001",
  "connectionId": "lambda-console-connection-001",
  "source": "lambda-console",
  "text": "こんにちは。今日はどんな一日だった？",
  "images": []
}
```

期待するレスポンス:

```json
{
  "ok": true,
  "type": "chat",
  "text": "あ、こんにちは！...",
  "emotions": { "curious": 0.55, "happy": 0.45 },
  "overall_intensity": 0.9,
  "emotion": "curious",
  "intensity": 0.5
}
```

確認ポイント:

- 「あ、」「ふふっ」などライムらしい口調になっているか
- `emotions` が 2 種類以上あるか
- 「私はAIです」「お手伝いします」のようなアシスタント口調が出ていないか

### 6.2 継続モードの確認（今回の本命）

**`sub` を変えずに、もう一度**実行します。

1 回目で `RAiM-UserSession-dev` に会話状態が保存されるため、
2 回目は自動的に継続モードになります。

修正前は、ここで次のように崩れていました。

```json
{
  "text": "こんにちは！私はあなたとお話しできるのを待っていたから...",
  "emotions": { "happy": 1 }
}
```

修正後は、2 回目も 6.1 と同等の口調・複数感情が維持されていれば成功です。

### 6.3 うまくいかない場合

`FOLLOWUP_PERSONA_MODE` を `full` に変更して再確認します。
（環境変数の変更のみ。再デプロイ不要）

---

## 補足: sub とセッションの関係

Core Lambda は `sub`（ユーザー識別子）ごとに、DynamoDB の
`RAiM-UserSession-dev` テーブルへ会話状態（`lastResponseId`）を保存します。

- 記録がない → **初回モード**（人格プロンプト全文 + few-shot 全組）
- 記録がある → **継続モード**（`previous_response_id` で文脈を引き継ぐ）

そのため、同じ `sub` で 2 回実行すれば継続モードを再現できます。
初回モードからやり直したい場合は、次のどちらかを行います。

- テストイベントの `sub` を新しい値に変える（簡単）
- `RAiM-UserSession-dev` から該当項目を削除する

---

## トラブルシューティング

| 症状 | 原因 | 対処 |
|---|---|---|
| `Cannot find module './tools'` | zip のパス区切りが `\` | `tar` で作り直す |
| `Cannot find module '@aws-sdk/...'` | `node_modules` 未インストール | `npm.cmd install` |
| ツールが動かない | `TOOL_API_KEY_SECRET_ARN` 未設定 | 環境変数を確認（未設定でも会話自体は動作） |
| アシスタント口調のまま | 継続モードで人格が届いていない | `FOLLOWUP_PERSONA_MODE=full` を試す |

## 補足: スレッド削除と記憶まわりの権限（2026-10）

スレッドを消したときに記憶（userMemory）をすぐ空にし、古い記憶が書き戻されないようにした。
次の権限が新しく要る。

| Lambda | テーブル | 権限 | 用途 |
|---|---|---|---|
| Edge | `RAiM-UserSession-dev` | `dynamodb:UpdateItem` | 削除の完了を返す前に記憶を空にし、世代番号（`memoryGeneration`）を進める |
| Summary | `RAiM-UserSession-dev` | `dynamodb:GetItem` | 記憶を作り始める前に世代番号を読む。無いと記憶の作り直しが毎回失敗し、記憶が空のままになる |

あわせて、Edge の `execute-api:ManageConnections` に `DELETE/@connections/*` を足す
（期限が切れた接続をこちらから切るため。詳しくは raim_edge_lambda/DEPLOYMENT.md）。

展示用の掃除 Lambda（raim_demo_cleanup_lambda）は消した。AWS 上の関数と、
それを毎分呼んでいる EventBridge のスケジュールも止めること。

UserSession の項目を手で消すと世代番号も消える。そのとき作り直し中の処理が
古い記憶を書き込むことがあるので、項目を消したあとは対象のユーザーで一度会話を消し直すか、
記憶の作り直しを依頼し直す。
