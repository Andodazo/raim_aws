#!/usr/bin/env node
/**
 * Bedrock Mantle connection tester for AWS CloudShell
 *
 * 目的:
 *   AWS CloudShell 上で、Mantle endpoint URL + API Key + model ID だけを使って
 *   Bedrock Mantle / Gemma 4 の疎通を確認します。
 *
 * このファイルは AWS SDK を使いません。
 * CloudShell の IAM ロール、Lambda の実行ロール、Secrets Manager、Bedrock Runtime
 * にはアクセスしません。
 *
 * つまり、このテストで確認する対象は次の3つだけです。
 *
 *   - Mantle endpoint URL が正しいこと
 *   - Mantle API Key が有効であること
 *   - 指定した Mantle model ID で生成APIを呼び出せること
 *
 * 通信時間として、次の値も実行結果へ表示します。
 *
 *   - response headers: リクエスト送信からHTTPレスポンスヘッダー受信まで
 *   - first chunk     : ストリーミングで最初のデータを受信するまで
 *   - total elapsed   : レスポンス本文またはストリームを最後まで受信するまで
 *
 * HTTPエラーやタイムアウトの場合も、エラーが確定するまでのtotal elapsedを表示します。
 *
 * RAiM の本命設定:
 *
 *   - region   : us-east-1
 *   - endpoint : https://bedrock-mantle.us-east-1.api.aws/openai/v1
 *   - model    : google.gemma-4-31b
 *
 * CloudShell での実行手順:
 *
 *   1. このファイルを CloudShell にアップロードする
 *
 *      CloudShell の「Actions」→「Upload file」から
 *      test_mantle_connection.js をアップロードします。
 *
 *   2. Node.js のバージョンを確認する
 *
 *      node -v
 *
 *      v18 以上であれば、このファイルは追加パッケージなしで実行できます。
 *      fetch API を使うため、古い Node.js では動きません。
 *
 *   3. Mantle API Key を環境変数に設定する
 *
 *      export OPENAI_API_KEY='実際の Mantle API Key'
 *
 *      OPENAI_BASE_URL と MANTLE_MODEL は本命値をデフォルトにしているため、
 *      通常は指定しなくても動きます。
 *      明示したい場合は以下も実行してください。
 *
 *      export OPENAI_BASE_URL='https://bedrock-mantle.us-east-1.api.aws/openai/v1'
 *      export MANTLE_MODEL='google.gemma-4-31b'
 *
 *   4. 生成APIを最小リクエストで確認する
 *
 *      node test_mantle_connection.js --minimal --no-stream --prompt 'こんにちは。短く挨拶してください。'
 *
 *   5. Responses API のストリーミングを確認する
 *
 *      node test_mantle_connection.js --minimal --debug-sse --prompt 'こんにちは。短く挨拶してください。'
 *
 *   6. 必要に応じてモデル一覧を確認する
 *
 *      node test_mantle_connection.js --models
 *
 *      モデルカードの本命確認は生成APIです。
 *      環境やAPI Keyの種類によって /models が 404 になる場合がありますが、
 *      その場合も生成APIの結果を優先して判断してください。
 *
 *   7. 参考として Chat Completions 互換 API を確認する
 *
 *      node test_mantle_connection.js --chat --minimal --no-stream --prompt 'こんにちは。短く挨拶してください。'
 *
 * 注意:
 *   API Key を --api-key で直接渡すこともできますが、CloudShell の履歴に残りやすいです。
 *   基本的には OPENAI_API_KEY 環境変数で渡してください。
 */

'use strict';

