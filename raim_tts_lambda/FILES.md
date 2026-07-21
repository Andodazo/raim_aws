# RAiM TTS Lambda ファイル構成

## ルートファイル

| ファイル | 用途 |
| --- | --- |
| `Dockerfile` | VOICEVOX Core取得、Rustビルド、Lambda用コンテナイメージ作成 |
| `build_container_image.ps1` | ARM64コンテナイメージのビルド・ローカル読み込み・ECR Push |
| `run_unit_tests.ps1` | Linux ARM64ビルド環境でRust単体テストを実行 |
| `Cargo.toml` | Rustパッケージと依存クレートの定義 |
| `README.md` | ビルド、ECR Push、Lambda設定、運用手順 |
| `FILES.md` | ファイル構成の説明 |
| `.dockerignore` | Dockerビルドコンテキストから除外するファイルの定義 |
| `.gitignore` | ローカル生成物やテスト生成物の除外 |

## `src`

| ファイル | 用途 |
| --- | --- |
| `src/main.rs` | Lambda Runtime APIのエントリーポイント、入力検証、音声合成、レスポンス生成 |
| `src/types.rs` | TTSリクエスト・レスポンス型、入力値検証 |
| `src/voicevox_wrapper.rs` | VOICEVOX Core初期化、話者モデル読み込み、WAV合成 |

## `test-events`

Lambdaコンソールなどで使用するテストイベントです。

| ファイル | 確認内容 |
| --- | --- |
| `01-neutral.json` | 通常のTTSリクエスト |
| `02-caring.json` | 音声パラメータ変更 |
| `03-invalid-empty-text.json` | 空テキストの入力エラー |
| `04-invalid-voice-params.json` | 音声パラメータ範囲エラー |
| `05-invalid-schema.json` | 未対応スキーマバージョン |

## コンテナ内の主な配置

```text
/var/task/bootstrap
/var/task/voicevox/voicevox_core/...
/var/task/voicevox/open_jtalk_dic_utf_8-1.11/...
```

## デプロイ成果物

Zipファイルは作成しません。`build_container_image.ps1`で作成したイメージをECRへPushし、Lambda関数のイメージURIを更新します。
