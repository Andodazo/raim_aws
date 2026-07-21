# RAiM TTS Lambda

VOICEVOX Core 0.15.4を利用する、RAiMから直接InvokeするTTS Lambdaです。
デプロイ方式はARM64のコンテナイメージ方式です。

## 構成

- Lambdaパッケージタイプ: `Image`
- ベースイメージ: `public.ecr.aws/lambda/provided:al2023`
- アーキテクチャ: `arm64`
- コンテナのエントリーポイント: `bootstrap`
- イメージ保管先: Amazon ECR
- Function URL: 使用しない
- APIキー認証: 使用しない
- X-Ray: 使用しない

VOICEVOX CoreのモデルとOpen JTalk辞書を含むため、Zip方式ではなくコンテナイメージ方式を使用します。

## ビルド

Docker Desktopを起動した状態で、次を実行します。

```powershell
Set-Location C:\dev\raim_aws\raim_tts_lambda
powershell -NoProfile -ExecutionPolicy Bypass -File .\build_container_image.ps1
```

デフォルトでは、ローカルDockerへ次のイメージを読み込みます。

```text
raim-tts-lambda:dev
```

## 単体テスト

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run_unit_tests.ps1
```

## ECRへのPush

ECRリポジトリを作成済みであることを前提に、次のように実行します。

```powershell
$region = "ap-northeast-1"
$accountId = "AWS_ACCOUNT_ID"
$repository = "raim-tts-lambda"
$imageUri = "$accountId.dkr.ecr.$region.amazonaws.com/${repository}:dev"

aws ecr get-login-password --region $region |
    docker login --username AWS --password-stdin "$accountId.dkr.ecr.$region.amazonaws.com"

powershell -NoProfile -ExecutionPolicy Bypass -File .\build_container_image.ps1 `
    -ImageTag $imageUri `
    -Output push
```

Lambda関数とECRリポジトリは同じAWSリージョンに配置してください。

## Lambdaコンソール設定

- パッケージタイプ: `Container image`
- イメージURI: PushしたECRイメージURI
- アーキテクチャ: `arm64`
- メモリ: `10240 MB`
- タイムアウト: `120秒`
- 実行ロール: `RAiM-TTS-Lambda-Role-dev`
- Function URL: 作成しない
- X-Ray: 無効

環境変数は次のとおりです。

```text
MAX_TEXT_CHARS=200
MAX_WAV_BYTES=4194304
VOICEVOX_CPU_THREADS=6
OPEN_JTALK_DICT_DIR=/var/task/voicevox/open_jtalk_dic_utf_8-1.11
LD_LIBRARY_PATH=/var/task/voicevox/voicevox_core
```

Zipパッケージタイプで作成済みのLambda関数は、コンテナイメージへ変更できません。必要な場合はコンテナイメージ用の新しいLambda関数を作成します。

## CloudFormation

`raim_cloud_formation/raim_tts_dev.json`は構成のバージョン管理用です。
CloudFormationによるデプロイは行わず、ECRへのPushとLambdaコンソールでのイメージ更新を手動で行います。

## ライセンス・クレジット

VOICEVOX Coreおよび使用する話者の利用規約を確認し、必要なクレジット表示とライセンスファイルの保持を行ってください。
