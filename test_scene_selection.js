#!/usr/bin/env node
/**
 * RAiM Core Lambdaの「ユーザー入力をEmbeddingして適切なSceneを選ぶ部分」だけを
 * 実AWS上で確認するためのCloudShell用テストスクリプト。
 *
 * ============================================================================
 * 1. このスクリプトで確認できること
 * ============================================================================
 *
 * Core Lambda本体を実行する前に、Scene選択に必要な次の流れだけを単独で確認します。
 *
 *   1. DynamoDBの `RAiM-FewShot-dev` からScene一覧を取得する
 *   2. ユーザー入力テキストをTitan Text Embeddings V2でEmbeddingする
 *   3. 各Sceneの `textCentroid` とユーザー入力Embeddingのコサイン類似度を計算する
 *   4. 類似度が最も高く、閾値以上のSceneを選ぶ
 *
 * Mantleは呼びません。
 * そのため、Mantle API Key / Secrets Manager / WebSocket / SQS などに関係なく、
 * 「Scene選択だけが正しく動くか」を切り分けて確認できます。
 *
 * ============================================================================
 * 2. 前提となるFewShotテーブル形式
 * ============================================================================
 *
 * 各Sceneアイテムには、最低限次が必要です。
 *
 * - id
 *   Scene ID。例: "joke", "tired", "gaming", "default"
 *
 * - embedding_text
 *   Sceneを表す代表テキスト。
 *   このスクリプトでは表示用に使います。
 *
 * - textCentroid
 *   `embedding_text` をTitan Text Embeddings V2でEmbeddingしたベクトル。
 *   事前に `generate_scene_centroids.js --apply` で作成しておく必要があります。
 *
 * `textCentroid` が無いSceneは比較対象から除外されます。
 *
 * ============================================================================
 * 3. CloudShellでの実行手順
 * ============================================================================
 *
 * Step 1: このファイルをCloudShellへアップロードする
 *
 *   CloudShell右上の `Actions` -> `Upload file` から、
 *   `test_scene_selection.js` をアップロードします。
 *
 * Step 2: 依存パッケージをインストールする
 *
 *   このスクリプトはAWS SDK for JavaScript v3を使います。
 *
 *     npm install @aws-sdk/client-dynamodb @aws-sdk/client-bedrock-runtime
 *
 * Step 3: ユーザー入力を指定して実行する
 *
 *     node test_scene_selection.js "つまんないダジャレ言うぞ"
 *
 *   結果として、選ばれたSceneと、全Sceneの類似度ランキングが表示されます。
 *
 * Step 4: 別の入力でも試す
 *
 *     node test_scene_selection.js "マイクラのMOD入れた"
 *     node test_scene_selection.js "今日は疲れた"
 *     node test_scene_selection.js "なんとなく話したい"
 *
 * ============================================================================
 * 4. よく使うオプション
 * ============================================================================
 *
 * DynamoDB / Bedrockのリージョンを明示する:
 *
 *     node test_scene_selection.js "笑わせて" \
 *       --region ap-northeast-1 \
 *       --bedrock-region ap-northeast-1
 *
 * 類似度閾値を変える:
 *
 *     node test_scene_selection.js "笑わせて" --threshold 0.2
 *
 * 上位N件だけ表示する:
 *
 *     node test_scene_selection.js "笑わせて" --top 3
 *
 * Titanの次元数を変える:
 *
 *     node test_scene_selection.js "笑わせて" --dimensions 1024
 *
 * 注意:
 * `--dimensions` は `generate_scene_centroids.js` で `textCentroid` を作った次元数と
 * 必ず一致させてください。違う次元数だと比較できません。
 *
 * ============================================================================
 * 5. 必要なIAM権限
 * ============================================================================
 *
 * - dynamodb:Scan
 *   FewShotテーブルからScene一覧を読むために必要です。
 *
 * - bedrock:InvokeModel
 *   Titan Text Embeddings V2でユーザー入力をEmbeddingするために必要です。
 */

const { DynamoDBClient, ScanCommand } = require("@aws-sdk/client-dynamodb");
const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");

const DEFAULT_TABLE_NAME = "RAiM-FewShot-dev";
const DEFAULT_REGION = process.env.AWS_REGION || "ap-northeast-1";
const DEFAULT_MODEL_ID = "amazon.titan-embed-text-v2:0";
const DEFAULT_DIMENSIONS = 1024;
const DEFAULT_THRESHOLD = 0.25;
const DEFAULT_SCENE_ID = "default";

