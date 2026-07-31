'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createCoreChatService } = require('../lib/core-chat-service');
const {
  parseToolArguments,
  makeToolCallKey,
  pickToolIntro,
  TOOL_DEFINITIONS,
} = require('../lib/tools');

// ─────────────────────────────────────────────
// テスト用の共通セットアップ
// ─────────────────────────────────────────────

const BASE_EVENT = {
  schemaVersion: 1,
  type: 'chat.request',
  requestId: 'req-1',
  connectionId: 'conn-1',
  sub: 'user-1',
  source: 'websocket',
  text: '東京の天気は？',
  images: [],
};

/**
 * Mantle応答を順番に返すスタブを作る。
 * 呼出ごとのリクエスト内容も記録し、tools有無などを検証できるようにする。
 */
function createMantleStub(responses) {
  const calls = [];
  let index = 0;

  const createMantleResponse = async (args) => {
    calls.push(args);
    const response = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return response;
  };

  return { createMantleResponse, calls };
}

function buildDependencies({ mantleStub, toolResults = {}, toolsEnabled = true, overrides = {} }) {
  const executedTools = [];
  const toolNotifications = [];

  return {
    dependencies: {
      getOrCreateUserSession: async () => ({ sessionSummary: '' }),
      getMantleSessionState: () => ({
        usePreviousResponseId: false,
        previousResponseId: '',
      }),
      isMantleResponseExpiredError: () => false,
      clearMantleResponseState: async () => {},
      updateMantleResponseState: async () => {},
      // 案A: 会話履歴の自前保存はここでは検証対象外
      resolveThread: async () => ({ threadId: 'thread-test', thread: null, isNew: false }),
      ensureThreadTitle: async () => {},
      appendTurn: async () => ({}),
    shouldSummarize: () => ({ shouldSummarize: false, reason: null }),
    dispatchSummarization: async () => true,
      listSceneCandidates: async () => [],
      selectScene: async () => ({ sceneId: 'default' }),
      getSceneById: async () => ({ id: 'default', few_shots: [] }),
      buildMantleInput: ({ withTools }) => ({
        mode: 'initial',
        withTools,
        messages: [{ role: 'user', content: BASE_EVENT.text }],
      }),
      createMantleResponse: mantleStub.createMantleResponse,

      // ツールループ
      maxToolTurns: 2,
      isToolUseEnabled: async () => toolsEnabled,
      getToolDefinitions: () => TOOL_DEFINITIONS,
      executeTool: async (name, args) => {
        executedTools.push({ name, args });
        return toolResults[name] || { ok: true };
      },
      onToolCallStart: async (info) => {
        toolNotifications.push(info);
      },

      ...overrides,
    },
    executedTools,
    toolNotifications,
  };
}

// ─────────────────────────────────────────────
// ツール引数のユーティリティ
// ─────────────────────────────────────────────

test('parseToolArguments accepts both JSON string and object', () => {
  // Responses APIはJSON文字列で返す
  assert.deepEqual(parseToolArguments('{"city":"Tokyo"}'), { city: 'Tokyo' });

  // ローカルのOllamaはobjectで返していた
  assert.deepEqual(parseToolArguments({ city: 'Tokyo' }), { city: 'Tokyo' });

  // 壊れたJSONでも落ちない
  assert.deepEqual(parseToolArguments('{broken'), {});
  assert.deepEqual(parseToolArguments(null), {});
});

test('makeToolCallKey is stable regardless of key order', () => {
  const a = makeToolCallKey('get_weather', { city: 'Tokyo', country_code: 'JP' });
  const b = makeToolCallKey('get_weather', { country_code: 'JP', city: 'Tokyo' });

  assert.equal(a, b);
});

test('pickToolIntro returns a character-appropriate line per turn', () => {
  // randomを固定して先頭要素を選ばせる
  const first = pickToolIntro('get_weather', 1, () => 0);
  const second = pickToolIntro('get_weather', 2, () => 0);

  assert.equal(first, '天気見てくる、ちょっと待って');
  assert.equal(second, '他の地域の天気も確認するね');

  // 未知のツールでもフォールバックする
  assert.equal(pickToolIntro('unknown_tool', 1, () => 0), 'えっと、ちょっと待って');
});

test('TOOL_DEFINITIONS use the flat Responses API schema', () => {
  for (const tool of TOOL_DEFINITIONS) {
    assert.equal(tool.type, 'function');

    // Responses APIはフラット形式。functionをネストしない。
    assert.ok(tool.name, 'name must be at top level');
    assert.equal(tool.function, undefined, 'must not nest under function');
    assert.ok(tool.parameters);
  }
});

// ─────────────────────────────────────────────
// ツールループ本体
// ─────────────────────────────────────────────

