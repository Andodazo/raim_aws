'use strict';

// ==============================================================================
// Scene / Few-shot Repository
// ==============================================================================
//
// 【このファイルの役割】
// DynamoDB の RAiM-FewShot-dev テーブルから、Scene定義とFew-shotを取得する。
//
// RAiMでは、ユーザー発話の内容に応じてSceneを選び、
// そのSceneに紐づいた few_shots をMantleへ渡すことで、
// 返答の雰囲気やJSON出力を安定させる。
//
// 例:
// - 雑談っぽい発話       → default Scene
// - ゲーム相談っぽい発話 → gaming Scene
// - 疲れている発話       → tired Scene
//
// 【今回の仕様】
// - Scene選択はテキストEmbeddingのみで行う
// - 画像Embeddingは行わない
// - 画像Scene選択も行わない
// - 画像は別途 prompt-builder / mantle-client 側でMantleへ渡す
//
// そのため、このRepositoryでは以下を扱う:
//
// 使う:
// - id
// - description
// - embedding_text
// - text_examples / examples（旧形式互換）
// - few_shots
// - default_emotions
// - textCentroid
//
// 使わない:
// - image_examples
// - imageCentroid
//
// 【DynamoDBテーブル想定】
// Table name:
//   RAiM-FewShot-dev
//
// Partition key:
//   id
//
// Item例:
// {
//   "id": "gaming",
//   "description": "ゲーム話・攻略",
//   "embedding_text": "ゲーム マイクラ MOD 攻略 ビルド",
//   "few_shots": [
//     {
//       "user": "この試合どう思う？",
//       "raim": "リザルトを見る限り、かなり頑張ってるね。",
//       "emotions": { "happy": 0.4 }
//     }
//   ],
//   "default_emotions": { "happy": 0.3 },
//   "textCentroid": [0.01, 0.02, ...]
// }
//
// 【新形式と旧形式の互換性】
// 現在のScene判定では `embedding_text` をTitanでEmbeddingした `textCentroid` を使う。
// 以前のItemに `text_examples` / `examples` が残っていても壊れないよう、
// normalizeScene() では旧形式の配列も保持する。
//
// ==============================================================================

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  ScanCommand,
  GetCommand,
} = require('@aws-sdk/lib-dynamodb');

// ─────────────────────────────────────────────
// 環境変数・定数
// ─────────────────────────────────────────────
//
// AWS_REGION:
//   Lambda実行リージョン。
//   未設定の場合は東京リージョン ap-northeast-1 を使う。
//
// SCENE_TABLE_NAME:
//   Scene / Few-shot を保存しているDynamoDBテーブル名。
//   未設定の場合は開発用テーブル RAiM-FewShot-dev を使う。
//
// DEFAULT_SCENE_ID:
//   Scene選択に失敗したときのフォールバックScene。
//   通常は default を想定する。

const REGION = process.env.AWS_REGION || 'ap-northeast-1';
const TABLE_NAME = process.env.SCENE_TABLE_NAME || 'RAiM-FewShot-dev';
const DEFAULT_SCENE_ID = process.env.DEFAULT_SCENE_ID || 'default';

// ─────────────────────────────────────────────
// DynamoDB DocumentClient
// ─────────────────────────────────────────────
//
// DynamoDBClient:
//   低レベルのDynamoDBクライアント。
//
// DynamoDBDocumentClient:
//   JavaScriptの普通のObjectとしてItemを扱える高レベルクライアント。
//   AttributeValue形式 { S: "...", L: [...] } を自分で書かなくて済む。
//
// 例:
//   低レベル: { id: { S: "default" } }
//   DocumentClient: { id: "default" }

const ddbClient = new DynamoDBClient({ region: REGION });
const docClient = DynamoDBDocumentClient.from(ddbClient);

