'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildMantleRequest,
  consumeMantleStream,
  createMantleClient,
  extractMantleOutputText,
  resolveMantleBaseUrl,
} = require('../lib/mantle-client');

const TEST_ENV = Object.freeze({
  OPENAI_BASE_URL: 'https://bedrock-mantle.us-east-1.api.aws/openai/v1',
  MANTLE_MODEL: 'mantle-model-1',
  MANTLE_TIMEOUT_MS: '1000',
});

// Mantle Client単体テストではSecrets Managerを実際に呼ばず、
// Secret取得処理とHTTP/SSE処理の境界を明確にするためproviderを注入する。
const TEST_API_KEY_PROVIDER = async () => 'test-secret';

function createSseBody(events) {
  const encoder = new TextEncoder();
  const payload = events.map((event) => [
    `event: ${event.type}`,
    `data: ${JSON.stringify(event)}`,
    '',
    '',
  ].join('\n')).join('');

  // 実通信と同様にイベント境界とは無関係な位置でchunkを分割する。
  const splitAt = Math.floor(payload.length / 2);
  const chunks = [payload.slice(0, splitAt), payload.slice(splitAt)];

  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

test('buildMantleRequest adds previous_response_id only for follow-up calls', () => {
  const request = buildMantleRequest({
    mantleInput: {
      messages: [{ role: 'user', content: 'hello' }],
    },
    previousResponseId: 'resp-previous',
    store: true,
  }, TEST_ENV);

  assert.equal(request.model, 'mantle-model-1');
  assert.equal(request.previous_response_id, 'resp-previous');
  assert.equal(request.store, true);
  assert.equal(request.stream, true);
  assert.equal(Object.hasOwn(request, 'temperature'), false);
  assert.deepEqual(request.input, [{ role: 'user', content: 'hello' }]);
});

test('resolveMantleBaseUrl builds the official regional Bedrock endpoint', () => {
  assert.equal(resolveMantleBaseUrl({ AWS_REGION: 'ap-northeast-1' }),
    'https://bedrock-mantle.us-east-1.api.aws/openai/v1');
  assert.equal(resolveMantleBaseUrl({ BEDROCK_MANTLE_REGION: 'us-west-2' }),
    'https://bedrock-mantle.us-west-2.api.aws/openai/v1');
});

test('createMantleClient streams the real Bedrock Responses API shape', async () => {
  let captured;
  const deltas = [];
  const client = createMantleClient({
    env: TEST_ENV,
    apiKeyProvider: TEST_API_KEY_PROVIDER,
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'request-1' },
        body: createSseBody([
          {
            type: 'response.created',
            response: { id: 'resp-1', created_at: 1782259200 },
          },
          {
            type: 'response.output_text.delta',
            delta: '{"text":"',
          },
          {
            type: 'response.output_text.delta',
            delta: 'やあ","emotion":"happy","intensity":0.6}',
          },
          {
            type: 'response.completed',
            response: { id: 'resp-1', created_at: 1782259200, status: 'completed' },
          },
        ]),
      };
    },
  });
  const result = await client({
    mantleInput: {
      mode: 'followup',
      messages: [{ role: 'user', content: 'こんにちは' }],
    },
    previousResponseId: 'resp-previous',
    store: true,
    onTextDelta: async (delta) => deltas.push(delta),
  });

  assert.equal(captured.url,
    'https://bedrock-mantle.us-east-1.api.aws/openai/v1/responses');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers.Authorization, 'Bearer test-secret');
  assert.equal(captured.options.headers.Accept, 'text/event-stream');
  const requestBody = JSON.parse(captured.options.body);
  assert.equal(requestBody.previous_response_id, 'resp-previous');
  assert.equal(requestBody.stream, true);
  assert.equal(Object.hasOwn(requestBody, 'temperature'), false);
  assert.equal(result.responseId, 'resp-1');
  assert.match(result.rawText, /"text":"やあ"/);
  assert.equal(result.usedPreviousResponseId, true);
  assert.deepEqual(deltas, [
    '{"text":"',
    'やあ","emotion":"happy","intensity":0.6}',
  ]);
});

test('createMantleClient exposes HTTP metadata for response_id recovery', async () => {
  const client = createMantleClient({
    env: TEST_ENV,
    apiKeyProvider: TEST_API_KEY_PROVIDER,
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      headers: { get: () => 'request-error' },
      text: async () => JSON.stringify({
        error: {
          code: 'not_found',
          message: 'previous_response_id was not found',
        },
      }),
    }),
  });

  await assert.rejects(
    () => client({
      mantleInput: { messages: [{ role: 'user', content: 'hello' }] },
      previousResponseId: 'expired-response',
    }),
    (error) => error.statusCode === 404 && error.code === 'not_found'
  );
});

test('extractMantleOutputText supports output_text aggregation', () => {
  assert.equal(extractMantleOutputText({ output_text: ' result ' }), 'result');
});

