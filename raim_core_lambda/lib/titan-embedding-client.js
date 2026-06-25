'use strict';

// ==============================================================================
// Amazon Titan Text Embeddings V2 Client
// ==============================================================================
//
// ユーザー発話を意味ベクトルへ変換するため、Amazon Bedrock Runtimeの
// InvokeModel APIでTitan Text Embeddings V2を呼び出す。
//
// 環境変数:
// - BEDROCK_REGION: Bedrockのリージョン。未設定時はAWS_REGION
// - TITAN_EMBEDDING_MODEL_ID: 既定値 amazon.titan-embed-text-v2:0
// - TITAN_EMBEDDING_DIMENSIONS: 1024 / 512 / 256。既定値1024
// - TITAN_EMBEDDING_NORMALIZE: ベクトルを正規化するか。既定値true
// - TITAN_MAX_INPUT_CHARACTERS: 入力文字数の安全上限。既定値50000
//
// SceneのtextCentroidは、ここで指定するdimensionsと同じ次元で
// あらかじめ生成してDynamoDBへ保存しておく必要がある。
//
// 【Bedrockへ送るrequest body】
// {
//   inputText: "ユーザー発話",
//   dimensions: 1024,
//   normalize: true,
//   embeddingTypes: ["float"]
// }
//
// 【Titanから受け取るresponse body】
// {
//   embedding: [0.01, -0.02, ...],
//   inputTextTokenCount: 12,
//   embeddingsByType: { float: [...] }
// }
//
// ここではベクトル生成のみを担当する。
// Sceneとの比較や閾値判定はscene-selector.jsの責務。
// ==============================================================================

const {
  BedrockRuntimeClient,
  InvokeModelCommand,
} = require('@aws-sdk/client-bedrock-runtime');

const VALID_DIMENSIONS = Object.freeze([1024, 512, 256]);

/**
 * Lambda環境変数をTitan呼び出し設定へ変換する。
 *
 * dimensionsはTitan V2が対応する3種類だけを許可する。
 * DynamoDBのtextCentroidと異なる次元へ変更すると比較できなくなるため、
 * 設定ミスは呼び出し前に明示的なエラーにする。
 */
function getTitanConfig(env = process.env) {
  const dimensions = Number(env.TITAN_EMBEDDING_DIMENSIONS || 1024);
  const maxInputCharacters = Number(env.TITAN_MAX_INPUT_CHARACTERS || 50000);

  if (!VALID_DIMENSIONS.includes(dimensions)) {
    throw new Error('TITAN_EMBEDDING_DIMENSIONS must be 1024, 512, or 256');
  }

  if (!Number.isInteger(maxInputCharacters) || maxInputCharacters <= 0) {
    throw new Error('TITAN_MAX_INPUT_CHARACTERS must be a positive integer');
  }

  return {
    region: env.BEDROCK_REGION || env.AWS_REGION || 'ap-northeast-1',
    modelId: env.TITAN_EMBEDDING_MODEL_ID || 'amazon.titan-embed-text-v2:0',
    dimensions,
    normalize: String(env.TITAN_EMBEDDING_NORMALIZE ?? 'true').toLowerCase() !== 'false',
    maxInputCharacters,
  };
}

/**
 * Titan InvokeModelへ渡すbodyを作る。
 *
 * 空文字は意味ベクトルを作れないため拒否する。
 * また、極端に長い入力でtoken上限やLambda処理時間を圧迫しないよう、
 * アプリ側の安全上限も確認する。
 */
function buildTitanRequest(inputText, config) {
  const text = String(inputText || '').trim();

  if (!text) {
    throw new Error('Titan embedding input text is required');
  }

  if (text.length > config.maxInputCharacters) {
    throw new Error(`Titan embedding input exceeds ${config.maxInputCharacters} characters`);
  }

  return {
    inputText: text,
    dimensions: config.dimensions,
    normalize: config.normalize,
    embeddingTypes: ['float'],
  };
}

/**
 * AWS SDKが返すStreamingBlobをUTF-8文字列へ変換する。
 * Lambda上のSDK形式と、単体テストで使うUint8Arrayの両方に対応する。
 */
