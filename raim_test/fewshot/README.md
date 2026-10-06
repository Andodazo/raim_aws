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

最後に、Scene 選択が狙いどおりか確かめる。

```bash
bash check_scene_selection.sh
```

`NG` が出たら、その Scene の `embedding_text` を直して、もう一度 `--apply` → centroid 作り直し。
