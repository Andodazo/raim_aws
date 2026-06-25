'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTitanRequest,
  createTitanEmbeddingClient,
  getTitanConfig,
} = require('../lib/titan-embedding-client');

const TITAN_ENV = Object.freeze({
  AWS_REGION: 'ap-northeast-1',
  TITAN_EMBEDDING_MODEL_ID: 'amazon.titan-embed-text-v2:0',
  TITAN_EMBEDDING_DIMENSIONS: '256',
  TITAN_EMBEDDING_NORMALIZE: 'true',
});

test('buildTitanRequest uses the official Titan V2 request fields', () => {
  const config = getTitanConfig({
    ...TITAN_ENV,
    // 旧設定が残っていても独自endpointとして採用しないことを確認する。
    TITAN_ENDPOINT_URL: 'https://must-not-be-used.example.com',
  });
  const request = buildTitanRequest(' hello ', config);

  assert.equal(Object.hasOwn(config, 'endpoint'), false);
  assert.deepEqual(request, {
    inputText: 'hello',
    dimensions: 256,
    normalize: true,
    embeddingTypes: ['float'],
  });
});

test('createTitanEmbeddingClient invokes Bedrock Runtime and validates dimensions', async () => {
  let commandInput;
  const embedding = Array.from({ length: 256 }, (_, index) => index / 256);
  const client = {
    send: async (command) => {
      commandInput = command.input;
      return {
        body: {
          transformToString: async () => JSON.stringify({
            embedding,
            inputTextTokenCount: 4,
          }),
        },
      };
    },
  };
  const createEmbedding = createTitanEmbeddingClient({ client, env: TITAN_ENV });
  const result = await createEmbedding('テスト発話');

  assert.equal(commandInput.modelId, 'amazon.titan-embed-text-v2:0');
  assert.equal(commandInput.contentType, 'application/json');
  assert.equal(JSON.parse(commandInput.body).dimensions, 256);
  assert.deepEqual(result.embedding, embedding);
  assert.equal(result.inputTextTokenCount, 4);
});
