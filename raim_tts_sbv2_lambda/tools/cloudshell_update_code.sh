#!/usr/bin/env bash
# 自作の声の関数の、src の .py だけを入れ替える（zip を作り直さない。CloudShell で流す）。
#
# やること:
#   1. 今動いている関数のコードを落とす
#   2. 指定した .py を、zip の中の同じ名前のファイルと入れ替える（zip に無い名前なら何もしないで止まる）
#   3. S3 経由で関数のコードを更新する（環境変数や設定はそのまま）
#   4. 冷えた状態から温めて、読み上げを1回試す（声は update_check.wav）
#
# 使い方（直した .py とこのファイルを CloudShell に上げてから）:
#   bash cloudshell_update_code.sh raim_preprocess.py
#
# 戻すとき: 前のコードを s3://<バケット>/code/old/ に残すので、手順書の「戻し方」を見る。
set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-1}"
export AWS_REGION="$REGION" AWS_PAGER=""
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
FUNCTION="RAiM-TTS-SBV2-dev"
BUCKET="${BUCKET:-raim-tts-models-${ACCOUNT}}"
STAMP="$(date +%Y%m%d_%H%M%S)"
WORK="$(mktemp -d)"

log() { echo "[$(date +%H:%M:%S)] $*"; }
fail() { echo "!! $*" >&2; exit 1; }

[[ $# -gt 0 ]] || fail ".py を指定してください（bash cloudshell_update_code.sh raim_preprocess.py）"
for f in "$@"; do
  [[ -f "$f" && "$f" == *.py ]] || fail "$f がないか、.py ではありません"
  python3 -m py_compile "$f" || fail "$f に書きまちがいがあります"
done

# 1. 今のコード
log "今のコードを落とします"
URL="$(aws lambda get-function --function-name "$FUNCTION" --query Code.Location --output text)"
curl -sfo "$WORK/current.zip" "$URL" || fail "今のコードを落とせませんでした"
aws s3 cp "$WORK/current.zip" "s3://$BUCKET/code/old/raim_tts_sbv2_${STAMP}.zip" --only-show-errors
log "今のコードを s3://$BUCKET/code/old/raim_tts_sbv2_${STAMP}.zip に残しました"

# 2. 入れ替え
python3 - "$WORK/current.zip" "$WORK/new.zip" "$@" <<'PY' || fail "zip を作れませんでした"
import os, sys, zipfile
src, dst, files = sys.argv[1], sys.argv[2], sys.argv[3:]
replace = {os.path.basename(f): f for f in files}
with zipfile.ZipFile(src) as zin:
    names = set(zin.namelist())
    missing = [n for n in replace if n not in names]
    if missing:
        sys.exit("zip に無い名前です: " + ", ".join(missing))
    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for info in zin.infolist():
            if info.filename in replace:
                zout.write(replace[info.filename], info.filename)
                print(f"  入れ替え: {info.filename}")
            else:
                zout.writestr(info, zin.read(info.filename))
PY

# 3. 更新
KEY="code/raim_tts_sbv2_${STAMP}.zip"
aws s3 cp "$WORK/new.zip" "s3://$BUCKET/$KEY" --only-show-errors
aws lambda update-function-code --function-name "$FUNCTION" --s3-bucket "$BUCKET" --s3-key "$KEY" >/dev/null
aws lambda wait function-updated-v2 --function-name "$FUNCTION" 2>/dev/null \
  || aws lambda wait function-updated --function-name "$FUNCTION"
aws s3 rm "s3://$BUCKET/$KEY" --only-show-errors || true
log "関数のコードを更新しました"

# 4. 確かめる
call() {
  local name="$1" payload="$2"
  aws lambda invoke --function-name "$FUNCTION" --cli-binary-format raw-in-base64-out \
    --cli-read-timeout 300 --payload "$payload" "$WORK/$name.json" >/dev/null
  python3 - "$WORK/$name.json" "$name" <<'PY'
import json, sys
body = json.load(open(sys.argv[1]))
keys = ("ok", "cold", "audioByteLength", "code", "message")
print(f"  {sys.argv[2]}: " + "  ".join(f"{k}={body[k]}" for k in keys if k in body))
if not body.get("ok"):
    sys.exit(1)
PY
}
log "冷えた状態から温めます（15秒くらい）"
call warmup '{"schemaVersion":1,"type":"tts.warmup","reason":"code-update"}' \
  || fail "温めに失敗しました。上の行を貼ってください"
SAY="${SAY_TEXT:-バイト、毎日だと辛かったね。来月の一日からは少し休めるといいね。}"
log "読み上げを1回試します"
call say "$(python3 -c 'import json,sys; print(json.dumps({"schemaVersion":1,"type":"tts.synthesize","requestId":"update","chunkId":"update_chunk_0","text":sys.argv[1]}, ensure_ascii=False))' "$SAY")" \
  || fail "読み上げに失敗しました。上の行を貼ってください"
python3 -c 'import base64,json,sys; b=json.load(open(sys.argv[1])); open("update_check.wav","wb").write(base64.b64decode(b["audio"]))' "$WORK/say.json"
rm -rf "$WORK"
log "できました。声は update_check.wav（「$SAY」）"
