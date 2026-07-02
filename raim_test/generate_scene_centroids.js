#!/usr/bin/env node
/**
 * RAiM FewShotテーブルの `embedding_text` から Titan Text Embeddings V2 の
 * ベクトルを生成し、同じアイテムの `textCentroid` に保存するCloudShell用スクリプト。
 *
 * ============================================================================
 * 1. このスクリプトの目的
 * ============================================================================
 *
 * Core Lambdaでは、ユーザーの発話をTitan Text Embeddings V2でベクトル化し、
 * FewShotテーブル側に保存されているScene代表ベクトル `textCentroid` と比較します。
 *
 * 例えばユーザーが「ダジャレ言って」と送った場合、Core Lambdaはその発話をEmbeddingし、
 * `joke` Sceneの `textCentroid` との類似度が高ければ、`joke` の `few_shots` を
 * Mantleへ渡すプロンプト材料として使います。
 *
 * そのため、FewShotテーブルには事前に `textCentroid` を作っておく必要があります。
 * このスクリプトは、その事前生成をCloudShell上で行うためのものです。
 *
 * ============================================================================
 * 2. 対象とするFewShotテーブル形式
 * ============================================================================
 *
 * このスクリプトは、Sceneごとに次のようなDynamoDBアイテムがある前提です。
 *
 * - id
 *   Sceneを一意に識別するキーです。
 *   例: "joke", "tired", "gaming", "default"
 *
 * - description
 *   人間が見て分かるScene説明です。
 *   例: "冗談・からかい・ユーモアの会話"
 *   このスクリプトでは参照しません。
 *
 * - embedding_text
 *   Scene判定用にTitanへ渡す代表テキストです。
 *   例: "冗談 ジョーク 笑える 面白い ふざける ..."
 *
 *   今回の形式では、この `embedding_text` だけをEmbedding対象にします。
 *   `few_shots` の各 user 発話を平均する方式ではありません。
 *
 * - few_shots
 *   Sceneが選ばれた後、Mantleへ渡す会話例です。
 *   このスクリプトではEmbedding対象にせず、更新もしません。
 *
 * - default_emotions
 *   Scene選択後に使う感情の初期値です。
 *   このスクリプトでは更新しません。
 *
 * ============================================================================
 * 3. CloudShellでの実行手順
 * ============================================================================
 *
 * Step 1: CloudShellを開く
 *
 *   AWS ConsoleでCloudShellを開きます。
 *   リージョンは、DynamoDBテーブル `RAiM-FewShot-dev` があるリージョンに合わせます。
 *   現在の想定は `ap-northeast-1` です。
 *
 * Step 2: このファイルをCloudShellへアップロードする
 *
 *   CloudShell右上の `Actions` -> `Upload file` から、
 *   `generate_scene_centroids.js` をアップロードします。
 *
 * Step 3: 依存パッケージをインストールする
 *
 *   このJS版スクリプトはAWS SDK for JavaScript v3を使います。
 *   CloudShellにはAWS CLIは入っていますが、Node.js用のSDKパッケージが
 *   常に入っているとは限らないため、以下を実行します。
 *
 *     npm install @aws-sdk/client-dynamodb @aws-sdk/client-bedrock-runtime
 *
 *   それぞれの役割:
 *
 *   - @aws-sdk/client-dynamodb
 *     FewShotテーブルをScanし、生成した `textCentroid` をUpdateItemで保存します。
 *
 *   - @aws-sdk/client-bedrock-runtime
 *     Titan Text Embeddings V2をInvokeModelで呼び出し、`embedding_text` をベクトル化します。
 *
 * Step 4: dry-runで動作確認する
 *
 *     node generate_scene_centroids.js
 *
 *   `--apply` を付けない場合、DynamoDBは更新しません。
 *   ただし、TitanのInvokeModelは実行します。
 *   つまり「Bedrock権限があるか」「embedding_textからベクトルを作れるか」を確認できます。
 *
 * Step 5: 問題なければDynamoDBへ保存する
 *
 *     node generate_scene_centroids.js --apply
 *
 *   各Sceneの `embedding_text` をEmbeddingし、同じアイテムに `textCentroid` を保存します。
 *
 * Step 6: 特定のSceneだけ処理したい場合
 *
 *     node generate_scene_centroids.js --apply --scene-id joke
 *
 *   `--scene-id` は複数回指定できます。
 *
 *     node generate_scene_centroids.js --apply --scene-id joke --scene-id tired
 *
 * Step 7: 既存の `textCentroid` を上書きしたい場合
 *
 *     node generate_scene_centroids.js --apply --force
 *
 *   デフォルトでは、既に `textCentroid` があるSceneはスキップします。
 *   `embedding_text` を変更した後に再生成したい場合だけ `--force` を使ってください。
 *
 * ============================================================================
 * 4. 保存される属性
 * ============================================================================
 *
 * `--apply` を付けて実行すると、各Sceneアイテムへ次の属性を追加または更新します。
 *
 * - textCentroid
 *   Titanで生成したベクトルです。
 *   Core Lambdaはこの値とユーザー発話Embeddingのコサイン類似度を比較します。
 *
 * - textCentroidModelId
 *   どのEmbeddingモデルで作ったかを記録します。
 *
 * - textCentroidDimensions
 *   ベクトル次元数を記録します。
 *   Core Lambdaの `TITAN_EMBEDDING_DIMENSIONS` と一致させてください。
 *
 * - textCentroidSourceAttribute
 *   何の属性を元にEmbeddingしたかを記録します。
 *   今回は常に `embedding_text` です。
 *
 * - textCentroidSourceText
 *   実際にEmbeddingした文字列を記録します。
 *   後から「どのテキストでこのベクトルを作ったか」を確認しやすくするためです。
 *
 * - textCentroidUpdatedAt
 *   更新日時をISO文字列で記録します。
 *
 * ============================================================================
 * 5. 必要なIAM権限
 * ============================================================================
 *
 * CloudShellを実行しているIAMユーザーまたはロールには、最低限次が必要です。
 *
 * - dynamodb:Scan
 *   `RAiM-FewShot-dev` のScene一覧を取得するために使います。
 *
 * - dynamodb:UpdateItem
 *   生成した `textCentroid` をDynamoDBへ保存するために使います。
 *
 * - bedrock:InvokeModel
 *   Titan Text Embeddings V2を呼び出すために使います。
 *
 * ============================================================================
 * 6. よくあるエラー
 * ============================================================================
 *
 * - Cannot find module '@aws-sdk/client-dynamodb'
 *   依存パッケージが未インストールです。
 *   `npm install @aws-sdk/client-dynamodb @aws-sdk/client-bedrock-runtime` を実行してください。
 *
 * - AccessDeniedException: not authorized to perform bedrock:InvokeModel
 *   CloudShell実行ユーザーにBedrockのInvokeModel権限がありません。
 *   IAMポリシーに `bedrock:InvokeModel` を追加するか、権限を持つユーザーで実行してください。
 *
 * - missing required string attribute: embedding_text
 *   対象Sceneに `embedding_text` がありません。
 *   FewShotテーブルのアイテムへ `embedding_text` を追加してください。
 */

