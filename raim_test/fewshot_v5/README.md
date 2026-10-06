# few-shot v5（bright / downer）

`RAiM-FewShot-dev` の `few_shots`（bright 用）と `few_shots_downer`（downer 用）を書き換えるためのファイル。
中身は `fewshot_preview.txt` で確認できる。

CloudShell でこのフォルダに入って実行する。

```bash
./apply_fewshot.sh
```

- 実行前に今の `few_shots` を `fewshot_backup_<日時>.json` に保存する
- `embedding_text` / `textCentroid` / `default_emotions` には触れないので、Scene 選択はそのまま
