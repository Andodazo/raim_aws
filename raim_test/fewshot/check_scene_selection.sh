#!/bin/bash
# Scene 選択が狙いどおりか確かめる。左が期待する Scene、右が入力。
# raim_test で test_scene_selection.js が動く状態（npm install 済み）で実行する。
cd "$(dirname "$0")/.."
while IFS='|' read -r expected text; do
  [ -z "$expected" ] && continue
  got=$(node test_scene_selection.js "$text" 2>/dev/null | awk '/^Selected Scene/{f=1} f && /sceneId/{print $NF; exit}')
  mark=$([ "$got" = "$expected" ] && echo "OK " || echo "NG ")
  printf '%s %-10s -> %-10s %s\n' "$mark" "$expected" "${got:-?}" "$text"
done <<'LIST'
default|こんにちは
question|ブラックホールって何？
good_news|内定もらえた！
sad_news|昨日、彼女に振られた
unfair|先輩に理不尽に怒られてムカつく
surprise|実は来週引っ越すことになった
tired|今日バイトで疲れた
praise|ライムっていつも優しいね
gaming|新しいRPG買った
share|最近ボルダリング始めたんだ
joke|面白い話して
advice|どっちのバイトにするか迷ってる
play|しりとりしよう
LIST
