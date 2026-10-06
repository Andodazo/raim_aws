# Scene / few-shot（感情ごと）

`RAiM-FewShot-dev` の Scene 定義。`scenes.json` が元データで、ここを直して反映する。
中身は `fewshot_preview.txt` で確認できる。

12感情それぞれに、その感情が中心になる Scene を1つずつ用意している（`default` は汎用）。

| Scene | 中心の感情 | どんなとき |
|---|---|---|
| default | - | 特定の話題に当てはまらない雑談・挨拶・自己紹介 |
| question | neutral | 知識や言葉の意味を聞かれた |
| good_news | happy | 嬉しいことの報告 |
| sad_news | sad | 悲しいこと・寂しいこと |
| unfair | angry | 理不尽な目にあった話（ライムが代わりに少し怒る） |
| surprise | surprised | 予想外の話 |
| tired | caring | 疲れた・しんどい |
| praise | embarrassed | ライムが褒められた・お礼を言われた |
| gaming | excited | ゲームの話 |
| share | curious | 新しく始めたこと・出かけた話 |
| joke | amused | 冗談・面白い話 |
| advice | thoughtful | 相談・どっちがいいか |
| play | playful | なぞなぞ・しりとり・「〇〇って言って」 |

各 Scene に3〜4組（question と gaming には「知らない」と答える例を追加）。`bright` は `few_shots`、`downer` は `few_shots_downer` に入る。

## 反映手順（CloudShell）

```bash
git clone https://github.com/Andodazo/raim_aws
cd raim_aws/raim_test
npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @aws-sdk/client-bedrock-runtime

cd fewshot
node apply_fewshot.js            # 確認だけ
node apply_fewshot.js --apply    # バックアップを取ってから反映
```

`--apply` の最後に、textCentroid を作り直す必要がある Scene のコマンドが表示されるので、それを実行する。

```bash
node ../generate_scene_centroids.js --apply --force --scene-id question --scene-id good_news ...
```

最後に、Scene 選択が狙いどおりか確かめる（入力は `check_cases.txt`）。

```bash
bash check_scene_selection.sh
```

`NG` が出たら、その Scene の `embedding_examples` に例文を足して、もう一度 `--apply` → centroid 作り直し。

## Scene 判定のベクトル

`textCentroid` は `embedding_examples`（各 Scene 10文の例文）を1文ずつ Titan でベクトルにして平均したもの。
単語を並べた `embedding_text` だけで作ると、ユーザーの普通の文と類似度が上がらず、
閾値（0.25）に届かずに default へ落ちることが多かった（2026-10 実測で 13件中6件）。
`embedding_text` は説明用に残している（例文が無い Scene ではこちらを使う）。
確認用の入力（`check_cases.txt`）は、例文と同じ文にしない。
