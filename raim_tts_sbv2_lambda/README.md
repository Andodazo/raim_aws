# raim_tts_sbv2_lambda（自作の声の TTS Lambda）

ライムの声（Style-Bert-VITS2 JP-Extra で学習した raim_D1v4）で文を読み上げる Lambda。
VOICEVOX の TTS Lambda（`raim_tts_lambda`）と同じ受け答えの形なので、Core は
`TTS_FUNCTION_NAME` をこの関数名に変えるだけで切り替えられる。VOICEVOX に戻すときは元の名前に戻す。

仕様は 2026-11-23 に安藤さんと決めた（自作TTS（ライムの声）本番化の仕様案）。

## 受け答え

| 種類 | 受け取る | 返す |
| --- | --- | --- |
| 読み上げ | `{"schemaVersion":1,"type":"tts.synthesize","requestId","chunkId","text","voiceParams"}` | `{"ok":true,"type":"tts.synthesized","format":"wav","contentType":"audio/wav","audio"(base64),"audioByteLength",...}` |
| 温め | `{"schemaVersion":1,"type":"tts.warmup"}` | `{"ok":true,"type":"tts.warmed","cold",...}`（Core は返事を待たない） |
| 失敗 | — | `{"ok":false,"type":"tts.error","code","message","retriable"}` |

- `voiceParams.emotionMix`（例 `{"happy":0.6,"embarrassed":0.3}`）と `emotionIntensity` から声を決める。
  VOICEVOX 用の値（speedScale など）は使わない。
- エラーの code：`UNSUPPORTED_SCHEMA_VERSION` / `UNSUPPORTED_MESSAGE_TYPE` / `INVALID_REQUEST` / `INVALID_TEXT` /
  `NOTHING_TO_SPEAK`（「www」だけなど）は再試行しない。`MODEL_LOAD_FAILED` / `SYNTHESIS_FAILED` は再試行してよい。
- ログには文の中身を残さない（文字数と時間だけ）。

## 感情の扱い（`src/emotion_map.json`、`src/voice_style.py`）

声のスタイルは5つ（neutral / happy / surprise / sad / angry）。Core の12感情それぞれに
「スタイルの混ぜ方・強さ・速さ（length）・緩急（sdp_ratio）・揺れ（noise）」を決めてある。
Core が感情を混ぜて出したら、その重みで設定を混ぜる（VOICEVOX は一番大きい感情しか使えなかった）。

- 強さ（emotionIntensity）が低いほど neutral に近づく。ただし `EMOTION_MIN_STRENGTH`（既定 0.5）までは感情を残す。
- 補助テキスト（assist_text）は使わない（声が別人のようになることがあった）。
- 高さ・抑揚の後処理（pitch_scale / intonation_scale）は使わない（生成が約3.5倍遅くなる）。

## 読み間違いの直し方

- 言葉の読み：`src/raim_user_dict.csv`（MeCab 形式、英字は全角）に1行足す。起動時に csv から辞書を作る。
  `USER_DICT_S3_KEY` を設定すると S3 の csv を使うので、zip を作り直さずに直せる（温まっている環境は次の起動から）。
- 記号・数字の書き方（w、℃、%、1/3、15:30 など）：`src/raim_preprocess.py`。
- 文脈で読みが変わる字（辛い・方・一日 など）は辞書では直せない。今は何もしない（2026-11-23 決定）。

## 環境変数

| 名前 | 既定 | 中身 |
| --- | --- | --- |
| `MODEL_S3_BUCKET` | （必須） | モデル一式のバケット（本番 `raim-tts-models-990442281360`） |
| `MODEL_S3_PREFIX` | 空 | `<prefix>/raim_models.tar` |
| `PRELOAD` | `0` | `1` で初期化中に読み込む。SnapStart を使うときだけ `1`（ふつうは初期化10秒の制限があるので `0`） |
| `MODEL_DOWNLOAD_PARALLEL` | `1` | tar を何本に分けて同時に落とすか。Lambda では1本の方が速かった（1本 9.3秒、8本 11.4秒） |
| `MODEL_DOWNLOAD_PART_MB` | `64` | 分けるときの1本の大きさ |
| `USER_DICT_S3_KEY` | 空 | S3 の読み辞書 csv（無ければ zip の `raim_user_dict.csv`） |
| `EMOTION_MIN_STRENGTH` | `0.5` | 感情の強さが低くても残す割合 |
| `MAX_TEXT_CHARS` | `200` | 1回に読む文字数の上限 |