const { DynamoDBClient, ScanCommand, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const { BedrockRuntimeClient, InvokeModelCommand } = require("@aws-sdk/client-bedrock-runtime");

const DEFAULT_TABLE_NAME = "RAiM-FewShot-dev";
const DEFAULT_REGION = process.env.AWS_REGION || "ap-northeast-1";
const DEFAULT_MODEL_ID = "amazon.titan-embed-text-v2:0";
const VALID_DIMENSIONS = new Set([1024, 512, 256]);

function parseArgs(argv) {
  const options = {
    tableName: DEFAULT_TABLE_NAME,
    region: DEFAULT_REGION,
    bedrockRegion: DEFAULT_REGION,
    modelId: DEFAULT_MODEL_ID,
    dimensions: 1024,
    sceneIds: [],
    apply: false,
    force: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--apply") {
      options.apply = true;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--table-name") {
      options.tableName = readValue(argv, ++i, arg);
    } else if (arg === "--region") {
      options.region = readValue(argv, ++i, arg);
    } else if (arg === "--bedrock-region") {
      options.bedrockRegion = readValue(argv, ++i, arg);
    } else if (arg === "--model-id") {
      options.modelId = readValue(argv, ++i, arg);
    } else if (arg === "--dimensions") {
      options.dimensions = Number(readValue(argv, ++i, arg));
    } else if (arg === "--scene-id") {
      options.sceneIds.push(readValue(argv, ++i, arg));
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!VALID_DIMENSIONS.has(options.dimensions)) {
    throw new Error("--dimensions must be one of 1024, 512, or 256");
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
  console.log(`RAiM Scene centroid generator

Options:
  --table-name NAME       DynamoDB table name. Default: ${DEFAULT_TABLE_NAME}
  --region REGION         DynamoDB region. Default: AWS_REGION or ap-northeast-1
  --bedrock-region REGION Titan invoke region. Default: same as --region
  --model-id MODEL_ID     Titan model ID. Default: ${DEFAULT_MODEL_ID}
  --dimensions N          Embedding dimensions: 1024, 512, or 256. Default: 1024
  --scene-id ID           Target one scene. Can be repeated.
  --apply                 Update DynamoDB. Without this, dry-run only.
  --force                 Overwrite existing textCentroid.
  --help                  Show this help.
`);
}

async function main() {
  const options = parseArgs(process.argv);
  const dynamodb = new DynamoDBClient({ region: options.region });
  const bedrock = new BedrockRuntimeClient({ region: options.bedrockRegion });

  console.log("RAiM Scene centroid generator");
  console.log(`  mode          : ${options.apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`  table         : ${options.tableName} (${options.region})`);
  console.log(`  Titan         : ${options.modelId} (${options.bedrockRegion})`);
  console.log(`  dimensions    : ${options.dimensions}`);
  console.log(`  overwrite     : ${options.force}`);

  const scenes = await loadScenes(dynamodb, options);
  console.log(`  target scenes : ${scenes.length}`);

  let failed = 0;
  let updated = 0;
  let skipped = 0;

  for (const scene of scenes) {
    const id = scene.id.S;
    console.log(`\n[${id}]`);

    try {
      const embeddingText = getRequiredString(scene, "embedding_text");

      // 既にtextCentroidが存在する場合、誤って上書きしないようデフォルトではスキップします。
      // 新しいembedding_textへ変更した後に再生成したい場合は `--force` を付けます。
      if (scene.textCentroid && !options.force) {
        console.log("  skipped: textCentroid already exists. Use --force to overwrite.");
        skipped += 1;
        continue;
      }

      console.log(`  source: embedding_text (${embeddingText.length} chars)`);
      console.log(`  text  : ${embeddingText}`);

      // Titan Text Embeddings V2を呼び出し、Scene判定用の代表ベクトルを取得します。
      // normalize:true によりTitan側で正規化済みベクトルを返しますが、
      // 後続処理との一貫性のため、保存前にこちらでもL2正規化を行います。
      const embedding = await embedText(bedrock, options, embeddingText);
      const centroid = normalizeVector(embedding);

      console.log(`  vector: ${centroid.length} dimensions`);

      if (options.apply) {
        await saveCentroid(dynamodb, options, id, centroid, embeddingText);
        console.log("  saved : textCentroid updated");
        updated += 1;
      } else {
        console.log("  dry-run: DynamoDB was not updated. Add --apply to save.");
        skipped += 1;
      }
    } catch (error) {
      failed += 1;
      console.error(`  error: ${error.message}`);
    }
  }

  console.log("\nDone");
  console.log(`  updated: ${updated}`);
  console.log(`  skipped: ${skipped}`);
  console.log(`  failed : ${failed}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

async function loadScenes(dynamodb, options) {
  const allScenes = [];
  let exclusiveStartKey;

  do {
    const command = new ScanCommand({
      TableName: options.tableName,
      ExclusiveStartKey: exclusiveStartKey,
    });

    const response = await dynamodb.send(command);
    allScenes.push(...(response.Items || []));
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey);

  const sceneIdSet = new Set(options.sceneIds);
  const filtered = sceneIdSet.size === 0
    ? allScenes
    : allScenes.filter((item) => item.id && sceneIdSet.has(item.id.S));

  filtered.sort((a, b) => a.id.S.localeCompare(b.id.S));
  return filtered;
}

function getRequiredString(item, attributeName) {
  const value = item[attributeName];
  if (!value || typeof value.S !== "string" || value.S.trim() === "") {
    const id = item.id && item.id.S ? item.id.S : "(unknown)";
    throw new Error(`${id} is missing required string attribute: ${attributeName}`);
  }
  return value.S.trim();
}

async function embedText(bedrock, options, inputText) {
  const body = {
    inputText,
    dimensions: options.dimensions,
    normalize: true,
    embeddingTypes: ["float"],
  };

  const command = new InvokeModelCommand({
    modelId: options.modelId,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(body),
  });

  const response = await bedrock.send(command);
  const payload = JSON.parse(Buffer.from(response.body).toString("utf8"));

  // Titan Text Embeddings V2のレスポンスは環境やSDK表現によって
  // `embedding` または `embeddingsByType.float` として取り出せる場合があります。
  const embedding = Array.isArray(payload.embedding)
    ? payload.embedding
    : payload.embeddingsByType && Array.isArray(payload.embeddingsByType.float)
      ? payload.embeddingsByType.float
      : null;

  if (!embedding) {
    throw new Error(`Titan response did not include an embedding: ${JSON.stringify(payload)}`);
  }

  if (embedding.length !== options.dimensions) {
    throw new Error(`Embedding dimensions mismatch: expected ${options.dimensions}, got ${embedding.length}`);
  }

  for (const value of embedding) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error("Embedding contains a non-finite number");
    }
  }

  return embedding;
}

function normalizeVector(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0 || !Number.isFinite(norm)) {
    throw new Error("Embedding norm is zero or invalid");
  }
  return vector.map((value) => value / norm);
}

async function saveCentroid(dynamodb, options, id, centroid, embeddingText) {
  const now = new Date().toISOString();

  // DynamoDBのNumber型は文字列として渡します。
  // 桁を少し丸めることで、1024次元ベクトルを保存してもアイテムサイズが膨らみすぎないようにします。
  const centroidAttribute = {
    L: centroid.map((value) => ({ N: Number(value).toPrecision(12) })),
  };

  const command = new UpdateItemCommand({
    TableName: options.tableName,
    Key: {
      id: { S: id },
    },
    UpdateExpression: [
      "SET textCentroid = :centroid",
      "textCentroidModelId = :modelId",
      "textCentroidDimensions = :dimensions",
      "textCentroidSourceAttribute = :sourceAttribute",
      "textCentroidSourceText = :sourceText",
      "textCentroidUpdatedAt = :updatedAt",
    ].join(", "),
    ExpressionAttributeValues: {
      ":centroid": centroidAttribute,
      ":modelId": { S: options.modelId },
      ":dimensions": { N: String(options.dimensions) },
      ":sourceAttribute": { S: "embedding_text" },
      ":sourceText": { S: embeddingText },
      ":updatedAt": { S: now },
    },
  });

  await dynamodb.send(command);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
