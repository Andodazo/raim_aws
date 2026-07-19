#!/usr/bin/env node
/**
 * Bedrock Mantle ツール呼び出し（Function Calling）形式の検証スクリプト
 *
 * 【なぜこれが必要か】
 *
 * Core Lambdaのツールループは、Responses APIが次の形式で動くことを前提に実装している。
 *
 *   リクエスト:
 *     tools: [{ type: 'function', name, description, parameters }]   ← フラット形式
 *
 *   レスポンス（SSE）:
 *     response.output_item.done で item.type === 'function_call'
 *     item: { call_id, name, arguments }   ← argumentsはJSON文字列
 *
 *   ツール結果の返却:
 *     input: [{ type: 'function_call_output', call_id, output }]
 *
 * これはOpenAI Responses APIの仕様だが、Mantleの実装には差異が報告されている
 * （created_atがfloatで返る、contentの配列形式を弾く等）。
 *
 * Lambdaへデプロイする前に、実機で実際の形式を確認する。
 *
 * 【使い方】
 *
 *   export OPENAI_API_KEY='Mantle API Key'
 *   node test_mantle_tools.js
 *
 *   # 別モデルで試す
 *   node test_mantle_tools.js --model google.gemma-4-26b-a4b
 *
 *   # 非ストリーミングで生JSONを見る（形式確認にはこちらが分かりやすい）
 *   node test_mantle_tools.js --no-stream
 *
 *   # ツール結果を返す2往復目まで実行する
 *   node test_mantle_tools.js --full
 *
 * 【確認したいこと】
 *
 *   1. tools をフラット形式で送って 400 にならないか
 *   2. ツール呼出が function_call として返るか（tool_calls形式ではないか）
 *   3. call_id / name / arguments のフィールド名は想定どおりか
 *   4. ツール呼出時、本文（output_text）が空になるか
 *   5. function_call_output でツール結果を返せるか
 */

'use strict';

const DEFAULT_BASE_URL = 'https://bedrock-mantle.us-west-2.api.aws/openai/v1';
const DEFAULT_MODEL = 'google.gemma-4-31b';

// Core Lambdaと同じツール定義（Responses APIのフラット形式）
const TOOLS = [
  {
    type: 'function',
    name: 'get_weather',
    description: '指定された都市の現在の天気情報を取得します。',
    parameters: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: '都市名（英語表記）。例: Tokyo, Osaka',
        },
      },
      required: ['city'],
    },
  },
];

function parseArgs(argv) {
  const options = {
    baseUrl: process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL,
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.MANTLE_MODEL || DEFAULT_MODEL,
    prompt: '東京の天気を教えて',
    stream: true,
    full: false,
    reasoningEffort: 'none',
    timeoutMs: 60000,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--no-stream') options.stream = false;
    else if (arg === '--full') options.full = true;
    else if (arg === '--model') options.model = argv[++i];
    else if (arg === '--prompt') options.prompt = argv[++i];
    else if (arg === '--reasoning') options.reasoningEffort = argv[++i];
    else if (arg === '--base-url') options.baseUrl = argv[++i];
    else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!options.apiKey) {
    throw new Error('OPENAI_API_KEY is required');
  }

  options.baseUrl = options.baseUrl.replace(/\/$/, '');
  return options;
}

