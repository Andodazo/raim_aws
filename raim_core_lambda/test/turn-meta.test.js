'use strict';

// 会話の記録に残す分析用の meta（Scene・ツール・プロンプト版・reasoning）

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCoreChatService } = require('../lib/core-chat-service');
const { buildMessageRecord } = require('../lib/conversation-thread-store');
const { TOOL_DEFINITIONS } = require('../lib/tools');

test('buildMessageRecord keeps meta for assistant and drops empty values', () => {
  const record = buildMessageRecord({
    role: 'assistant',
    text: 'やあ',
    meta: {
      sceneId: 'gaming',
      sceneReason: '',
      sceneScore: undefined,
      tools: [],
      factCheck: false,
      promptVersion: 'raim-system-v5.1-bright',
      reasoningEffort: 'low',
      extra: null,
    },
  });

  assert.deepEqual(record.meta, {
    sceneId: 'gaming',
    factCheck: false,
    promptVersion: 'raim-system-v5.1-bright',
    reasoningEffort: 'low',
  });
});

test('buildMessageRecord never stores meta on user messages', () => {
  const record = buildMessageRecord({ role: 'user', text: 'こんにちは', meta: { sceneId: 'default' } });
  assert.equal(record.meta, undefined);
});

test('buildMessageRecord omits meta when everything is empty', () => {
  const record = buildMessageRecord({ role: 'assistant', text: 'x', meta: { sceneId: '', tools: [] } });
  assert.equal(record.meta, undefined);
});

function createService({ appended, responses, env = {}, executeTool }) {
  let index = 0;
  return createCoreChatService({
    env,
    getOrCreateUserSession: async () => ({ sessionSummary: '' }),
    getMantleSessionState: () => ({ usePreviousResponseId: false, previousResponseId: '' }),
    isMantleResponseExpiredError: () => false,
    clearMantleResponseState: async () => {},
    updateMantleResponseState: async () => {},
    resolveThread: async () => ({ threadId: 'thread-meta', thread: null, isNew: false }),
    ensureThreadTitle: async () => {},
    appendTurn: async (params) => { appended.push(params); return {}; },
    shouldSummarize: () => ({ shouldSummarize: false, reason: null }),
    dispatchSummarization: async () => true,
    listSceneCandidates: async () => [],
    selectScene: async () => ({ sceneId: 'question', reason: 'question-form', score: 0.21234 }),
    getSceneById: async (id) => ({ id, few_shots: [] }),
    buildMantleInput: ({ withTools }) => ({
      mode: 'initial',
      promptVersion: 'raim-system-v5.1-bright',
      withTools,
      messages: [{ role: 'user', content: 'x' }],
    }),
    createMantleResponse: async () => {
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return response;
    },
    maxToolTurns: 2,
    isToolUseEnabled: async () => true,
    getToolDefinitions: () => TOOL_DEFINITIONS,
    executeTool: executeTool || (async () => ({ ok: true })),
    onToolCallStart: async () => {},
  });
}

test('Core chat service saves scene, tools and settings in assistant meta', async () => {
  const appended = [];
  const service = createService({
    appended,
    env: { MANTLE_REASONING_EFFORT: 'low', FACT_CHECK_SEARCH: 'true' },
    responses: [
      {
        responseId: 'resp-1',
        rawText: '',
        createdAt: '2026-10-07T00:00:00Z',
        toolCalls: [{ callId: 'c1', name: 'web_search', arguments: '{"query":"ジェラードン メンバー"}' }],
      },
      {
        responseId: 'resp-2',
        rawText: JSON.stringify({ emotions: { neutral: 1 }, text: '今は2人組みたい' }),
        createdAt: '2026-10-07T00:00:01Z',
        toolCalls: [],
      },
    ],
  });

  await service({
    schemaVersion: 1,
    type: 'chat.request',
    requestId: 'req-1',
    sub: 'user-1',
    source: 'websocket',
    text: 'ジェラードンって知ってる？',
    images: [],
  });

  assert.equal(appended.length, 1);
  const meta = appended[0].assistantMessage.meta;
  assert.equal(meta.sceneId, 'question');
  assert.equal(meta.sceneReason, 'question-form');
  assert.equal(meta.sceneScore, 0.212);
  assert.deepEqual(meta.tools, [{ name: 'web_search', query: 'ジェラードン メンバー', ok: true }]);
  assert.equal(meta.factCheck, true);
  assert.equal(meta.promptVersion, 'raim-system-v5.1-bright');
  assert.equal(meta.mode, 'initial');
  assert.equal(meta.reasoningEffort, 'low');
});

test('Core chat service marks failed and repeated tool calls in meta', async () => {
  const appended = [];
  const call = { callId: 'c1', name: 'get_weather', arguments: '{"city":"Tokyo"}' };
  const service = createService({
    appended,
    executeTool: async () => ({ error: 'timeout' }),
    responses: [
      { responseId: 'r1', rawText: '', createdAt: '2026-10-07T00:00:00Z', toolCalls: [call] },
      { responseId: 'r2', rawText: '', createdAt: '2026-10-07T00:00:01Z', toolCalls: [{ ...call, callId: 'c2' }] },
      {
        responseId: 'r3',
        rawText: JSON.stringify({ emotions: { sad: 1 }, text: 'ごめん、見られなかった' }),
        createdAt: '2026-10-07T00:00:02Z',
        toolCalls: [],
      },
    ],
  });

  await service({
    schemaVersion: 1,
    type: 'chat.request',
    requestId: 'req-2',
    sub: 'user-1',
    source: 'websocket',
    text: '東京の天気は？',
    images: [],
  });

  const meta = appended[0].assistantMessage.meta;
  assert.deepEqual(meta.tools[0], { name: 'get_weather', query: 'Tokyo', ok: false });
  assert.deepEqual(meta.tools[1], { name: 'get_weather', skipped: 'duplicate' });
  // 環境変数が無ければ none と記録する
  assert.equal(meta.reasoningEffort, 'none');
});