function parseArgs(argv) {
  const options = {
    userText: "",
    tableName: DEFAULT_TABLE_NAME,
    region: DEFAULT_REGION,
    bedrockRegion: DEFAULT_REGION,
    modelId: DEFAULT_MODEL_ID,
    dimensions: DEFAULT_DIMENSIONS,
    threshold: DEFAULT_THRESHOLD,
    defaultSceneId: DEFAULT_SCENE_ID,
    top: 10,
  };

  const textParts = [];

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--table-name") {
      options.tableName = readValue(argv, ++i, arg);
    } else if (arg === "--region") {
      options.region = readValue(argv, ++i, arg);
    } else if (arg === "--bedrock-region") {
      options.bedrockRegion = readValue(argv, ++i, arg);
    } else if (arg === "--model-id") {
      options.modelId = readValue(argv, ++i, arg);
    } else if (arg === "--dimensions") {
      options.dimensions = Number(readValue(argv, ++i, arg));
    } else if (arg === "--threshold") {
      options.threshold = Number(readValue(argv, ++i, arg));
    } else if (arg === "--default-scene-id") {
      options.defaultSceneId = readValue(argv, ++i, arg);
    } else if (arg === "--top") {
      options.top = Number(readValue(argv, ++i, arg));
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      textParts.push(arg);
    }
  }

  options.userText = textParts.join(" ").trim();

  if (!options.userText) {
    throw new Error("ユーザー入力テキストを指定してください。例: node test_scene_selection.js \"笑わせて\"");
  }

  if (!Number.isInteger(options.dimensions) || ![1024, 512, 256].includes(options.dimensions)) {
    throw new Error("--dimensions must be one of 1024, 512, or 256");
  }

  if (!Number.isFinite(options.threshold) || options.threshold < -1 || options.threshold > 1) {
    throw new Error("--threshold must be between -1 and 1");
  }

  if (!Number.isInteger(options.top) || options.top <= 0) {
    throw new Error("--top must be a positive integer");
  }

  return options;
}

function readValue(argv, index, optionName) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function printHelp() {
  console.log(`RAiM Scene selection tester

Usage:
  node test_scene_selection.js "つまんないダジャレ言うぞ"

Options:
  --table-name NAME          DynamoDB table name. Default: ${DEFAULT_TABLE_NAME}
  --region REGION            DynamoDB region. Default: AWS_REGION or ap-northeast-1
  --bedrock-region REGION    Titan invoke region. Default: same as --region
  --model-id MODEL_ID        Titan model ID. Default: ${DEFAULT_MODEL_ID}
  --dimensions N             Embedding dimensions: 1024, 512, or 256. Default: 1024
  --threshold N              Similarity threshold. Default: ${DEFAULT_THRESHOLD}
  --default-scene-id ID      Fallback scene ID. Default: default
  --top N                    Ranking count to print. Default: 10
`);
}

async function main() {
  const options = parseArgs(process.argv);
  const dynamodb = new DynamoDBClient({ region: options.region });
  const bedrock = new BedrockRuntimeClient({ region: options.bedrockRegion });

  console.log("RAiM Scene selection tester");
  console.log(`  user text      : ${options.userText}`);
  console.log(`  table          : ${options.tableName} (${options.region})`);
  console.log(`  Titan          : ${options.modelId} (${options.bedrockRegion})`);
  console.log(`  dimensions     : ${options.dimensions}`);
  console.log(`  threshold      : ${options.threshold}`);
  console.log(`  default scene  : ${options.defaultSceneId}`);

  const scenes = await loadScenes(dynamodb, options);
  const candidates = scenes.filter((scene) => isFiniteVector(scene.textCentroid));

  console.log(`  loaded scenes  : ${scenes.length}`);
  console.log(`  candidates     : ${candidates.length}`);

  if (candidates.length === 0) {
    throw new Error("textCentroidを持つSceneがありません。先に generate_scene_centroids.js --apply を実行してください。");
  }

  // Core Lambda本体と同じく、ユーザー入力をTitanでEmbeddingする。
  // ここで生成したベクトルとDynamoDB上のtextCentroidを比較する。
  const userEmbedding = await embedText(bedrock, options, options.userText);

  // 各Sceneとのコサイン類似度を計算し、高い順に並べる。
  const ranked = candidates
    .map((scene) => ({
      scene,
      score: cosineSimilarity(userEmbedding, scene.textCentroid),
    }))
    .filter((item) => Number.isFinite(item.score))
    .sort((left, right) => right.score - left.score);

  if (ranked.length === 0) {
    throw new Error("ユーザー入力Embeddingと同じ次元のtextCentroidがありません。dimensions設定を確認してください。");
  }

  const best = ranked[0];
  const selected = best.score >= options.threshold
    ? {
        sceneId: best.scene.id,
        reason: "titan-cosine",
        fallbackUsed: false,
        score: best.score,
        scene: best.scene,
      }
    : {
        sceneId: options.defaultSceneId,
        reason: "below-threshold",
        fallbackUsed: true,
        score: best.score,
        scene: scenes.find((scene) => scene.id === options.defaultSceneId) || null,
      };

  console.log("\nSelected Scene");
  console.log(`  sceneId        : ${selected.sceneId}`);
  console.log(`  reason         : ${selected.reason}`);
  console.log(`  fallbackUsed   : ${selected.fallbackUsed}`);
  console.log(`  best score     : ${formatScore(selected.score)}`);
  console.log(`  description    : ${selected.scene ? selected.scene.description : ""}`);
  console.log(`  embedding_text : ${selected.scene ? selected.scene.embedding_text : ""}`);

  console.log(`\nRanking top ${Math.min(options.top, ranked.length)}`);
  for (const [index, item] of ranked.slice(0, options.top).entries()) {
    const marker = index === 0 ? "*" : " ";
    console.log(
      `${marker} ${String(index + 1).padStart(2, " ")}. ` +
      `${item.scene.id.padEnd(12, " ")} ` +
      `score=${formatScore(item.score)} ` +
      `desc=${item.scene.description || ""}`
    );
  }

  const dimensionMismatches = candidates.filter(
    (scene) => scene.textCentroid.length !== options.dimensions
  );

  if (dimensionMismatches.length > 0) {
    console.log("\nDimension warnings");
    for (const scene of dimensionMismatches) {
      console.log(`  - ${scene.id}: textCentroid dimension is ${scene.textCentroid.length}`);
    }
  }
}

