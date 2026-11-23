#!/usr/bin/env bash
# 自作の声の TTS Lambda を、CloudShell から一括でテストする。
#
# やること:
#   1. function.zip を S3 に上げて、関数のコードを差し替える（zip を渡したときだけ）
#   2. MODEL_DOWNLOAD_PARALLEL を 1 → 8 → 1 → 8 と変えながら、冷えた状態から温め（tts.warmup）を流し、
#      S3 から落とす時間（downloadSec）と読み込み時間（loadSec）を測る
#   3. 本番と同じ形のリクエスト（感情つき）で声が作れるか確かめる
#   4. 結果を表にして出す（results_<時刻>.txt にも保存）
#
# 使い方（CloudShell で。右上の「アクション → ファイルのアップロード」で zip とこのファイルを上げてから）:
#   bash cloudshell_test.sh function.zip
#   bash cloudshell_test.sh            # コードは差し替えず、今の関数のまま測る
#
# 関数・バケットを変えるとき:
#   FUNCTION=raim-tts-sbv2-test BUCKET=raim-tts-sbv2-test-990442281360 bash cloudshell_test.sh function.zip
#
# 本番の RAiM-* の関数には使わないこと（環境変数を書き換えるため）。
set -euo pipefail

FUNCTION="${FUNCTION:-raim-tts-sbv2-test}"
BUCKET="${BUCKET:-raim-tts-sbv2-test-990442281360}"
ZIP="${1:-}"
ROUNDS="${ROUNDS:-1 8 1 8}"
REGION="${AWS_REGION:-ap-northeast-1}"
export AWS_REGION="$REGION" AWS_PAGER=""

case "$FUNCTION" in
  RAiM-*) echo "本番の関数（$FUNCTION）には使えません" >&2; exit 1 ;;
esac

WORK="$(mktemp -d)"
STAMP="$(date +%Y%m%d_%H%M%S)"
RESULT="results_${STAMP}.txt"
trap 'rm -rf "$WORK"' EXIT

log() { echo "[$(date +%H:%M:%S)] $*"; }

wait_updated() {
  aws lambda wait function-updated-v2 --function-name "$FUNCTION" 2>/dev/null \
    || aws lambda wait function-updated --function-name "$FUNCTION"
}

set_env() {
  local parallel="$1"
  aws lambda update-function-configuration --function-name "$FUNCTION" \
    --handler handler.handler \
    --environment "Variables={MODEL_S3_BUCKET=${BUCKET},MODEL_DOWNLOAD_PARALLEL=${parallel}}" \
    >/dev/null
  wait_updated
}

# invoke <名前> <payload JSON> → $WORK/<名前>.json（返事）と $WORK/<名前>.log（ログの最後）
invoke() {
  local name="$1" payload="$2" start end
  start=$(date +%s.%N)
  aws lambda invoke --function-name "$FUNCTION" \
    --cli-binary-format raw-in-base64-out \
    --cli-read-timeout 300 \
    --log-type Tail \
    --payload "$payload" \
    "$WORK/$name.json" > "$WORK/$name.meta"
  end=$(date +%s.%N)
  python3 - "$WORK/$name.meta" "$WORK/$name.log" <<'PY'
import base64, json, sys
meta = json.load(open(sys.argv[1]))
open(sys.argv[2], "w").write(base64.b64decode(meta.get("LogResult", "")).decode("utf-8", "replace"))
PY
  echo "$start $end" > "$WORK/$name.time"
}

# 返事とログから1行の結果を作る
summarize() {
  local name="$1" label="$2"
  python3 - "$WORK/$name.json" "$WORK/$name.log" "$WORK/$name.time" "$label" <<'PY'
import json, re, sys
body = json.load(open(sys.argv[1]))
log = open(sys.argv[2]).read()
start, end = (float(x) for x in open(sys.argv[3]).read().split())
init = re.search(r"Init Duration: ([\d.]+) ms", log)
duration = re.search(r"\tDuration: ([\d.]+) ms", log)
memory = re.search(r"Max Memory Used: (\d+) MB", log)
parts = [
    f"{sys.argv[4]:<22}",
    f"ok={body.get('ok')}",
]
if body.get("type") == "tts.warmed":
    parts += [f"cold={body.get('cold')}", f"download={body.get('downloadSec')}s", f"load={body.get('loadSec')}s"]
elif body.get("ok"):
    parts += [f"audioBytes={body.get('audioByteLength')}", f"audioSec≈{body.get('audioByteLength', 0) / 88200:.1f}"]
else:
    parts += [f"code={body.get('code')}", f"retriable={body.get('retriable')}"]
parts += [
    f"lambda={float(duration.group(1)) / 1000:.2f}s" if duration else "lambda=?",
    f"init={float(init.group(1)) / 1000:.2f}s" if init else "init=-",
    f"wall={end - start:.2f}s",
    f"mem={memory.group(1)}MB" if memory else "mem=?",
]
print("  ".join(parts))
errors = [line for line in log.splitlines() if "Error" in line or "Traceback" in line or "failed" in line]
for line in errors[-5:]:
    print("    ! " + line[:200])
PY
}

