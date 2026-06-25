'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createMantleApiKeyProvider,
  decodeSecretValue,
  extractApiKey,
} = require('../lib/mantle-secret-provider');

const SECRET_ENV = Object.freeze({
  MANTLE_API_KEY_SECRET_ARN:
    'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:test-mantle-key',
  MANTLE_API_KEY_SECRET_JSON_KEY: 'apiKey',
  MANTLE_SECRET_REGION: 'ap-northeast-1',
});

test('createMantleApiKeyProvider reads the configured JSON key and caches it', async () => {
  let sendCount = 0;
  let commandInput;
  const client = {
    send: async (command) => {
      sendCount += 1;
      commandInput = command.input;
      return { SecretString: JSON.stringify({ apiKey: 'secret-from-manager' }) };
    },
  };
  const provider = createMantleApiKeyProvider({
    client,
    env: SECRET_ENV,
    // モジュール共通cacheとは分離し、テスト同士の影響をなくす。
    cache: new Map(),
  });

  assert.equal(await provider(), 'secret-from-manager');
  assert.equal(await provider(), 'secret-from-manager');
  assert.equal(sendCount, 1);
  assert.equal(commandInput.SecretId, SECRET_ENV.MANTLE_API_KEY_SECRET_ARN);
});

test('failed Secrets Manager calls are removed from cache so the next call can retry', async () => {
  let sendCount = 0;
  const client = {
    send: async () => {
      sendCount += 1;
      if (sendCount === 1) {
        const error = new Error('temporary failure');
        error.name = 'ServiceUnavailableException';
        throw error;
      }
      return { SecretString: '{"apiKey":"recovered-key"}' };
    },
  };
  const provider = createMantleApiKeyProvider({
    client,
    env: SECRET_ENV,
    cache: new Map(),
  });

  await assert.rejects(() => provider(), (error) => (
    error.code === 'MANTLE_SECRET_GET_FAILED' && error.retriable === true
  ));
  assert.equal(await provider(), 'recovered-key');
  assert.equal(sendCount, 2);
});

test('provider rejects missing required environment variables before AWS access', async () => {
  const provider = createMantleApiKeyProvider({
    client: { send: async () => assert.fail('AWS should not be called') },
    env: {},
    cache: new Map(),
  });

  await assert.rejects(
    () => provider(),
    (error) => error.code === 'MANTLE_SECRET_CONFIG_ERROR'
  );
});

test('SecretBinary and JSON parsing never require plaintext environment variables', () => {
  const text = decodeSecretValue({
    SecretBinary: Buffer.from('{"credential":"binary-key"}', 'utf8'),
  });

  assert.equal(extractApiKey(text, 'credential'), 'binary-key');
});