// ─────────────────────────────────────────────
// Scene正規化
// ─────────────────────────────────────────────
//
// DynamoDBのItemは、作成時期や仕様変更によって属性名が揺れる可能性がある。
// そのまま後続処理に渡すと、scene.text_examples が undefined だったり、
// few_shots が存在しなかったりして、Scene選択やprompt-builderで扱いづらくなる。
//
// そこで、DynamoDBから取得したItemを必ず normalizeScene() に通し、
// 後続処理で扱いやすい形に揃える。
//
// normalize後のSceneは最低限こういう形になる:
//
// {
//   id: "default",
//   description: "雑談・基本トーン",
//   embedding_text: "",
//   text_examples: [],
//   few_shots: [],
//   default_emotions: {},
//   textCentroid: null or []
// }
//
// 注意:
//   image_examples / imageCentroid は今回の仕様では扱わない。
//   DynamoDB Itemに存在していても、このRepositoryでは特別扱いしない。

function normalizeScene(scene) {
  if (!scene || typeof scene !== 'object') {
    return null;
  }

  // 現在の新形式では `embedding_text` がScene判定用の代表テキスト。
  // ただし旧形式のItemには `text_examples` / `examples` が残っている可能性があるため、
  // 互換用に配列化して保持しておく。
  const textExamples = Array.isArray(scene.text_examples)
    ? scene.text_examples
    : Array.isArray(scene.examples)
      ? scene.examples
      : [];

  // `embedding_text` はTitanで事前Embeddingされ、その結果が `textCentroid` に入る。
  // Core Lambdaはユーザー発話Embeddingと `textCentroid` を比較してSceneを選ぶため、
  // この値はデバッグやMantleへのScene説明で参照できるように保持する。
  const embeddingText = typeof scene.embedding_text === 'string'
    ? scene.embedding_text
    : '';

  // 新形式ではSceneに合う感情傾向を `default_emotions` で持つ。
  // 例: { happy: 0.5, excited: 0.3 }
  // Mantleへ「このSceneではこの感情が出やすい」という補助情報として渡す。
  const defaultEmotions = scene.default_emotions &&
    typeof scene.default_emotions === 'object' &&
    !Array.isArray(scene.default_emotions)
    ? scene.default_emotions
    : {};

  // few_shots が未登録のSceneでもエラーにしない。
  // その場合、prompt-builder側ではfew-shotなしのSceneとして扱う。
  const fewShots = Array.isArray(scene.few_shots)
    ? scene.few_shots
    : [];

  return {
    ...scene,

    // id / description は後続処理で文字列として扱いたいため明示的にString化する。
    id: String(scene.id || ''),
    description: String(scene.description || ''),

    // 新形式のScene判定用代表テキスト。
    embedding_text: embeddingText,

    // 旧形式互換用。新形式の主経路では `embedding_text` を使う。
    text_examples: textExamples,

    // Few-shotはMantleへ渡す応答例として使う。
    few_shots: fewShots,

    // Sceneごとの既定感情。prompt-builderでScene文脈としてMantleへ渡す。
    default_emotions: defaultEmotions,

    // textCentroid はScene選択用の代表ベクトル。
    // 未生成の場合は null にして、後続のscene-selector側で判定しやすくする。
    textCentroid: Array.isArray(scene.textCentroid) ? scene.textCentroid : null,
  };
}

// ─────────────────────────────────────────────
// 全Scene取得
// ─────────────────────────────────────────────
//
// listScenes() は DynamoDBテーブル内のScene定義をすべて取得する。
//
// 現時点ではScene数が少ない想定なので Scan を使う。
// 例:
// - default
// - gaming
// - joke
// - tired
//
// Sceneが数十件程度ならScanでも問題になりにくい。
// 将来的にScene数が多くなる場合は、以下を検討する:
//
// - Lambda内キャッシュ
// - DynamoDB Queryで取得できるキー設計
// - S3やParameter StoreへのScene定義配置
//
// Scanは1回で全件取れない場合があるため、LastEvaluatedKeyを使って
// ページングしながら最後まで取得する。