async function loadScenes(dynamodb, options) {
  const scenes = [];
  let exclusiveStartKey;

  do {
    const response = await dynamodb.send(new ScanCommand({
      TableName: options.tableName,
      ExclusiveStartKey: exclusiveStartKey,
    }));

    for (const rawItem of response.Items || []) {
      const item = fromAttributeValueMap(rawItem);
      const scene = normalizeScene(item);

      if (scene && scene.id) {
        scenes.push(scene);
      }
    }

    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey);

  scenes.sort((left, right) => left.id.localeCompare(right.id));
  return scenes;
}

function normalizeScene(item) {
  if (!item || typeof item !== "object") {
    return null;
  }

  return {
    id: String(item.id || ""),
    description: String(item.description || ""),
    embedding_text: typeof item.embedding_text === "string" ? item.embedding_text : "",
    default_emotions: item.default_emotions && typeof item.default_emotions === "object"
      ? item.default_emotions
      : {},
    few_shots: Array.isArray(item.few_shots) ? item.few_shots : [],
    textCentroid: Array.isArray(item.textCentroid) ? item.textCentroid : null,
  };
}

async function embedText(bedrock, options, inputText) {
  const command = new InvokeModelCommand({
    modelId: options.modelId,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify({
      inputText,
      dimensions: options.dimensions,
      normalize: true,
      embeddingTypes: ["float"],
    }),
  });

  const response = await bedrock.send(command);
  const payload = JSON.parse(Buffer.from(response.body).toString("utf8"));
  const embedding = Array.isArray(payload.embedding)
    ? payload.embedding
    : payload.embeddingsByType && Array.isArray(payload.embeddingsByType.float)
      ? payload.embeddingsByType.float
      : null;

  if (!isFiniteVector(embedding)) {
    throw new Error(`Titan response did not include a valid embedding: ${JSON.stringify(payload)}`);
  }

  if (embedding.length !== options.dimensions) {
    throw new Error(`Titan embedding dimension mismatch: expected ${options.dimensions}, got ${embedding.length}`);
  }

  return embedding;
}

function cosineSimilarity(left, right) {
  if (!isFiniteVector(left) || !isFiniteVector(right) || left.length !== right.length) {
    return null;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return null;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function isFiniteVector(vector) {
  return Array.isArray(vector) &&
    vector.length > 0 &&
    vector.every((value) => Number.isFinite(value));
}

function formatScore(score) {
  return Number.isFinite(score) ? score.toFixed(6) : "null";
}

function fromAttributeValueMap(item) {
  const result = {};

  for (const [key, value] of Object.entries(item || {})) {
    result[key] = fromAttributeValue(value);
  }

  return result;
}

function fromAttributeValue(value) {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  if ("S" in value) {
    return value.S;
  }

  if ("N" in value) {
    return Number(value.N);
  }

  if ("BOOL" in value) {
    return Boolean(value.BOOL);
  }

  if ("NULL" in value) {
    return null;
  }

  if ("L" in value) {
    return value.L.map(fromAttributeValue);
  }

  if ("M" in value) {
    return fromAttributeValueMap(value.M);
  }

  return undefined;
}

main().catch((error) => {
  console.error("\nERROR");
  console.error(`  ${error.message}`);
  process.exit(1);
});
