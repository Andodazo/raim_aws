#!/usr/bin/env node
/**
 * Bedrock Mantle 疎通確認用スクリプト。
 *
 * 目的:
 *   LambdaのIAM権限やSecrets Manager設定を待たずに、
 *   Windowsのコマンドプロンプト上で
 *
 *     - Mantle endpoint URL
 *     - Mantle API Key
 *     - Mantle model ID
 *
 *   だけを使って、Bedrock Mantleへ直接アクセスできるか確認する。
 *
 * このスクリプトはAWS SDKを使いません。
 * Secrets Managerにもアクセスしません。
 * API Keyは環境変数またはコマンドライン引数で直接渡します。
 *
 * ============================================================================
 * Windows コマンドプロンプトでの使い方
 * ============================================================================
 *
 * 1. 環境変数を設定する
 *
 *   set OPENAI_BASE_URL=https://bedrock-mantle.us-east-1.api.aws/v1
 *   set OPENAI_API_KEY=実際のMantle API Key
 *   set MANTLE_MODEL=google.gemma-4-26b-a4b
 *
 *   us-west-2で試す場合:
 *
 *   set OPENAI_BASE_URL=https://bedrock-mantle.us-west-2.api.aws/v1
 *
 * 2. モデル一覧だけ確認する
 *
 *   node test_mantle_connection.js --models
 *
 * 3. Responses APIで短い応答を生成する
 *
 *   node test_mantle_connection.js --prompt "こんにちは。短く挨拶して"
 *
 * 4. JSON応答形式をCore Lambdaに近い形で試す
 *
 *   node test_mantle_connection.js --json
 *
 * ============================================================================
 * コマンドライン引数で直接指定する例
 * ============================================================================
 *
 *   node test_mantle_connection.js ^
 *     --base-url "https://bedrock-mantle.us-east-1.api.aws/v1" ^
 *     --api-key "実際のMantle API Key" ^
 *     --model "google.gemma-4-26b-a4b" ^
 *     --prompt "こんにちは"
 *
 * 注意:
 *   コマンド履歴にAPI Keyが残るため、通常は --api-key より環境変数を推奨します。
 *
 * ============================================================================
 * 成功時に分かること
 * ============================================================================
 *
 * - endpoint URLが正しい
 * - API KeyがMantleで受け付けられている
 * - 指定したmodel IDが利用できる
 * - Responses APIのstream=trueで応答を受け取れる
 */

'use strict';

const DEFAULT_BASE_URL = 'https://bedrock-mantle.us-east-1.api.aws/v1';
const DEFAULT_PROMPT = 'こんにちは。日本語で一言だけ挨拶してください。';

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.OPENAI_BASE_URL || process.env.MANTLE_BASE_URL || DEFAULT_BASE_URL,
    apiKey: process.env.OPENAI_API_KEY || process.env.MANTLE_API_KEY || '',
    model: process.env.MANTLE_MODEL || '',
    prompt: DEFAULT_PROMPT,
    modelsOnly: false,
    jsonMode: false,
    timeoutMs: Number(process.env.MANTLE_TIMEOUT_MS || 60000),
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--models') {
      options.modelsOnly = true;
    } else if (arg === '--json') {
      options.jsonMode = true;
      options.prompt = [
        '次の形式のJSONだけを返してください。',
        '{"text":"短い返答","emotion":"happy","intensity":0.5}',
        'ユーザーへの返答: こんにちは',
      ].join('\n');
    } else if (arg === '--base-url') {
      options.baseUrl = readValue(argv, ++i, arg);
    } else if (arg === '--api-key') {
      options.apiKey = readValue(argv, ++i, arg);
    } else if (arg === '--model') {
      options.model = readValue(argv, ++i, arg);
    } else if (arg === '--prompt') {
      options.prompt = readValue(argv, ++i, arg);
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = Number(readValue(argv, ++i, arg));
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.baseUrl) {
    throw new Error('OPENAI_BASE_URL or --base-url is required');
  }

  if (!options.apiKey) {
    throw new Error('OPENAI_API_KEY or --api-key is required');
  }

  if (!options.modelsOnly && !options.model) {
    throw new Error('MANTLE_MODEL or --model is required unless --models is used');
  }

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
  }

  options.baseUrl = options.baseUrl.replace(/\/$/, '');
  return options;
}

function readValue(argv, index, optionName) {
  const value = argv[index];

  if (!value || value.startsWith('--')) {
    throw new Error(`${optionName} requires a value`);
  }

  return value;
}

function printHelp() {
  console.log(`Bedrock Mantle connection tester

Usage:
  node test_mantle_connection.js --models
  node test_mantle_connection.js --prompt "こんにちは"
  node test_mantle_connection.js --json

Environment variables:
  OPENAI_BASE_URL   e.g. https://bedrock-mantle.us-east-1.api.aws/v1
  OPENAI_API_KEY    Mantle API Key
  MANTLE_MODEL      e.g. google.gemma-4-26b-a4b

Options:
  --base-url URL
  --api-key KEY
  --model MODEL_ID
  --prompt TEXT
  --models
  --json
  --timeout-ms N
`);
}