// RAiM の本命構成では、Gemma 4 31B を us-east-1 の Mantle endpoint で呼び出す。
// CloudShell で OPENAI_BASE_URL を指定し忘れても、本命 endpoint を使う。
const DEFAULT_BASE_URL = 'https://bedrock-mantle.us-east-1.api.aws/openai/v1';
const DEFAULT_MODEL = 'google.gemma-4-31b';
const DEFAULT_PROMPT = 'こんにちは。日本語で一言だけ挨拶してください。';

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.OPENAI_BASE_URL || process.env.MANTLE_BASE_URL || DEFAULT_BASE_URL,
    apiKey: process.env.OPENAI_API_KEY || process.env.MANTLE_API_KEY || '',
    // RAiM の本命モデル。CloudShell 側で MANTLE_MODEL または --model を指定すると差し替えられる。
    model: process.env.MANTLE_MODEL || DEFAULT_MODEL,
    prompt: DEFAULT_PROMPT,
    modelsOnly: false,
    jsonMode: false,
    stream: true,
    chat: false,
    minimal: false,
    debugSse: false,
    timeoutMs: Number(process.env.MANTLE_TIMEOUT_MS || 60000),
    streamIdleTimeoutMs: Number(process.env.MANTLE_STREAM_IDLE_TIMEOUT_MS || 15000),
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--models') {
      options.modelsOnly = true;
    } else if (arg === '--json') {
      options.jsonMode = true;
      options.prompt = [
        '次の形式の JSON だけを返してください。',
        '{"text":"短い返答","emotion":"happy","intensity":0.5}',
        'ユーザーへの返答: こんにちは',
      ].join('\n');
    } else if (arg === '--no-stream') {
      options.stream = false;
    } else if (arg === '--chat') {
      options.chat = true;
    } else if (arg === '--minimal') {
      options.minimal = true;
    } else if (arg === '--debug-sse') {
      options.debugSse = true;
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
    } else if (arg === '--stream-idle-timeout-ms') {
      options.streamIdleTimeoutMs = Number(readValue(argv, ++i, arg));
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

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error('--timeout-ms must be a positive number');
  }

  if (!Number.isFinite(options.streamIdleTimeoutMs) || options.streamIdleTimeoutMs <= 0) {
    throw new Error('--stream-idle-timeout-ms must be a positive number');
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
  console.log(`Bedrock Mantle connection tester for AWS CloudShell

CloudShell setup:
  export OPENAI_API_KEY='your Mantle API Key'

Optional explicit RAiM defaults:
  export OPENAI_BASE_URL='https://bedrock-mantle.us-east-1.api.aws/openai/v1'
  export MANTLE_MODEL='google.gemma-4-31b'

Usage:
  node test_mantle_connection.js --minimal --no-stream --prompt 'こんにちは'
  node test_mantle_connection.js --minimal --debug-sse --prompt 'こんにちは'
  node test_mantle_connection.js --models
  node test_mantle_connection.js --chat --minimal --no-stream --prompt 'こんにちは'
  node test_mantle_connection.js --json

Environment variables:
  OPENAI_API_KEY                  required: Mantle API Key
  OPENAI_BASE_URL                 optional: default https://bedrock-mantle.us-east-1.api.aws/openai/v1
  MANTLE_MODEL                    optional: default google.gemma-4-31b
  MANTLE_TIMEOUT_MS               optional: whole request timeout, default 60000
  MANTLE_STREAM_IDLE_TIMEOUT_MS   optional: streaming idle timeout, default 15000

Options:
  --base-url URL
  --api-key KEY
  --model MODEL_ID
  --prompt TEXT
  --models
  --json
  --no-stream
  --chat
  --minimal
  --debug-sse
  --timeout-ms N
  --stream-idle-timeout-ms N
`);
}

function maskApiKey(apiKey) {
  if (!apiKey) return '(empty)';
  if (apiKey.length <= 8) return `${apiKey[0] || ''}***`;
  return `${apiKey.slice(0, 4)}...${apiKey.slice(-4)} (${apiKey.length} chars)`;
}

/**
 * 通信時間の計測には、PCの時計を変更しても値が飛ばない単調増加時計を使う。
 * Date.now()ではなくprocess.hrtime.bigint()を使うことで、ミリ秒未満まで測定できる。
 */
function createRequestTimer() {
  const startedAt = process.hrtime.bigint();

  return {
    elapsedMs() {
      return Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    },
  };
}

function formatElapsed(milliseconds) {
  return `${milliseconds.toFixed(1)} ms (${(milliseconds / 1000).toFixed(3)} s)`;
}

async function fetchWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs} ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function listModels(options) {
  const url = `${options.baseUrl}/models`;
  const timer = createRequestTimer();
  let completedMs;

  try {
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        Accept: 'application/json',
      },
    }, options.timeoutMs);

    const responseHeadersMs = timer.elapsedMs();
    const text = await response.text();
    completedMs = timer.elapsedMs();

    console.log('\nModels API');
    console.log(`  URL             : ${url}`);
    console.log(`  HTTP status     : ${response.status}`);
    console.log(`  response headers: ${formatElapsed(responseHeadersMs)}`);

    if (!response.ok) {
      console.log('\nRaw response:');
      console.log(text);
      throw new Error(`Models API failed with HTTP ${response.status}`);
    }

    const payload = parseJsonOrThrow(text, 'Models API');
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
  } finally {
    // HTTPエラーやタイムアウトの場合も、失敗が確定するまでの時間を必ず表示する。
    console.log(`\n  total elapsed   : ${formatElapsed(completedMs ?? timer.elapsedMs())}`);
  }
}