async function listScenes() {
  const scenes = [];
  let ExclusiveStartKey = undefined;

  do {
    const result = await docClient.send(
      new ScanCommand({
        TableName: TABLE_NAME,
        ExclusiveStartKey,
      })
    );

    const items = result.Items || [];

    for (const item of items) {
      const normalized = normalizeScene(item);

      // idがないItemはSceneとして扱えないため除外する。
      if (normalized && normalized.id) {
        scenes.push(normalized);
      }
    }

    // LastEvaluatedKey が返ってきた場合、まだ続きがある。
    // undefined になったら全件取得完了。
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return scenes;
}

// ─────────────────────────────────────────────
// Scene 1件取得
// ─────────────────────────────────────────────
//
// getSceneById() は id を指定してSceneを1件取得する。
// DynamoDBのPartition Keyが id なので、GetItemで直接取得できる。
//
// 用途:
// - default Sceneを取得する
// - 特定のSceneを明示的にテストする
// - Scene選択後に詳細を取り直す
//
// 取得できなかった場合は null を返す。

async function getSceneById(id) {
  if (!id) {
    throw new Error('scene id is required');
  }

  const result = await docClient.send(
    new GetCommand({
      TableName: TABLE_NAME,
      Key: { id },
    })
  );

  return normalizeScene(result.Item) || null;
}

// ─────────────────────────────────────────────
// default Scene取得
// ─────────────────────────────────────────────
//
// getDefaultScene() はフォールバック用のSceneを取得する。
//
// 例えば以下のような場合に使う:
//
// - Text Embeddingに失敗した
// - Scene一覧が取得できなかった
// - 類似度が閾値を下回った
// - textCentroid がまだ未整備だった
//
// DEFAULT_SCENE_ID は環境変数で変えられるが、通常は default を使う。

async function getDefaultScene() {
  return getSceneById(DEFAULT_SCENE_ID);
}

// ─────────────────────────────────────────────
// Sceneデバッグ表示用サマリ
// ─────────────────────────────────────────────
//
// summarizeScenes() は、APIレスポンスの debug に入れて確認しやすい形へ変換する。
//
// few_shots や textCentroid の中身をそのまま返すと、
// レスポンスが大きくなりすぎる可能性がある。
// そのため、件数や有無だけを返す。
//
// 本番ではdebugを返さない想定。
// 開発中にDynamoDBからSceneが読めているか確認するための補助関数。

function summarizeScenes(scenes) {
  if (!Array.isArray(scenes)) {
    return [];
  }

  return scenes.map((scene) => ({
    id: scene.id,
    description: scene.description || '',

    // 新形式のScene判定用代表テキストが登録されているか。
    hasEmbeddingText: typeof scene.embedding_text === 'string' &&
      scene.embedding_text.trim().length > 0,

    // 旧形式互換用の text_examples 数。
    // 既存の examples も normalizeScene() によって text_examples に統一される。
    textExamplesCount: Array.isArray(scene.text_examples)
      ? scene.text_examples.length
      : 0,

    // few_shots の数。
    // Mantleへ渡す応答例が何件あるかの確認用。
    fewShotsCount: Array.isArray(scene.few_shots)
      ? scene.few_shots.length
      : 0,

    // textCentroid があるか。
    // trueならscene-selectorで類似度計算に使える。
    hasTextCentroid: Array.isArray(scene.textCentroid),

    // textCentroid の次元数。
    // Titan Text Embeddings V2の出力次元と合っているか確認するために使う。
    textCentroidDim: Array.isArray(scene.textCentroid)
      ? scene.textCentroid.length
      : 0,
  }));
}

// ─────────────────────────────────────────────
// エクスポート
// ─────────────────────────────────────────────
//
// index.js や scene-selector.js から使う関数を外へ公開する。

module.exports = {
  DEFAULT_SCENE_ID,
  normalizeScene,
  listScenes,
  getSceneById,
  getDefaultScene,
  summarizeScenes,
};
