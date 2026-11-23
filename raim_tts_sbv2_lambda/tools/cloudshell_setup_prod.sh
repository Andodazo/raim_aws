#!/usr/bin/env bash
# 自作の声の TTS を本番用に作る（CloudShell で1回流すだけ）。
#
# やること:
#   1. モデル置き場のバケット（raim-tts-models-<アカウント>）を作り、公開をすべて止める
#   2. テスト用バケットから raim_models.tar をコピーする（S3 の中でコピーするので速い）
#   3. 関数 RAiM-TTS-SBV2-dev を作る（もうあればコードと設定を更新する）
#   4. Core のロールがこの関数を呼べるように、関数とバケットの側で許可する
#   5. 冷えた状態からの温めと、読み上げ1回で動くか確かめる
#
# 使い方（function.zip とこのファイルを CloudShell に上げてから）:
#   bash cloudshell_setup_prod.sh function.zip
#
# Core の TTS_FUNCTION_NAME は切り替えない（手順書のとおり、コンソールで手で変える）。
# 既にある本番の関数（RAiM-API-Lambda-dev や RAiM-TTS-Lambda-dev）には何もしない。
set -euo pipefail

ZIP="${1:-}"
REGION="${AWS_REGION:-ap-northeast-1}"
export AWS_REGION="$REGION" AWS_PAGER=""
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
FUNCTION="RAiM-TTS-SBV2-dev"
BUCKET="${BUCKET:-raim-tts-models-${ACCOUNT}}"
SOURCE_TAR="${SOURCE_TAR:-s3://raim-tts-sbv2-test-${ACCOUNT}/models/raim_models.tar}"
CORE_FUNCTION="${CORE_FUNCTION:-RAiM-API-Lambda-dev}"
MEMORY=10240
TIMEOUT=120
TMP_MB=2048

log() { echo "[$(date +%H:%M:%S)] $*"; }
fail() { echo "!! $*" >&2; exit 1; }

[[ -n "$ZIP" && -f "$ZIP" ]] || fail "function.zip を指定してください（bash cloudshell_setup_prod.sh function.zip）"

wait_updated() {
  aws lambda wait function-updated-v2 --function-name "$FUNCTION" 2>/dev/null \
    || aws lambda wait function-updated --function-name "$FUNCTION"
}

# Core のロール（RAiM-ApiLambdaRole）を Core の関数から読む
CORE_ROLE="$(aws lambda get-function-configuration --function-name "$CORE_FUNCTION" --query Role --output text)" \
  || fail "Core の関数（$CORE_FUNCTION）が読めません"
log "Core のロール: $CORE_ROLE"
log "作るもの: 関数 $FUNCTION / バケット $BUCKET"

# 1. バケット
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  log "バケットはもうあります"
else
  log "バケットを作ります"
  aws s3api create-bucket --bucket "$BUCKET" \
    --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
fi
aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

# 2. モデルのコピー
if aws s3api head-object --bucket "$BUCKET" --key raim_models.tar >/dev/null 2>&1; then
  log "raim_models.tar はもうあります（上書きしません）"
else
  log "$SOURCE_TAR をコピーします（794MB、1分くらい）"
  aws s3 cp "$SOURCE_TAR" "s3://$BUCKET/raim_models.tar" --only-show-errors
fi

# 4a. バケットの側で、Core のロール（＝この関数のロール）に読むことだけ許す
if aws s3api get-bucket-policy --bucket "$BUCKET" >/dev/null 2>&1; then
  log "バケットのポリシーはもうあるので触りません"
else
  log "Core のロールに、モデルを読むことだけ許可します"
  aws s3api put-bucket-policy --bucket "$BUCKET" --policy "$(cat <<JSON
{"Version":"2012-10-17","Statement":[{"Sid":"RaimTtsReadModels","Effect":"Allow",
"Principal":{"AWS":"$CORE_ROLE"},"Action":"s3:GetObject","Resource":"arn:aws:s3:::$BUCKET/*"}]}
JSON
)"
fi

# 3. 関数
KEY="code/raim_tts_sbv2_$(date +%Y%m%d_%H%M%S).zip"
log "zip を s3://$BUCKET/$KEY に上げます（$(du -h "$ZIP" | cut -f1)）"
aws s3 cp "$ZIP" "s3://$BUCKET/$KEY" --only-show-errors
ENV="Variables={MODEL_S3_BUCKET=$BUCKET,MODEL_DOWNLOAD_PARALLEL=1}"
if aws lambda get-function --function-name "$FUNCTION" >/dev/null 2>&1; then
  log "関数はもうあるので、コードと設定を更新します"
  aws lambda update-function-code --function-name "$FUNCTION" --s3-bucket "$BUCKET" --s3-key "$KEY" >/dev/null
  wait_updated
  # 環境変数は、辞書の設定（USER_DICT_S3_KEY など）を消さないよう、今の値に足す形で入れる
  aws lambda get-function-configuration --function-name "$FUNCTION" --query 'Environment.Variables' --output json > /tmp/env_now.json
  python3 - "$BUCKET" <<'PY' > /tmp/env_new.json