function maskApiKey(apiKey) {
  if (!apiKey) {
    return '(empty)';
  }

  if (apiKey.length <= 8) {
    return `${apiKey[0] || ''}***`;
  }

  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)} (${apiKey.length} chars)`;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function listModels(options) {
  const url = `${options.baseUrl}/models`;
  const response = await fetchWithTimeout(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      Accept: 'application/json',
    },
  }, options.timeoutMs);

  const text = await response.text();

  console.log('\nModels API');
  console.log(`  URL         : ${url}`);
  console.log(`  HTTP status : ${response.status}`);

  if (!response.ok) {
    console.log('\nRaw response:');
    console.log(text);
    throw new Error(`Models API failed with HTTP ${response.status}`);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    console.log('\nRaw response:');
    console.log(text);
    throw new Error(`Models API returned non-JSON: ${error.message}`);
  }

  const ids = Array.isArray(payload.data)
    ? payload.data.map((item) => item.id).filter(Boolean)
    : [];

  if (ids.length === 0) {
    console.log('\nNo model IDs found in response:');
    console.log(JSON.stringify(payload, null, 2));
    return [];
  }

  console.log('\nAvailable model IDs:');
  for (const id of ids) {
    console.log(`  ${id}`);
  }

  return ids;
}

function buildResponsesRequest(options) {
  return {
    model: options.model,
    input: [
      {
        role: 'system',
        content: options.jsonMode
          ? 'あなたはRAiMの応答生成テストです。必ずJSONだけを返してください。'
          : 'あなたは疎通確認用のアシスタントです。短く返答してください。',
      },
      {
        role: 'user',
        content: options.prompt,
      },
    ],
    store: false,
    stream: true,
    max_output_tokens: 256,
    temperature: 0.3,
  };
}

function parseSseBlock(block) {
  const lines = block.split(/\r?\n/);
  const event = {
    event: '',
    data: '',
  };

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event.event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      event.data += line.slice('data:'.length).trim();
    }
  }

  return event.data ? event : null;
}

function extractDelta(payload) {
  if (typeof payload.delta === 'string') {
    return payload.delta;
  }

  if (typeof payload.text === 'string') {
    return payload.text;
  }

  if (typeof payload.output_text === 'string') {
    return payload.output_text;
  }

  return '';
}

async function consumeSseStream(body) {
  const decoder = new TextDecoder('utf-8');
  const reader = body.getReader();
  let buffer = '';
  let rawText = '';
  let responseId = '';
  let completedPayload = null;

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    let separatorIndex;
    while ((separatorIndex = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex).replace(/^\r?\n/, '');
      const parsed = parseSseBlock(block);

      if (!parsed) {
        continue;
      }

      if (parsed.data === '[DONE]') {
        return {
          rawText,
          responseId,
          completedPayload,
        };
      }

      let payload;
      try {
        payload = JSON.parse(parsed.data);
      } catch {
        continue;
      }

      if (!responseId && typeof payload.id === 'string') {
        responseId = payload.id;
      }

      if (!responseId && typeof payload.response?.id === 'string') {
        responseId = payload.response.id;
      }

      const delta = extractDelta(payload);
      if (delta) {
        rawText += delta;
        process.stdout.write(delta);
      }

      if (parsed.event.includes('completed') || payload.type?.includes?.('completed')) {
        completedPayload = payload;
      }
    }

    if (done) {
      return {
        rawText,
        responseId,
        completedPayload,
      };
    }
  }
}

async function callResponsesApi(options) {
  const url = `${options.baseUrl}/responses`;
  const requestBody = buildResponsesRequest(options);

  console.log('\nResponses API');
  console.log(`  URL         : ${url}`);
  console.log(`  model       : ${options.model}`);
  console.log(`  stream      : true`);
  console.log('\nStreaming text:');

  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(requestBody),
  }, options.timeoutMs);

  if (!response.ok) {
    const text = await response.text();
    console.log(`\n\nHTTP status : ${response.status}`);
    console.log('Raw response:');
    console.log(text);
    throw new Error(`Responses API failed with HTTP ${response.status}`);
  }

  if (!response.body) {
    const text = await response.text();
    console.log(text);
    throw new Error('Responses API did not return a stream body');
  }

  const result = await consumeSseStream(response.body);

  console.log('\n\nResult summary');
  console.log(`  responseId  : ${result.responseId || '(not found)'}`);
  console.log(`  text length : ${result.rawText.length}`);

  if (!result.rawText) {
    console.log('\nNo streaming text was extracted.');
    console.log('The API call may still have succeeded, but the SSE event shape may differ.');
    if (result.completedPayload) {
      console.log('\nCompleted payload:');
      console.log(JSON.stringify(result.completedPayload, null, 2));
    }
  }

  return result;
}

async function main() {
  const options = parseArgs(process.argv);

  console.log('Bedrock Mantle connection tester');
  console.log(`  baseUrl     : ${options.baseUrl}`);
  console.log(`  apiKey      : ${maskApiKey(options.apiKey)}`);
  console.log(`  model       : ${options.model || '(not required for --models)'}`);
  console.log(`  timeoutMs   : ${options.timeoutMs}`);

  if (options.modelsOnly) {
    await listModels(options);
    return;
  }

  await callResponsesApi(options);
}

main().catch((error) => {
  console.error('\nERROR');
  console.error(`  ${error.message}`);
  process.exit(1);
});
