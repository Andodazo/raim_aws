#!/usr/bin/env bash
# ライム用の読み辞書（raim_user_dict.csv）だけを入れ替える（zip は作り直さない）。
#
# やること:
#   1. csv の形を確かめる（列の数・アクセントの書き方・文字コード）。おかしければ何もしないで止まる
#   2. 今の辞書を dict/old/ に残してから、s3://<バケット>/dict/raim_user_dict.csv を上書きする
#   3. 関数の環境変数 USER_DICT_S3_KEY を入れ、DICT_VERSION を変えて実行環境を作り直す（ほかの環境変数はそのまま）
#   4. 冷えた状態から温めて、S3 の辞書が使われたかをログで確かめる
#
# 使い方（直した raim_user_dict.csv とこのファイルを CloudShell に上げてから）:
#   bash cloudshell_update_dict.sh raim_user_dict.csv
#
# S3 の辞書が壊れていても、関数は zip に入れた辞書で動く（声は止まらない）。
set -euo pipefail

CSV="${1:-}"
REGION="${AWS_REGION:-ap-northeast-1}"
export AWS_REGION="$REGION" AWS_PAGER=""
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
FUNCTION="RAiM-TTS-SBV2-dev"
BUCKET="${BUCKET:-raim-tts-models-${ACCOUNT}}"
KEY="dict/raim_user_dict.csv"
STAMP="$(date +%Y%m%d_%H%M%S)"

log() { echo "[$(date +%H:%M:%S)] $*"; }
fail() { echo "!! $*" >&2; exit 1; }

[[ -n "$CSV" && -f "$CSV" ]] || fail "csv を指定してください（bash cloudshell_update_dict.sh raim_user_dict.csv）"

# 1. csv の形
python3 - "$CSV" <<'PY' || fail "csv の形がおかしいので、上げずに止めました"
import csv, re, sys
raw = open(sys.argv[1], "rb").read()
if raw.startswith(b"\xef\xbb\xbf"):
    sys.exit("先頭に BOM があります。BOM なしの UTF-8 で保存してください")
try:
    text = raw.decode("utf-8")
except UnicodeDecodeError:
    sys.exit("UTF-8 ではありません（Shift_JIS で保存していませんか）")
bad = []
rows = list(csv.reader(text.splitlines()))
for n, row in enumerate(rows, 1):
    if not row:
        continue
    if len(row) != 15:
        bad.append(f"{n}行目: 列が {len(row)} 個（15 個のはず）")
        continue
    surface, reading, pron, accent = row[0], row[11], row[12], row[13]
    m = re.fullmatch(r"(\d+)/(\d+)", accent)
    if not m:
        bad.append(f"{n}行目 {surface}: アクセントが「{accent}」（例: 2/3）")
    elif int(m.group(1)) > int(m.group(2)):
        bad.append(f"{n}行目 {surface}: 下がる位置 {m.group(1)} が拍の数 {m.group(2)} より大きい")
    if not re.fullmatch(r"[ァ-ヴー]+", reading) or not re.fullmatch(r"[ァ-ヴー]+", pron):
        bad.append(f"{n}行目 {surface}: 読みがカタカナではない（{reading} / {pron}）")
for line in bad:
    print("  " + line)
if bad:
    sys.exit(1)
print(f"  {sum(1 for r in rows if r)} 語、形は OK")
PY

# 2. 上げる（今のものは残す）
if aws s3api head-object --bucket "$BUCKET" --key "$KEY" >/dev/null 2>&1; then
  aws s3 cp "s3://$BUCKET/$KEY" "s3://$BUCKET/dict/old/raim_user_dict_${STAMP}.csv" --only-show-errors
  log "今の辞書を s3://$BUCKET/dict/old/raim_user_dict_${STAMP}.csv に残しました"
fi
aws s3 cp "$CSV" "s3://$BUCKET/$KEY" --content-type "text/csv; charset=utf-8" --only-show-errors
log "s3://$BUCKET/$KEY を上書きしました"

# 3. 環境変数（ほかの値は残して、USER_DICT_S3_KEY と DICT_VERSION だけ変える）
aws lambda get-function-configuration --function-name "$FUNCTION" --query 'Environment.Variables' --output json > /tmp/env_now.json
python3 - "$KEY" "$STAMP" <<'PY' > /tmp/env_new.json
import json, sys
env = json.load(open("/tmp/env_now.json")) or {}
env["USER_DICT_S3_KEY"] = sys.argv[1]
env["DICT_VERSION"] = sys.argv[2]
print(json.dumps({"Variables": env}))
PY
aws lambda update-function-configuration --function-name "$FUNCTION" --environment file:///tmp/env_new.json >/dev/null
aws lambda wait function-updated-v2 --function-name "$FUNCTION" 2>/dev/null \
  || aws lambda wait function-updated --function-name "$FUNCTION"
log "関数の設定を更新しました（次の呼び出しから新しい辞書）"

# 4. 確かめる
log "冷えた状態から温めます（15秒くらい）"
aws lambda invoke --function-name "$FUNCTION" --cli-binary-format raw-in-base64-out --cli-read-timeout 300 \
  --log-type Tail --query LogResult --output text \
  --payload '{"schemaVersion":1,"type":"tts.warmup","reason":"dict-update"}' /tmp/dict_warm.json \
  | base64 -d > /tmp/dict_warm.log
python3 -c 'import json; b=json.load(open("/tmp/dict_warm.json")); print("  ok=%s cold=%s" % (b.get("ok"), b.get("cold")))'
if grep -q "user dict: s3" /tmp/dict_warm.log; then
  log "できました。S3 の辞書で動いています"
elif grep -q "user dict" /tmp/dict_warm.log; then
  grep "user dict" /tmp/dict_warm.log | sed 's/^/  /'
  fail "S3 の辞書が使われませんでした（zip の辞書で動いています）。上の行を貼ってください"
else
  log "（ログに辞書の行がありませんでした。古い zip のままかもしれません。温めは ok なら動作には問題ありません）"
fi