## Lambda の設定（本番）

- 関数名 `RAiM-TTS-SBV2-dev`、ランタイム Python 3.12、x86_64、ハンドラ `handler.handler`
- メモリ 10240MB、エフェメラルストレージ（/tmp）2048MB、タイムアウト 3分
- ロール：S3 の `raim-tts-models-990442281360` を読めること
- プロビジョンド同時実行は使わない。SnapStart も普段は使わない（発表の日だけ使うなら、`PRELOAD=1` にしてバージョンを発行し、SnapStart を有効にする）

2026-11-23 のテスト（`raim-tts-sbv2-test`、x86_64、10240MB）：温まっていれば1文 平均2.1秒、
冷えた1回目は約19秒（S3 から 8.9秒 ＋ 読み込み 7.4秒。分けて同時に落とすのはこのあと足した）。
arm64 は 10240MB で 2.65秒、それ以下のメモリでは生成が音声より遅いので使わない。

## 作り方

1. site-packages を作る（Lambda と同じ環境で pip install するため docker を使う）

   ```
   docker build -t raim-tts-sbv2-build -f build/Dockerfile build
   docker create --name raim-tts-sbv2-build raim-tts-sbv2-build
   docker cp raim-tts-sbv2-build:/var/lang/lib/python3.12/site-packages build/raw/site-packages
   docker rm raim-tts-sbv2-build
   ```

2. Style-Bert-VITS2 を取ってくる（改変しないで使う）

   ```
   git clone https://github.com/litagin02/Style-Bert-VITS2 build/raw/Style-Bert-VITS2
   git -C build/raw/Style-Bert-VITS2 checkout 66de777e06392c0f313600be03c43ef96658b244
   ```

3. zip を作る：`python -I build/build_zip.py zip --site-packages build/raw/site-packages --sbv2 build/raw/Style-Bert-VITS2/style_bert_vits2`
   → `build/dist/function.zip`（約62MB。50MB を超えるので S3 経由でアップロードする）

4. モデル一式（声のモデルを作り直したときだけ）
   - 声：SBV2 の `convert_onnx.py --model <safetensors>` で ONNX にする
   - BERT：SBV2 の `convert_bert_onnx.py` で ONNX にし、`python build/prep_bert.py <deberta のフォルダ> <bert_int8>` で int8 にする
   - `python -I build/build_zip.py models --voice <raim_D1v4> --bert <bert_int8> --dict <open_jtalk_dic_utf_8-1.11>`
     → `build/dist/raim_models.tar`（約794MB）を S3 に置く

`build/raw`、`build/pkg`、`build/dist` はコミットしない。

## テスト

AWS のテスト用関数（raim-tts-sbv2-test）で一括テストするときは、CloudShell に function.zip と `tools/cloudshell_test.sh` を上げて `bash cloudshell_test.sh function.zip`。
分割ダウンロード（MODEL_DOWNLOAD_PARALLEL 1 と 8）の比べ、感情つきの読み上げ、エラーの返し方をまとめて測る。

手元のテスト：

```
python -m unittest discover -s tests
```

モデルを使わない部分（感情の混ぜ方、前処理、受け答え、S3 の分割ダウンロード）を確かめる。

## ライセンス

Style-Bert-VITS2 が AGPL-3.0 なので、この Lambda（このフォルダ）も AGPL-3.0 で公開する（`LICENSE`）。
ほかに使っているもの（BERT、Open JTalk の辞書など）とクレジットは `THIRD_PARTY_NOTICES.md`。
