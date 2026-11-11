# 会話の自動テスト（口調を見る）

アプリを起動せずに、本物の Core のコードへ台本の会話を流して、ライムの返事を一覧にする。

- 本物のまま: プロンプト、場面選び（Titan）、会話例（DynamoDB を読むだけ）、続きの会話（要約版）、Mantle
- 差し替え: 会話の保存先と記憶はメモリの中だけ（DynamoDB に書かない）。検索・天気・要約・音声・アプリは使わない
- 口調の良し悪しは人が読む。自動で付けるのは決まったチェックだけ
  - 「あなた」、「w」、顔文字・記号、ツール名、JSON がそのまま出た、120文字を超えた
  - 台本ごとの期待（`maxSentences` 文の数、`notContains` 出ない言葉、`containsAny` 出てほしい言葉、`noMemes` 重い話でネタの言葉）
  - 1つの会話の中で、8文字以上の同じ言い回しを2回使った
  - まとめに「よく出た言葉」（会話をまたいで「勝ち確」「AWS」などを何回使ったか）

## CloudShell での動かし方

CloudShell の「アクション」→「ファイルのアップロード」で、次の2つを上げる。

- Core の zip（`function.zip`。デプロイしたものと同じ）
- `convo-test.zip`（このフォルダを固めたもの）

1行ずつ貼る。

```
mkdir -p ~/core && unzip -oq ~/function.zip -d ~/core
```
```
mkdir -p ~/convo && unzip -oq ~/convo-test.zip -d ~/convo
```
```
aws lambda get-function-configuration --function-name RAiM-Core-Lambda-dev --region ap-northeast-1 --query Environment.Variables > ~/core-env.json
```
```
node ~/convo/run_convo.js --core ~/core --env ~/core-env.json
```

68本の台本で数分かかる。画面に結果が出て、`convo-report-<日時>.txt`（全部の返事）と `.json` ができる。
`.txt` を「アクション」→「ファイルのダウンロード」で落とせば読める。

### よく使うオプション

```
node ~/convo/run_convo.js --core ~/core --env ~/core-env.json --only ノリ        # タグか id に「ノリ」を含む台本だけ
node ~/convo/run_convo.js --core ~/core --env ~/core-env.json --runs 2          # 2回ずつ流して、ぶれを見る
node ~/convo/run_convo.js --core ~/core --env ~/core-env.json --persona bright  # 人格を変える
node ~/convo/run_convo.js --core ~/core --fake                                  # AWS を使わずに流れだけ確かめる
```

### 直す前と後を比べる

直す前の zip を `~/core-old` に展開して、2つ並べる。同じ発言への返事が並んで出る。

```
node ~/convo/run_convo.js --core before=~/core-old --core after=~/core --env ~/core-env.json
```

## 台本（scenarios.json / scenarios2.json）

- `scenarios.json`: 68本。あいさつ、ノリ、褒め、落ち込み、重い話、説明、ミーム、記憶、話しかけ など
- `scenarios2.json`: 66本。1本目と別の場面（短い返事しかしない人、意見を聞く、ゲーム、恋愛、愚痴、
  ライムへの質問、乱暴な言葉、若者言葉、体調、話題の切り替え、8往復の会話、別の人の記憶 など）。
  `--scenarios ~/convo/scenarios2.json` で使う

### 書き方

```json
{
  "id": "nori-boke",
  "tag": "ノリ",
  "note": "読むときのメモ（任意）",
  "memory": "【事実】\n- 名前はたっくん",
  "greeting": true,
  "expect": { "noMemes": true },
  "turns": [
    { "say": "ボケるからツッコんで" },
    { "say": "量子コンピュータって何？", "expect": { "maxSentences": 3 } }
  ]
}
```

- `memory`: ライムの記憶（任意）。Summary が作る形（【事実】【関係性】）で書く
- `greeting`: true なら、最初にアプリを開いたときの話しかけをする
- `expect`: 会話全体の期待。`turns[].expect` は発言ごと（両方書くと合わせて見る）
- 台本ごとに新しい会話で始まる（前の台本の返事は引きずらない）

## 権限エラーが出たら

CloudShell のユーザーに、Bedrock（Titan と Mantle の API キーの Secret）と DynamoDB の会話例テーブル（読むだけ）の権限が要る。
`AccessDenied` が出たら、どの操作で出たかを見て権限を足す。