function buildInputMessages(options) {
  return [
    {
      role: 'system',
      content: options.jsonMode
        ? 'あなたは RAiM の応答生成テストです。必ず JSON だけを返してください。'
        : 'あなたは接続確認用のアシスタントです。日本語で短く返答してください。',
    },
    {
      role: 'user',
      content: options.prompt,
    },
  ];
}

function buildResponsesRequest(options) {
  if (options.minimal) {
    // Gemma 4 31B のモデルカードにある Responses API サンプルでは、
    // input に messages 配列ではなく、単純な文字列を渡している。
    // 500 エラーの切り分けでは、まず公式サンプルと同じ最小形に寄せる。
    const request = {
      model: options.model,
      input: options.prompt,
      max_output_tokens: 512,
    };

    if (options.stream) {
      request.stream = true;
    }

    return request;
  }

  return {
    model: options.model,
    input: buildInputMessages(options),
    store: false,
    stream: options.stream,
    max_output_tokens: 256,
    temperature: 0.3,
  };
}

function buildChatCompletionsRequest(options) {
  if (options.minimal) {
    const request = {
      model: options.model,
      messages: [
        {
          role: 'user',
          content: options.prompt,
        },
      ],
    };

    if (options.stream) {
      request.stream = true;
    }

    return request;
  }

  return {
    model: options.model,
    messages: buildInputMessages(options),
    stream: options.stream,
    max_tokens: 256,
    temperature: 0.3,
  };
}

function parseJsonOrThrow(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    console.log('\nRaw response:');
    console.log(text);
    throw new Error(`${label} returned non-JSON: ${error.message}`);
  }
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
  if (typeof payload.delta === 'string') return payload.delta;
  if (typeof payload.text === 'string') return payload.text;
  if (typeof payload.output_text === 'string') return payload.output_text;

  if (typeof payload.response?.output_text === 'string') {
    return payload.response.output_text;
  }

  if (typeof payload.choices?.[0]?.delta?.content === 'string') {
    return payload.choices[0].delta.content;
  }

  return '';
}

function extractTextDeep(value) {
  const found = [];

  function visit(node) {
    if (!node || typeof node !== 'object') return;

    if (typeof node.output_text === 'string') found.push(node.output_text);
    if (typeof node.text === 'string') found.push(node.text);
    if (typeof node.content === 'string') found.push(node.content);
    if (typeof node.message?.content === 'string') found.push(node.message.content);

    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }

    for (const child of Object.values(node)) {
      visit(child);
    }
  }

  visit(value);
  return [...new Set(found)].join('');
}

async function readWithIdleTimeout(reader, idleTimeoutMs) {
  let timeout;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`No streaming chunk received for ${idleTimeoutMs} ms`));
    }, idleTimeoutMs);
  });

  try {
    return await Promise.race([reader.read(), timeoutPromise]);
  } finally {
    clearTimeout(timeout);
  }
}

async function consumeSseStream(body, options, onFirstChunk) {
  const decoder = new TextDecoder('utf-8');
  const reader = body.getReader();
  let buffer = '';
  let rawText = '';
  let responseId = '';
  let completedPayload = null;
  let eventCount = 0;
  let receivedFirstChunk = false;

  while (true) {
    const { value, done } = await readWithIdleTimeout(reader, options.streamIdleTimeoutMs);

    // fetch()はレスポンスヘッダーを受信した時点で完了する。
    // ストリーミング本文が実際に届いた時刻はここで別途記録する。
    if (!receivedFirstChunk && value && value.byteLength > 0) {
      receivedFirstChunk = true;
      onFirstChunk?.();
    }

    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    let separatorIndex;
    while ((separatorIndex = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex).replace(/^\r?\n/, '');
      const parsed = parseSseBlock(block);

      if (!parsed) continue;
      eventCount += 1;

      if (options.debugSse) {
        console.log(`\n[SSE event ${eventCount}] ${parsed.event || '(no event name)'}`);
        console.log(parsed.data);
      }

      if (parsed.data === '[DONE]') {
        return { rawText, responseId, completedPayload, eventCount };
      }

      let payload;
      try {
        payload = JSON.parse(parsed.data);
      } catch {
        continue;
      }

      if (!responseId && typeof payload.id === 'string') responseId = payload.id;
      if (!responseId && typeof payload.response?.id === 'string') responseId = payload.response.id;

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
      return { rawText, responseId, completedPayload, eventCount };
    }
  }
}