async function callResponses(options, inputItems, { withTools = true, previousResponseId = '' } = {}) {
  const request = {
    model: options.model,
    input: inputItems,
    max_output_tokens: 512,
    stream: options.stream,
  };

  if (options.reasoningEffort && options.reasoningEffort !== 'off') {
    request.reasoning = { effort: options.reasoningEffort };
  }

  if (withTools) {
    request.tools = TOOLS;
    request.tool_choice = 'auto';
  }

  if (previousResponseId) {
    request.previous_response_id = previousResponseId;
  }

  console.log('\n──────────────────────────────────────');
  console.log('REQUEST');
  console.log(JSON.stringify(request, null, 2));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetch(`${options.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
        Accept: options.stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(request),
      signal: controller.signal,
    });

    console.log(`\nHTTP status: ${response.status}`);

    if (!response.ok) {
      const text = await response.text();
      console.log('\nERROR BODY:');
      console.log(text);
      throw new Error(`Request failed with HTTP ${response.status}`);
    }

    if (!options.stream) {
      const payload = await response.json();
      console.log('\nRAW RESPONSE:');
      console.log(JSON.stringify(payload, null, 2));
      return analyzeOutput(payload);
    }

    return await consumeStream(response.body);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * SSEを読み、ツール呼出と本文を抽出する。
 * Core Lambdaの mantle-client.js と同じ解釈ロジックで動くかを確認する。
 */
async function consumeStream(body) {
  const decoder = new TextDecoder('utf-8');
  const reader = body.getReader();

  let buffer = '';
  let rawText = '';
  let responseId = '';
  let completedResponse = null;
  const toolCalls = [];
  const eventTypes = new Set();

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    let sepIndex;
    while ((sepIndex = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex).replace(/^\r?\n\r?\n/, '');

      const dataLine = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('');

      if (!dataLine || dataLine === '[DONE]') continue;

      let event;
      try {
        event = JSON.parse(dataLine);
      } catch {
        continue;
      }

      if (event.type) eventTypes.add(event.type);

      if (event.type === 'response.output_text.delta') {
        rawText += String(event.delta || '');
      }

      // ここが本命。ツール呼出がどのイベントで、どんな形で返るか
      if (event.type === 'response.output_item.done' && event.item) {
        console.log(`\n[output_item.done] type = ${event.item.type}`);
        console.log(JSON.stringify(event.item, null, 2));

        if (event.item.type === 'function_call') {
          toolCalls.push(event.item);
        }
      }

      if (event.response) {
        responseId = event.response.id || responseId;
        if (event.type === 'response.completed') {
          completedResponse = event.response;
        }
      }
    }

    if (done) break;
  }

  console.log('\n[SSE event types observed]');
  console.log([...eventTypes].sort().join('\n'));

  if (completedResponse) {
    console.log('\n[completed response.output]');
    console.log(JSON.stringify(completedResponse.output, null, 2));
  }

  return { responseId, rawText, toolCalls, completedResponse };
}

function analyzeOutput(payload) {
  const output = Array.isArray(payload.output) ? payload.output : [];
  const toolCalls = output.filter((item) => item.type === 'function_call');

  let rawText = '';
  for (const item of output) {
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (typeof part.text === 'string') rawText += part.text;
      }
    }
  }

  return { responseId: payload.id, rawText, toolCalls, completedResponse: payload };
}

function report(result) {
  console.log('\n══════════════════════════════════════');
  console.log('検証結果');
  console.log('══════════════════════════════════════');

  console.log(`response id     : ${result.responseId || '(なし)'}`);
  console.log(`本文の長さ       : ${result.rawText.length}`);
  console.log(`ツール呼出の件数  : ${result.toolCalls.length}`);

  if (result.toolCalls.length === 0) {
    console.log('\n⚠️  ツールが呼ばれませんでした。');
    console.log('   モデルが自力で答えられると判断した可能性があります。');
    console.log('   --prompt で「今日の東京の天気を調べて」のように調べ物を明示してみてください。');
    return;
  }

  const call = result.toolCalls[0];

  console.log('\n[ツール呼出のフィールド]');
  console.log(`  call_id   : ${call.call_id ?? '(なし)'} ${call.call_id ? '✓' : '← Core Lambdaはcall_idを期待'}`);
  console.log(`  name      : ${call.name ?? '(なし)'}`);
  console.log(`  arguments : ${typeof call.arguments} → ${JSON.stringify(call.arguments)}`);

  if (result.rawText.length === 0) {
    console.log('\n✓ ツール呼出時に本文が空。Gemmaの既知の挙動どおり。');
    console.log('  → 「調べるね」の発話はサーバー側の固定セリフで出す設計で正しい。');
  } else {
    console.log('\n! ツール呼出と同時に本文も返ってきた。');
    console.log('  → 固定セリフではなくLLMの発話を使える可能性がある。');
  }

  console.log('\n[Core Lambdaの実装と一致するか]');
  console.log(`  フラット形式のtools送信  : ${'✓ 400にならなかった'}`);
  console.log(`  function_call として返る : ${call.type === 'function_call' ? '✓' : `✗ 実際は ${call.type}`}`);
  console.log(`  argumentsはJSON文字列    : ${typeof call.arguments === 'string' ? '✓' : '! objectで返っている（parseToolArgumentsが吸収する）'}`);
}

async function main() {
  const options = parseArgs(process.argv);

  console.log('Bedrock Mantle ツール呼び出し検証');
  console.log(`  baseUrl   : ${options.baseUrl}`);
  console.log(`  model     : ${options.model}`);
  console.log(`  reasoning : ${options.reasoningEffort}`);
  console.log(`  stream    : ${options.stream}`);
  console.log(`  prompt    : ${options.prompt}`);

  // 1往復目: ツール呼出を引き出す
  const first = await callResponses(options, options.prompt);
  report(first);

  if (!options.full || first.toolCalls.length === 0) {
    return;
  }

  // 2往復目: ツール結果を返して最終応答を作らせる
  const call = first.toolCalls[0];

  const toolResult = {
    city: 'Tokyo',
    weather: 'Clear',
    description: '快晴',
    temp: 24,
  };

  console.log('\n══════════════════════════════════════');
  console.log('2往復目: ツール結果を function_call_output で返す');
  console.log('══════════════════════════════════════');

  const second = await callResponses(
    options,
    [
      {
        type: 'function_call_output',
        call_id: call.call_id,
        output: JSON.stringify(toolResult),
      },
    ],
    { withTools: true, previousResponseId: first.responseId }
  );

  console.log('\n[最終応答]');
  console.log(second.rawText || '(本文なし)');

  if (second.rawText.includes('24') || second.rawText.includes('晴')) {
    console.log('\n✓ ツール結果が応答へ反映されている。ツールループは成立する。');
  } else {
    console.log('\n⚠️  ツール結果が反映されていない可能性がある。');
    console.log('   プロンプトの「ツール結果の扱い方」を強化する必要があるかもしれない。');
  }
}

main().catch((error) => {
  console.error('\nERROR');
  console.error(`  ${error.message}`);
  process.exit(1);
});