{
  echo "自作の声の TTS テスト  $STAMP"
  echo "関数: $FUNCTION  バケット: $BUCKET  リージョン: $REGION"
  echo
} | tee "$RESULT"

# 1. コードの差し替え
if [[ -n "$ZIP" ]]; then
  [[ -f "$ZIP" ]] || { echo "$ZIP がありません" >&2; exit 1; }
  KEY="code/raim_tts_sbv2_${STAMP}.zip"
  log "zip を s3://$BUCKET/$KEY に上げます（$(du -h "$ZIP" | cut -f1)）"
  aws s3 cp "$ZIP" "s3://$BUCKET/$KEY" --only-show-errors
  log "関数のコードを差し替えます"
  aws lambda update-function-code --function-name "$FUNCTION" --s3-bucket "$BUCKET" --s3-key "$KEY" >/dev/null
  wait_updated
  aws s3 rm "s3://$BUCKET/$KEY" --only-show-errors || true
fi

aws lambda get-function-configuration --function-name "$FUNCTION" \
  --query '{arch:Architectures[0],memory:MemorySize,tmp:EphemeralStorage.Size,timeout:Timeout,runtime:Runtime}' \
  --output text | sed 's/^/設定（arch memory runtime timeout tmp）: /' | tee -a "$RESULT"
echo | tee -a "$RESULT"

# 2. 分割ダウンロードの比べ
echo "■ 冷えた状態からの温め（MODEL_DOWNLOAD_PARALLEL を変えるたびに冷えた状態になる）" | tee -a "$RESULT"
i=0
for parallel in $ROUNDS; do
  i=$((i + 1))
  log "MODEL_DOWNLOAD_PARALLEL=$parallel にして温めます（$i 回目）"
  set_env "$parallel"
  invoke "warm_${i}_cold" '{"schemaVersion":1,"type":"tts.warmup","reason":"cloudshell-test"}'
  summarize "warm_${i}_cold" "P=$parallel 冷えた状態" | tee -a "$RESULT"
  invoke "warm_${i}_again" '{"schemaVersion":1,"type":"tts.warmup","reason":"cloudshell-test"}'
  summarize "warm_${i}_again" "P=$parallel 2回目" | tee -a "$RESULT"
done
echo | tee -a "$RESULT"

# 3. 本番と同じ形のリクエスト（温まった状態）
echo "■ 読み上げ（温まった状態）" | tee -a "$RESULT"
SAMPLES=(
  'happy+照れ|{"schemaVersion":1,"type":"tts.synthesize","requestId":"cs-1","chunkId":"cs-1_chunk_0","text":"えっ、そんなに褒められると照れるんだけど。","voiceParams":{"speaker_id":8,"emotionMix":{"happy":0.6,"embarrassed":0.3},"emotionIntensity":0.8}}'
  'sad+caring|{"schemaVersion":1,"type":"tts.synthesize","requestId":"cs-2","chunkId":"cs-2_chunk_0","text":"そっか、今日はもう休も。","voiceParams":{"speaker_id":8,"emotionMix":{"sad":0.5,"caring":0.4},"emotionIntensity":1.0}}'
  'excited 長め|{"schemaVersion":1,"type":"tts.synthesize","requestId":"cs-3","chunkId":"cs-3_chunk_0","text":"明日は25℃で晴れだって！せっかくだし、どこか出かけようよ。","voiceParams":{"speaker_id":8,"emotionMix":{"excited":0.8},"emotionIntensity":0.9}}'
  'VOICEVOX の値だけ|{"schemaVersion":1,"type":"tts.synthesize","requestId":"cs-4","chunkId":"cs-4_chunk_0","text":"ライムだよ。よろしくね。","voiceParams":{"speaker_id":8,"speedScale":1.0}}'
  'www だけ（エラーが正しい）|{"schemaVersion":1,"type":"tts.synthesize","requestId":"cs-5","chunkId":"cs-5_chunk_0","text":"www","voiceParams":{}}'
)
n=0
for sample in "${SAMPLES[@]}"; do
  n=$((n + 1))
  label="${sample%%|*}"
  payload="${sample#*|}"
  invoke "say_$n" "$payload"
  summarize "say_$n" "$label" | tee -a "$RESULT"
  python3 - "$WORK/say_$n.json" "say_${n}_${STAMP}.wav" <<'PY'
import base64, json, sys
body = json.load(open(sys.argv[1]))
if body.get("ok") and body.get("audio"):
    open(sys.argv[2], "wb").write(base64.b64decode(body["audio"]))
PY
done
echo | tee -a "$RESULT"

# 4. ログの [TTS] 行（文の中身は出ない）
echo "■ ログの [TTS] 行" | tee -a "$RESULT"
cat "$WORK"/*.log | grep "\[TTS\]" | tee -a "$RESULT" || true

# 後片付け：PARALLEL を既定（8）に戻す
set_env 8
echo
log "おわり。結果は $RESULT、音声は say_*_${STAMP}.wav（右上の「アクション → ファイルのダウンロード」で取れる）"
