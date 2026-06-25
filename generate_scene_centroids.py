#!/usr/bin/env python3
"""RAiMのScene例文からTitan Text Embeddings V2のtextCentroidを生成する。

AWS CloudShellで実行することを想定した運用スクリプト。
RAiM-FewShot-devをScanし、各Sceneの例文を1件ずつTitan V2でEmbeddingした後、
各次元の平均を取ってL2正規化した代表ベクトルをtextCentroidへ保存する。

対応する例文属性（先に見つかったものを使用）:
  1. text_examples  現在のCore Lambdaで推奨する属性
  2. examples       既存データとの互換属性
  3. example        単数名で登録済みの場合の互換属性

安全のため、--applyを付けない実行はDynamoDBを更新しないdry-runになる。
既存のtextCentroidがあるSceneは、--forceを付けない限り上書きしない。

CloudShellで必要なIAM権限:
  - dynamodb:Scan
  - dynamodb:UpdateItem
  - bedrock:InvokeModel

実行例:
  python3 generate_scene_centroids.py
  python3 generate_scene_centroids.py --apply
  python3 generate_scene_centroids.py --apply --scene-id gaming
  python3 generate_scene_centroids.py --apply --force
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any, Iterable, Optional, Tuple

import boto3
from botocore.config import Config
from botocore.exceptions import BotoCoreError, ClientError


DEFAULT_TABLE_NAME = "RAiM-FewShot-dev"
DEFAULT_REGION = "ap-northeast-1"
DEFAULT_MODEL_ID = "amazon.titan-embed-text-v2:0"
VALID_DIMENSIONS = (1024, 512, 256)


def parse_arguments() -> argparse.Namespace:
    """CloudShellから受け取る実行オプションを定義する。"""

    default_region = os.environ.get("AWS_REGION", DEFAULT_REGION)

    parser = argparse.ArgumentParser(
        description=(
            "DynamoDBのScene例文をTitan Text Embeddings V2でEmbeddingし、"
            "平均ベクトルをtextCentroidへ保存します。"
        )
    )
    parser.add_argument(
        "--table-name",
        default=DEFAULT_TABLE_NAME,
        help=f"Sceneテーブル名（既定値: {DEFAULT_TABLE_NAME}）",
    )
    parser.add_argument(
        "--region",
        default=default_region,
        help="DynamoDBテーブルのAWSリージョン（既定値: AWS_REGION）",
    )
    parser.add_argument(
        "--bedrock-region",
        default=default_region,
        help="Titanを呼び出すAWSリージョン（既定値: AWS_REGION）",
    )
    parser.add_argument(
        "--model-id",
        default=DEFAULT_MODEL_ID,
        help=f"Titan model ID（既定値: {DEFAULT_MODEL_ID}）",
    )
    parser.add_argument(
        "--dimensions",
        type=int,
        choices=VALID_DIMENSIONS,
        default=1024,
        help="Embeddingの次元数。Core Lambdaの設定と一致させます（既定値: 1024）",
    )
    parser.add_argument(
        "--scene-id",
        action="append",
        dest="scene_ids",
        help="処理対象Scene ID。複数指定可能。未指定時は全Sceneを処理します。",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="生成したtextCentroidをDynamoDBへ保存します。未指定時はdry-runです。",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="既存のtextCentroidを再生成して上書きします。",
    )
    return parser.parse_args()


def scan_all_scenes(table: Any) -> list[dict[str, Any]]:
    """1 MBを超えるテーブルにも対応し、ページングしながら全Sceneを取得する。"""

    scenes: list[dict[str, Any]] = []
    scan_arguments: dict[str, Any] = {}

    while True:
        response = table.scan(**scan_arguments)
        scenes.extend(response.get("Items", []))

        last_key = response.get("LastEvaluatedKey")
        if not last_key:
            return scenes

        scan_arguments["ExclusiveStartKey"] = last_key


def normalize_examples(scene: dict[str, Any]) -> Tuple[Optional[str], list[str]]:
    """Scene Itemから例文属性を探し、空文字を除いた文字列配列へ揃える。"""

    for attribute_name in ("text_examples", "examples", "example"):
        if attribute_name not in scene:
            continue

        raw_value = scene[attribute_name]
        values: Iterable[Any]

        if isinstance(raw_value, list):
            values = raw_value
        elif isinstance(raw_value, str):
            # exampleが単一文字列で保存されている場合も1件の例文として扱う。
            values = [raw_value]
        else:
            print(
                f"  警告: {attribute_name}は文字列またはListではないため無視します。",
                file=sys.stderr,
            )
            return attribute_name, []

        # 数値やnullを意図せず例文へ変換しない。文字列だけをEmbedding対象にする。
        examples = [value.strip() for value in values if isinstance(value, str) and value.strip()]
        return attribute_name, examples

    return None, []


def invoke_titan_embedding(
    bedrock_client: Any,
    text: str,
    model_id: str,
    dimensions: int,
) -> list[float]:
    """例文1件をTitan Text Embeddings V2へ送り、floatベクトルを検証して返す。"""

    request_body = {
        "inputText": text,
        "dimensions": dimensions,
        "normalize": True,
        "embeddingTypes": ["float"],
    }
    response = bedrock_client.invoke_model(
        modelId=model_id,
        contentType="application/json",
        accept="application/json",
        body=json.dumps(request_body, ensure_ascii=False).encode("utf-8"),
    )
    payload = json.loads(response["body"].read())
    embedding = payload.get("embedding")

    # Titanの応答形式差を吸収するため、embeddingsByType.floatも受け付ける。
    if not isinstance(embedding, list):
        embedding = payload.get("embeddingsByType", {}).get("float")

    if not isinstance(embedding, list) or len(embedding) != dimensions:
        received = len(embedding) if isinstance(embedding, list) else "なし"
        raise ValueError(
            f"Titan embeddingの次元が不正です: expected={dimensions}, received={received}"
        )

    vector = [float(value) for value in embedding]
    if not all(math.isfinite(value) for value in vector):
        raise ValueError("Titan embeddingに有限値でない要素が含まれています。")

    return vector


def calculate_normalized_centroid(embeddings: list[list[float]]) -> list[float]:
    """複数Embeddingの次元別平均を求め、コサイン類似度用にL2正規化する。"""

    if not embeddings:
        raise ValueError("centroidの計算には1件以上のEmbeddingが必要です。")

    dimensions = len(embeddings[0])
    if any(len(vector) != dimensions for vector in embeddings):
        raise ValueError("Embedding間で次元数が一致していません。")

    centroid = [
        sum(vector[index] for vector in embeddings) / len(embeddings)
        for index in range(dimensions)
    ]
    norm = math.sqrt(sum(value * value for value in centroid))

    if not math.isfinite(norm) or norm == 0:
        raise ValueError("平均ベクトルを正規化できません。")

    return [value / norm for value in centroid]


def to_dynamodb_numbers(vector: list[float]) -> list[Decimal]:
    """boto3 DynamoDB Resourceが保存可能なDecimalへfloatを変換する。"""

    # Decimal(float)は二進浮動小数点の誤差を長く保持するため、文字列経由にする。
    return [Decimal(str(value)) for value in vector]


def update_scene_centroid(
    table: Any,
    scene_id: str,
    centroid: list[float],
    model_id: str,
    dimensions: int,
    example_count: int,
    example_attribute: str,
) -> None:
    """centroid本体と、後から再生成条件を判断するためのメタデータを保存する。"""

    updated_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    table.update_item(
        Key={"id": scene_id},
        UpdateExpression=(
            "SET textCentroid = :centroid, "
            "textCentroidModelId = :modelId, "
            "textCentroidDimensions = :dimensions, "
            "textCentroidExampleCount = :exampleCount, "
            "textCentroidExampleAttribute = :exampleAttribute, "
            "textCentroidUpdatedAt = :updatedAt"
        ),
        ExpressionAttributeValues={
            ":centroid": to_dynamodb_numbers(centroid),
            ":modelId": model_id,
            ":dimensions": dimensions,
            ":exampleCount": example_count,
            ":exampleAttribute": example_attribute,
            ":updatedAt": updated_at,
        },
    )


def main() -> int:
    args = parse_arguments()

    # CloudShellの一時的なAPI制限にも耐えやすいよう、SDK標準retryを明示する。
    retry_config = Config(retries={"max_attempts": 8, "mode": "standard"})
    dynamodb = boto3.resource("dynamodb", region_name=args.region, config=retry_config)
    bedrock = boto3.client(
        "bedrock-runtime",
        region_name=args.bedrock_region,
        config=retry_config,
    )
    table = dynamodb.Table(args.table_name)

    print("RAiM Scene centroid generator")
    print(f"  mode             : {'APPLY' if args.apply else 'DRY-RUN'}")
    print(f"  table            : {args.table_name} ({args.region})")
    print(f"  Titan            : {args.model_id} ({args.bedrock_region})")
    print(f"  dimensions       : {args.dimensions}")
    print(f"  overwrite        : {args.force}")

    scenes = scan_all_scenes(table)
    requested_ids = set(args.scene_ids or [])
    if requested_ids:
        scenes = [scene for scene in scenes if str(scene.get("id", "")) in requested_ids]
        found_ids = {str(scene.get("id", "")) for scene in scenes}
        missing_ids = requested_ids - found_ids
        if missing_ids:
            print(f"警告: Sceneが見つかりません: {', '.join(sorted(missing_ids))}")

    print(f"  target scenes    : {len(scenes)}")
    updated_count = 0
    skipped_count = 0
    failed_count = 0

    for scene in scenes:
        scene_id = str(scene.get("id", "")).strip()
        print(f"\n[{scene_id or '<idなし>'}]")

        if not scene_id:
            print("  skip: idがありません。")
            skipped_count += 1
            continue

        if isinstance(scene.get("textCentroid"), list) and not args.force:
            print("  skip: textCentroidは登録済みです。再生成する場合は--forceを付けます。")
            skipped_count += 1
            continue

        example_attribute, examples = normalize_examples(scene)
        if not example_attribute or not examples:
            print("  skip: text_examples / examples / exampleに有効な例文がありません。")
            skipped_count += 1
            continue

        print(f"  source: {example_attribute} ({len(examples)}件)")

        try:
            embeddings = []
            for index, example in enumerate(examples, start=1):
                print(f"  embedding {index}/{len(examples)}: {example[:60]}")
                embeddings.append(
                    invoke_titan_embedding(
                        bedrock,
                        example,
                        args.model_id,
                        args.dimensions,
                    )
                )

            centroid = calculate_normalized_centroid(embeddings)
            print(
                "  generated: "
                f"dimensions={len(centroid)}, "
                f"norm={math.sqrt(sum(value * value for value in centroid)):.6f}"
            )

            if args.apply:
                update_scene_centroid(
                    table,
                    scene_id,
                    centroid,
                    args.model_id,
                    args.dimensions,
                    len(examples),
                    example_attribute,
                )
                print("  saved: DynamoDBのtextCentroidを更新しました。")
            else:
                print("  dry-run: DynamoDBは更新していません。保存する場合は--applyを付けます。")

            updated_count += 1
        except (BotoCoreError, ClientError, ValueError, KeyError, json.JSONDecodeError) as error:
            print(f"  error: {error}", file=sys.stderr)
            failed_count += 1

    print("\n完了")
    print(f"  generated: {updated_count}")
    print(f"  skipped  : {skipped_count}")
    print(f"  failed   : {failed_count}")
    return 1 if failed_count else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("\n中断しました。", file=sys.stderr)
        raise SystemExit(130)
