#!/bin/bash
# Scene 選択が狙いどおりか確かめる。入力は check_cases.txt（期待する Scene|入力）。
# raim_test で test_scene_selection.js が動く状態（npm install 済み）で実行する。
dir="$(cd "$(dirname "$0")" && pwd)"
cd "$dir/.."
ok=0; ng=0
while IFS='|' read -r expected text; do
  case "$expected" in ''|\#*) continue ;; esac
  out=$(node test_scene_selection.js "$text" 2>/dev/null)
  got=$(echo "$out" | awk '/^Selected Scene/{f=1} f && /sceneId/{print $NF; exit}')
  score=$(echo "$out" | awk '/best score/{print $NF; exit}')
  if [ "$got" = "$expected" ]; then mark="OK "; ok=$((ok+1)); else mark="NG "; ng=$((ng+1)); fi
  printf '%s %-10s -> %-10s %s  %s\n' "$mark" "$expected" "${got:-?}" "${score:-?}" "$text"
done < "$dir/check_cases.txt"
echo "OK: $ok / NG: $ng"