async function decodeBedrockBody(body) {
  if (body && typeof body.transformToString === 'function') {
    return body.transformToString('utf-8');
  }

  if (body instanceof Uint8Array) {
    return new TextDecoder('utf-8').decode(body);
  }

  return String(body || '');
}

/**
 * Titan responseからfloat embeddingを取り出し、数値と次元数を検証する。
 *
 * 次元不一致を許すとコサイン類似度が計算できず、誤ったScene選択につながるため、
 * 「一応配列がある」だけでは成功にしない。
 */
function parseTitanResponse(payload, expectedDimensions) {
  const embedding = Array.isArray(payload?.embedding)
    ? payload.embedding
    : payload?.embeddingsByType?.float;

  if (!Array.isArray(embedding) || embedding.some((value) => !Number.isFinite(value))) {
    throw new Error('Titan response does not contain a valid float embedding');
  }

  if (embedding.length !== expectedDimensions) {
    throw new Error(
      `Titan embedding dimension mismatch: expected ${expectedDimensions}, received ${embedding.length}`
    );
  }

  return {
    embedding,
    inputTextTokenCount: Number(payload.inputTextTokenCount || 0),
  };
}

/**
 * Titan Embedding Clientを生成する。
 *
 * clientを省略した本番ではBedrockRuntimeClientを作る。
 * テストではsend()を持つfake clientを渡し、AWSへ接続せずrequestを検証できる。
 *
 * @returns {Function} textを受け取りembedding情報を返す関数。
 */
function createTitanEmbeddingClient({ client, env = process.env } = {}) {
  const config = getTitanConfig(env);
  const bedrockClient = client || new BedrockRuntimeClient({
    region: config.region,
    // 独自endpointは指定しない。AWS SDKがBEDROCK_REGIONに対応する
    // Amazon Bedrock Runtimeの標準リージョナルendpointを自動選択する。
  });

  return async function createTitanEmbedding(inputText) {
    // 1. 入力文字列と設定値からTitan V2用request bodyを作る。
    const requestBody = buildTitanRequest(inputText, config);
    try {
      // 2. Bedrock Runtime InvokeModelでTitan Text Embeddings V2を呼び出す。
      // Converse APIではなく、Embeddingモデル固有bodyを扱えるInvokeModelを使う。
      const response = await bedrockClient.send(
        new InvokeModelCommand({
          modelId: config.modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify(requestBody),
        })
      );
      // 3. StreamingBlobを文字列化し、JSONとして解釈する。
      const responseText = await decodeBedrockBody(response.body);
      let payload;

      try {
        payload = JSON.parse(responseText);
      } catch (error) {
        const parseError = new Error('Titan returned a non-JSON response');
        parseError.cause = error;
        throw parseError;
      }

      // 4. ベクトルの型・次元数を確認し、後続が使う共通形式で返す。
      return {
        ...parseTitanResponse(payload, config.dimensions),
        modelId: config.modelId,
        dimensions: config.dimensions,
        normalized: config.normalize,
      };
    } catch (error) {
      // 5. AWS SDK固有例外をRAiMのEMBED_ERRORへ分類できる形に包む。
      // 権限・入力・model ID不備は再試行しても直らないためretriable=falseにする。
      const titanError = new Error(`Titan embedding request failed: ${error.message}`);
      titanError.name = 'TitanEmbeddingError';
      titanError.code = 'TITAN_EMBEDDING_ERROR';
      titanError.coreErrorCode = 'EMBED_ERROR';
      titanError.retriable = ![
        'AccessDeniedException',
        'ValidationException',
        'ResourceNotFoundException',
      ].includes(error.name);
      titanError.cause = error;
      throw titanError;
    }
  };
}

const createTitanEmbedding = createTitanEmbeddingClient();

module.exports = {
  VALID_DIMENSIONS,
  buildTitanRequest,
  createTitanEmbedding,
  createTitanEmbeddingClient,
  decodeBedrockBody,
  getTitanConfig,
  parseTitanResponse,
};