async function callGenerationApi(options) {
  const path = options.chat ? '/chat/completions' : '/responses';
  const url = `${options.baseUrl}${path}`;
  const requestBody = options.chat
    ? buildChatCompletionsRequest(options)
    : buildResponsesRequest(options);

  console.log(`\n${options.chat ? 'Chat Completions API' : 'Responses API'}`);
  console.log(`  URL         : ${url}`);
  console.log(`  model       : ${options.model}`);
  console.log(`  stream      : ${options.stream}`);
  console.log(`  minimal     : ${options.minimal}`);
  const timer = createRequestTimer();
  let responseHeadersMs;
  let firstChunkMs;
  let completedMs;

  try {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
        Accept: options.stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(requestBody),
    }, options.timeoutMs);

    responseHeadersMs = timer.elapsedMs();
    console.log(`  HTTP status     : ${response.status}`);

    if (!response.ok) {
      const text = await response.text();
      completedMs = timer.elapsedMs();
      console.log('\nRaw response:');
      console.log(text);
      throw new Error(`Generation API failed with HTTP ${response.status}`);
    }

    if (!options.stream) {
      const text = await response.text();
      completedMs = timer.elapsedMs();
      const payload = parseJsonOrThrow(text, 'Generation API');
      const extractedText = extractTextDeep(payload);

      console.log('\nExtracted text:');
      console.log(extractedText || '(text not found)');
      console.log('\nRaw JSON:');
      console.log(JSON.stringify(payload, null, 2));
      return { rawText: extractedText, eventCount: 0 };
    }

    if (!response.body) {
      const text = await response.text();
      completedMs = timer.elapsedMs();
      console.log(text);
      throw new Error('Generation API did not return a stream body');
    }

    console.log('\nStreaming text:');
    const result = await consumeSseStream(response.body, options, () => {
      firstChunkMs = timer.elapsedMs();
    });
    completedMs = timer.elapsedMs();

    console.log('\n\nResult summary');
    console.log(`  responseId  : ${result.responseId || '(not found)'}`);
    console.log(`  eventCount  : ${result.eventCount}`);
    console.log(`  text length : ${result.rawText.length}`);

    if (!result.rawText) {
      console.log('\nNo streaming text was extracted.');
      console.log('Try --debug-sse or --no-stream to inspect the actual response shape.');
      if (result.completedPayload) {
        console.log('\nCompleted payload:');
        console.log(JSON.stringify(result.completedPayload, null, 2));
      }
    }

    return result;
  } finally {
    console.log('\nTiming');
    if (responseHeadersMs !== undefined) {
      console.log(`  response headers: ${formatElapsed(responseHeadersMs)}`);
    }
    if (firstChunkMs !== undefined) {
      console.log(`  first chunk     : ${formatElapsed(firstChunkMs)}`);
    }
    // 非ストリーミングでは本文全体、ストリーミングでは終了イベントまでを合計時間とする。
    // 途中で失敗した場合は、エラーが確定するまでに経過した時間になる。
    console.log(`  total elapsed   : ${formatElapsed(completedMs ?? timer.elapsedMs())}`);
  }
}

async function main() {
  const options = parseArgs(process.argv);

  console.log('Bedrock Mantle connection tester');
  console.log(`  baseUrl               : ${options.baseUrl}`);
  console.log(`  apiKey                : ${maskApiKey(options.apiKey)}`);
  console.log(`  model                 : ${options.model || '(not required for --models)'}`);
  console.log(`  timeoutMs             : ${options.timeoutMs}`);
  console.log(`  streamIdleTimeoutMs   : ${options.streamIdleTimeoutMs}`);

  if (options.modelsOnly) {
    await listModels(options);
    return;
  }

  await callGenerationApi(options);
}

main().catch((error) => {
  console.error('\nERROR');
  console.error(`  ${error.message}`);
  process.exit(1);
});