import json, sys
env = json.load(open("/tmp/env_now.json")) or {}
env.update({"MODEL_S3_BUCKET": sys.argv[1], "MODEL_DOWNLOAD_PARALLEL": "1"})
print(json.dumps({"Variables": env}))
PY
  aws lambda update-function-configuration --function-name "$FUNCTION" \
    --runtime python3.12 --handler handler.handler --role "$CORE_ROLE" \
    --memory-size "$MEMORY" --timeout "$TIMEOUT" --ephemeral-storage "Size=$TMP_MB" \
    --environment file:///tmp/env_new.json >/dev/null
else
  log "関数を作ります"
  aws lambda create-function --function-name "$FUNCTION" \
    --description "RAiM TTS: own voice (Style-Bert-VITS2, AGPL-3.0)" \
    --runtime python3.12 --architectures x86_64 --handler handler.handler --role "$CORE_ROLE" \
    --memory-size "$MEMORY" --timeout "$TIMEOUT" --ephemeral-storage "Size=$TMP_MB" \
    --environment "$ENV" --code "S3Bucket=$BUCKET,S3Key=$KEY" >/dev/null
  aws lambda wait function-active-v2 --function-name "$FUNCTION" 2>/dev/null \
    || aws lambda wait function-active --function-name "$FUNCTION"
fi
wait_updated
aws s3 rm "s3://$BUCKET/$KEY" --only-show-errors || true

# 温め（返事を待たない呼び方）が失敗しても、やり直さない
aws lambda put-function-event-invoke-config --function-name "$FUNCTION" \
  --maximum-retry-attempts 0 >/dev/null || log "（やり直さない設定はできませんでした。動作には影響しません）"

# 4b. 関数の側で、Core のロールに呼ぶことを許す
if aws lambda add-permission --function-name "$FUNCTION" --statement-id raim-core-invoke \
     --action lambda:InvokeFunction --principal "$CORE_ROLE" >/dev/null 2>"/tmp/add_permission.err"; then
  log "Core のロールに、この関数を呼ぶことを許可しました"
elif grep -q ResourceConflict /tmp/add_permission.err; then
  log "Core のロールの呼ぶ許可はもうあります"
else
  cat /tmp/add_permission.err >&2
  log "!! 呼ぶ許可を足せませんでした。手順書の「うまくいかないとき」を見てください"
fi

# ログは14日で消す
aws logs create-log-group --log-group-name "/aws/lambda/$FUNCTION" 2>/dev/null || true
aws logs put-retention-policy --log-group-name "/aws/lambda/$FUNCTION" --retention-in-days 14 2>/dev/null \
  || log "（ログの保存期間は変えられませんでした。動作には影響しません）"

# 5. 動くか確かめる
call() {
  local name="$1" payload="$2"
  aws lambda invoke --function-name "$FUNCTION" --cli-binary-format raw-in-base64-out \
    --cli-read-timeout 300 --payload "$payload" "/tmp/$name.json" >/dev/null
  python3 - "/tmp/$name.json" "$name" <<'PY'
import json, sys
body = json.load(open(sys.argv[1]))
keys = ("ok", "cold", "downloadSec", "loadSec", "audioByteLength", "code", "message")
print(f"  {sys.argv[2]}: " + "  ".join(f"{k}={body[k]}" for k in keys if k in body))
if not body.get("ok"):
    sys.exit(1)
PY
}
log "冷えた状態から温めます（15秒くらい）"
call warmup '{"schemaVersion":1,"type":"tts.warmup","reason":"setup"}' \
  || fail "温めに失敗しました。手順書の「うまくいかないとき」を見てください"
log "読み上げを1回試します"
call say '{"schemaVersion":1,"type":"tts.synthesize","requestId":"setup","chunkId":"setup_chunk_0","text":"ライムだよ。今日からこの声でしゃべるね。","voiceParams":{"emotionMix":{"happy":0.7},"emotionIntensity":0.6}}' \
  || fail "読み上げに失敗しました"
python3 -c 'import base64,json; b=json.load(open("/tmp/say.json")); open("setup_check.wav","wb").write(base64.b64decode(b["audio"]))'

echo
log "できました。関数 $FUNCTION は動いています（声は setup_check.wav）"
log "次は手順書の 3（Core と Edge の zip を上げる）と 4（TTS_FUNCTION_NAME を $FUNCTION にする）です"
