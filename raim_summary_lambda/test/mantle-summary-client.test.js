'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSummaryMantleClient } = require('../lib/mantle-summary-client');

const ENV = { MANTLE_MODEL: 'test-model', OPENAI_BASE_URL: 'https://example.test/v1' };
const OK_BODY = JSON.stringify({
  id: 'resp-1',
  output: [{ type: 'message', content: [{ type: 'output_text', text: '要約' }] }],
});

function makeClient(responses) {
  const calls = [];
  const sleeps = [];
  const fetchImpl = async () => {
    const next = responses[calls.length];
    calls.push(next);
    if (next instanceof Error) {
      throw next;
    }
    return { ok: next.status < 400, status: next.status, text: async () => next.body };
  };
  const client = createSummaryMantleClient({
    env: ENV,
    fetchImpl,
    apiKeyProvider: async () => 'key',
    sleep: async (ms) => { sleeps.push(ms); },
  });
  return { client, calls, sleeps };
}

const MESSAGES = [{ role: 'user', content: 'hi' }];

// 2026-11-06: 要約の時間切れ1回で、FIFO キューのその人の要約・記憶が15分止まった
test('a timed-out request is retried once and then succeeds', async () => {
  const abort = new Error('This operation was aborted');
  const { client, calls, sleeps } = makeClient([abort, { status: 200, body: OK_BODY }]);
  const result = await client({ messages: MESSAGES });
  assert.equal(result.text, '要約');
  assert.equal(calls.length, 2);
  assert.equal(sleeps.length, 1);
});

test('a 5xx is retried once, and a second failure goes back to the queue', async () => {
  const { client, calls } = makeClient([
    { status: 503, body: 'busy' },
    { status: 500, body: 'still busy' },
    { status: 200, body: OK_BODY },
  ]);
  await assert.rejects(client({ messages: MESSAGES }), /Mantle returned 500/);
  assert.equal(calls.length, 2);
});

test('a 4xx is not retried', async () => {
  const { client, calls } = makeClient([
    { status: 400, body: 'bad request' },
    { status: 200, body: OK_BODY },
  ]);
  await assert.rejects(client({ messages: MESSAGES }), /Mantle returned 400/);
  assert.equal(calls.length, 1);
});

test('a successful first request is not repeated', async () => {
  const { client, calls, sleeps } = makeClient([{ status: 200, body: OK_BODY }]);
  const result = await client({ messages: MESSAGES });
  assert.equal(result.responseId, 'resp-1');
  assert.equal(calls.length, 1);
  assert.equal(sleeps.length, 0);
});
