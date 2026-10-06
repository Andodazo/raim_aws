#!/bin/bash
# RAiM-FewShot-dev の few_shots（bright 用）と few_shots_downer（downer 用）を書き換える。
# textCentroid / embedding_text / default_emotions には触れない。
set -e
TABLE=RAiM-FewShot-dev
REGION=ap-northeast-1

# 念のため今の中身を控えておく
aws dynamodb scan --table-name $TABLE --region $REGION \
  --projection-expression "id, few_shots" > fewshot_backup_$(date +%Y%m%d%H%M).json

for id in default joke tired gaming; do
  aws dynamodb update-item --table-name $TABLE --region $REGION \
    --key "{\"id\":{\"S\":\"$id\"}}" \
    --update-expression "SET few_shots = :b, few_shots_downer = :d" \
    --expression-attribute-values file://$id.json
  echo "updated: $id"
done