test('consumeMantleStream extracts usage for the summary trigger', async () => {
  const events = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-1","created_at":1700000000}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"こんにちは"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","status":"completed","usage":{"input_tokens":1800,"output_tokens":42}}}\n\n',
  ];

  // fetch の ReadableStream 互換（getReader を持つ形）
  const body = {
    getReader() {
      let i = 0;
      return {
        async read() {
          if (i >= events.length) return { done: true, value: undefined };
          return { done: false, value: new TextEncoder().encode(events[i++]) };
        },
        releaseLock() {},
      };
    },
  };

  const result = await consumeMantleStream(body, {});

  // トークン累積（要約トリガー）の入力になる
  assert.equal(result.usage.input_tokens, 1800);
  assert.equal(result.usage.output_tokens, 42);
});

test('consumeMantleStream returns null usage when absent', async () => {
  const events = [
    'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-1","created_at":1700000000}}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-1","status":"completed"}}\n\n',
  ];

  // fetch の ReadableStream 互換（getReader を持つ形）
  const body = {
    getReader() {
      let i = 0;
      return {
        async read() {
          if (i >= events.length) return { done: true, value: undefined };
          return { done: false, value: new TextEncoder().encode(events[i++]) };
        },
        releaseLock() {},
      };
    },
  };

  const result = await consumeMantleStream(body, {});
  assert.equal(result.usage, null);
});

// ── 返事が来ないときの頼み直し（2026-11-13: Mantle がたまに30秒黙っていた） ─────────

function abortError() {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

/** response.created だけ送って黙る（中断されたらエラーにする）本文 */
function silentBody(signal) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      const created = { type: 'response.created', response: { id: 'resp-hang' } };
      controller.enqueue(encoder.encode(`event: ${created.type}\ndata: ${JSON.stringify(created)}\n\n`));
      signal.addEventListener('abort', () => controller.error(abortError()));
    },
  });
}

function okResponse() {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'request-ok' },
    body: createSseBody([
      { type: 'response.created', response: { id: 'resp-ok', created_at: 1782259200 } },
      { type: 'response.output_text.delta', delta: '{"text":"やあ"}' },
      { type: 'response.completed', response: { id: 'resp-ok', created_at: 1782259200, status: 'completed' } },
    ]),
  };
}

const RETRY_ENV = Object.freeze({
  ...TEST_ENV,
  MANTLE_TIMEOUT_MS: '400',
  MANTLE_FIRST_OUTPUT_TIMEOUT_MS: '120',
  MANTLE_SLOW_NOTICE_MS: '50',
});

test('createMantleClient asks once more when nothing comes back in time, and says "wait"', async () => {
  let calls = 0;
  const stages = [];
  const client = createMantleClient({
    env: RETRY_ENV,
    apiKeyProvider: TEST_API_KEY_PROVIDER,
    fetchImpl: async (url, options) => {
      calls += 1;
      if (calls === 1) {
        // 届いたことは返すが、中身を送らずに黙る
        return { ok: true, status: 200, headers: { get: () => '' }, body: silentBody(options.signal) };
      }
      return okResponse();
    },
  });

  const result = await client({
    mantleInput: { mode: 'initial', messages: [{ role: 'user', content: 'こんにちは' }] },
    onWaiting: ({ stage }) => stages.push(stage),
  });

  assert.equal(calls, 2);
  assert.equal(result.responseId, 'resp-ok');
  assert.deepEqual(stages, ['slow', 'retry']);
});

test('createMantleClient also asks again when the request itself hangs', async () => {
  let calls = 0;
  const client = createMantleClient({
    env: RETRY_ENV,
    apiKeyProvider: TEST_API_KEY_PROVIDER,
    fetchImpl: (url, options) => {
      calls += 1;
      if (calls === 1) {
        return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(abortError()));
        });
      }
      return Promise.resolve(okResponse());
    },
  });

  const result = await client({ mantleInput: { mode: 'initial', messages: [{ role: 'user', content: 'やあ' }] } });
  assert.equal(calls, 2);
  assert.equal(result.responseId, 'resp-ok');
});

test('createMantleClient asks again only once, then times out as before', async () => {
  let calls = 0;
  const client = createMantleClient({
    env: RETRY_ENV,
    apiKeyProvider: TEST_API_KEY_PROVIDER,
    fetchImpl: async (url, options) => {
      calls += 1;
      return { ok: true, status: 200, headers: { get: () => '' }, body: silentBody(options.signal) };
    },
  });

  await assert.rejects(
    client({ mantleInput: { mode: 'initial', messages: [{ role: 'user', content: 'やあ' }] } }),
    (error) => error.code === 'MANTLE_TIMEOUT'
  );
  assert.equal(calls, 2);
});

test('createMantleClient does not ask again or say "wait" when the reply starts in time', async () => {
  let calls = 0;
  const stages = [];
  const client = createMantleClient({
    env: RETRY_ENV,
    apiKeyProvider: TEST_API_KEY_PROVIDER,
    fetchImpl: async () => {
      calls += 1;
      return okResponse();
    },
  });

  await client({ mantleInput: { mode: 'initial', messages: [{ role: 'user', content: 'やあ' }] }, onWaiting: ({ stage }) => stages.push(stage) });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(calls, 1);
  assert.deepEqual(stages, []);
});