test('executes a tool call and feeds the result back to Mantle', async () => {
  const mantleStub = createMantleStub([
    // 1回目: ツール呼出。Gemmaは本文を返さない（rawTextが空）
    {
      responseId: 'resp-1',
      rawText: '',
      createdAt: '2026-07-14T00:00:00Z',
      toolCalls: [
        { callId: 'call-1', name: 'get_weather', arguments: '{"city":"Tokyo"}' },
      ],
    },
    // 2回目: ツール結果を踏まえた最終応答
    {
      responseId: 'resp-2',
      rawText: JSON.stringify({
        text: '東京は晴れで24度だって',
        emotions: { happy: 0.5, caring: 0.3 },
      }),
      createdAt: '2026-07-14T00:00:01Z',
      toolCalls: [],
    },
  ]);

  const { dependencies, executedTools, toolNotifications } = buildDependencies({
    mantleStub,
    toolResults: {
      get_weather: { city: 'Tokyo', weather: 'Clear', temp: 24 },
    },
  });

  const handleCoreChat = createCoreChatService(dependencies);
  const result = await handleCoreChat(BASE_EVENT);

  // ツールが実行された
  assert.equal(executedTools.length, 1);
  assert.equal(executedTools[0].name, 'get_weather');
  assert.deepEqual(executedTools[0].args, { city: 'Tokyo' });

  // 前置きセリフがクライアントへ通知された
  assert.equal(toolNotifications.length, 1);
  assert.equal(toolNotifications[0].toolName, 'get_weather');
  assert.ok(toolNotifications[0].introText.length > 0);

  // 2回目の呼出にはツール結果がfunction_call_outputとして入る
  const secondCall = mantleStub.calls[1];
  const toolOutputItem = secondCall.mantleInput.messages[0];
  assert.equal(toolOutputItem.type, 'function_call_output');
  assert.equal(toolOutputItem.call_id, 'call-1');
  assert.ok(toolOutputItem.output.includes('Clear'));

  // ツール結果を踏まえた応答が返る
  assert.equal(result.ok, true);
  assert.equal(result.text, '東京は晴れで24度だって');
  assert.equal(result.emotion, 'happy');
});

test('stops the loop when the same tool call repeats', async () => {
  // 同じツールを同じ引数で呼び続けるMantleを模擬する
  const loopingResponse = {
    responseId: 'resp-loop',
    rawText: '',
    createdAt: '2026-07-14T00:00:00Z',
    toolCalls: [
      { callId: 'call-x', name: 'web_search', arguments: '{"query":"AI"}' },
    ],
  };

  const finalResponse = {
    responseId: 'resp-final',
    rawText: JSON.stringify({ text: '調べた結果だよ', emotions: { neutral: 0.5 } }),
    createdAt: '2026-07-14T00:00:02Z',
    toolCalls: [],
  };

  const mantleStub = createMantleStub([loopingResponse, loopingResponse, finalResponse]);

  const { dependencies, executedTools } = buildDependencies({ mantleStub });

  const handleCoreChat = createCoreChatService(dependencies);
  const result = await handleCoreChat(BASE_EVENT);

  // 重複を検知して、ツールは1回しか実行されない
  assert.equal(executedTools.length, 1);

  // 最終応答は強制生成され、その呼出ではtoolsを渡さない
  const lastCall = mantleStub.calls[mantleStub.calls.length - 1];
  assert.equal(lastCall.tools, null, 'forced final call must not offer tools');

  assert.equal(result.ok, true);
  assert.equal(result.text, '調べた結果だよ');
});

test('does not offer tools when tool use is disabled', async () => {
  const mantleStub = createMantleStub([
    {
      responseId: 'resp-1',
      rawText: JSON.stringify({ text: 'やあ', emotions: { happy: 0.4 } }),
      createdAt: '2026-07-14T00:00:00Z',
      toolCalls: [],
    },
  ]);

  const { dependencies, executedTools } = buildDependencies({
    mantleStub,
    toolsEnabled: false,
  });

  const handleCoreChat = createCoreChatService(dependencies);
  const result = await handleCoreChat(BASE_EVENT);

  // toolsを渡さない、systemプロンプトもツールなし版
  assert.equal(mantleStub.calls[0].tools, null);
  assert.equal(mantleStub.calls[0].mantleInput.withTools, false);

  assert.equal(executedTools.length, 0);
  assert.equal(result.ok, true);
});

test('passes tool failures to Mantle instead of throwing', async () => {
  const mantleStub = createMantleStub([
    {
      responseId: 'resp-1',
      rawText: '',
      createdAt: '2026-07-14T00:00:00Z',
      toolCalls: [
        { callId: 'call-1', name: 'get_weather', arguments: '{"city":"Atlantis"}' },
      ],
    },
    {
      responseId: 'resp-2',
      rawText: JSON.stringify({
        text: 'ごめん、その街の天気は見つからなかった',
        emotions: { sad: 0.4, caring: 0.3 },
      }),
      createdAt: '2026-07-14T00:00:01Z',
      toolCalls: [],
    },
  ]);

  const { dependencies } = buildDependencies({
    mantleStub,
    toolResults: {
      // executeToolはthrowせず、エラー内容をオブジェクトで返す仕様
      get_weather: { error: true, message: '都市が見つかりません', tool: 'get_weather' },
    },
  });

  const handleCoreChat = createCoreChatService(dependencies);
  const result = await handleCoreChat(BASE_EVENT);

  // ツール失敗でも会話は続行し、LLMがフォールバック応答を作る
  assert.equal(result.ok, true);
  assert.equal(result.text, 'ごめん、その街の天気は見つからなかった');

  // 失敗内容はMantleへ渡っている
  const toolOutput = mantleStub.calls[1].mantleInput.messages[0].output;
  assert.ok(toolOutput.includes('都市が見つかりません'));
});
