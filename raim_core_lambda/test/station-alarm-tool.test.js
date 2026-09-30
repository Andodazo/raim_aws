'use strict';

// 駅アラーム（アプリに頼むツール）のテスト。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createCoreChatService } = require('../lib/core-chat-service');
const {
  getToolDefinitions,
  getClientAction,
  executeTool,
  pickToolIntro,
  isKnownTool,
} = require('../lib/tools');
const { buildSystemPrompt } = require('../lib/prompts/raim-system-prompt');
const {
  buildFollowupMantleInput,
  buildInitialMantleInput,
} = require('../lib/prompt-builder');

// ─────────────────────────────────────────────
// ツール定義の出し分け
// ─────────────────────────────────────────────

test('station alarm tools are offered only when the app supports them', () => {
  const plain = getToolDefinitions().map((t) => t.name);
  assert.deepEqual(plain, ['web_search', 'get_weather']);

  const withAlarm = getToolDefinitions({ features: ['station_alarm'] }).map((t) => t.name);
  assert.deepEqual(withAlarm, [
    'web_search',
    'get_weather',
    'start_station_alarm',
    'stop_station_alarm',
  ]);

  for (const tool of getToolDefinitions({ features: ['station_alarm'] })) {
    assert.equal(tool.type, 'function');
    assert.equal(tool.function, undefined, 'Responses API はフラット形式');
    assert.ok(tool.parameters);
  }
});

test('station alarm tools are known tools without an intro line', () => {
  assert.equal(isKnownTool('start_station_alarm'), true);
  assert.equal(isKnownTool('stop_station_alarm'), true);
  // 待ち時間が無いので「ちょっと待って」は言わない
  assert.equal(pickToolIntro('start_station_alarm', 1, () => 0), '');
});

// ─────────────────────────────────────────────
// アプリへ送る操作
// ─────────────────────────────────────────────

test('getClientAction turns start_station_alarm into station_alarm.start', () => {
  assert.deepEqual(
    getClientAction('start_station_alarm', { station: '新宿駅', line: ' 中央線 ' }),
    { action: 'station_alarm.start', params: { station: '新宿', line: '中央線' } }
  );
  assert.deepEqual(
    getClientAction('start_station_alarm', { station: 'お茶の水', kana: 'オチャノミズ' }),
    { action: 'station_alarm.start', params: { station: 'お茶の水', kana: 'おちゃのみず' } }
  );
  // よみがなに漢字などが混ざっていたら捨てる（駅名だけで探す）
  assert.deepEqual(
    getClientAction('start_station_alarm', { station: '新宿', kana: '新じゅく' }),
    { action: 'station_alarm.start', params: { station: '新宿' } }
  );
  assert.deepEqual(
    getClientAction('start_station_alarm', { station: '神田' }),
    { action: 'station_alarm.start', params: { station: '神田' } }
  );
  assert.deepEqual(
    getClientAction('stop_station_alarm', {}),
    { action: 'station_alarm.stop', params: {} }
  );
});

test('getClientAction returns null without a station or for normal tools', () => {
  assert.equal(getClientAction('start_station_alarm', {}), null);
  assert.equal(getClientAction('start_station_alarm', { station: '  駅 ' }), null);
  assert.equal(getClientAction('start_station_alarm', { station: 'あ'.repeat(41) }), null);
  assert.equal(getClientAction('get_weather', { city: 'Tokyo' }), null);
});

test('start_station_alarm result tells Lime what was requested', async () => {
  const ok = await executeTool('start_station_alarm', { station: '新宿' });
  assert.equal(ok.ok, true);
  assert.equal(ok.station, '新宿');

  const missing = await executeTool('start_station_alarm', {});
  assert.equal(missing.error, true);
  assert.match(missing.message, /聞いて/);
});

// ─────────────────────────────────────────────
// プロンプト
// ─────────────────────────────────────────────

test('system prompt explains the station alarm only for supporting apps', () => {
  const withAlarm = buildSystemPrompt({ withTools: true, features: ['station_alarm'] });
  const without = buildSystemPrompt({ withTools: true });
  const noTools = buildSystemPrompt({ withTools: false, features: ['station_alarm'] });

  assert.ok(withAlarm.includes('start_station_alarm'));
  assert.ok(!without.includes('start_station_alarm'));
  // ツールが使えないときは説明しない（呼べないツールを案内しない）
  assert.ok(!noTools.includes('start_station_alarm'));
});

test('initial and followup inputs carry the station alarm rules', () => {
  const initial = buildInitialMantleInput({
    userText: '新宿で起こして',
    withTools: true,
    features: ['station_alarm'],
  });
  assert.ok(initial.messages[0].content.includes('start_station_alarm'));

  const followup = buildFollowupMantleInput({
    userText: '新宿で起こして',
    withTools: true,
    features: ['station_alarm'],
  });
  const systemText = followup.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
  assert.ok(systemText.includes('start_station_alarm'));

  const followupWithout = buildFollowupMantleInput({
    userText: '新宿で起こして',
    withTools: true,
  });
  const plainText = followupWithout.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
  assert.ok(!plainText.includes('start_station_alarm'));
});

// ─────────────────────────────────────────────
// ツールループ
// ─────────────────────────────────────────────

function createMantleStub(responses) {
  const calls = [];
  let index = 0;
  return {
    calls,
    createMantleResponse: async (args) => {
      calls.push(args);
      const response = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return response;
    },
  };
}

function buildDependencies(mantleStub, overrides = {}) {
  const actions = [];
  const executed = [];
  const notifications = [];

  return {
    actions,
    executed,
    notifications,
    dependencies: {
      getOrCreateUserSession: async () => ({ sessionSummary: '' }),
      getMantleSessionState: () => ({ usePreviousResponseId: false, previousResponseId: '' }),
      isMantleResponseExpiredError: () => false,
      clearMantleResponseState: async () => {},
      updateMantleResponseState: async () => {},
      resolveThread: async () => ({ threadId: 'thread-test', thread: null, isNew: false }),
      ensureThreadTitle: async () => {},
      appendTurn: async () => ({}),
      shouldSummarize: () => ({ shouldSummarize: false, reason: null }),
      dispatchSummarization: async () => true,
      listSceneCandidates: async () => [],
      selectScene: async () => ({ sceneId: 'default' }),
      getSceneById: async () => ({ id: 'default', few_shots: [] }),
      buildMantleInput: ({ withTools, features }) => ({
        mode: 'initial',
        withTools,
        features,
        messages: [{ role: 'user', content: '新宿で起こして' }],
      }),
      createMantleResponse: mantleStub.createMantleResponse,
      maxToolTurns: 2,
      isToolUseEnabled: async () => true,
      executeTool: async (name, args) => {
        executed.push({ name, args });
        return executeTool(name, args);
      },
      onToolCallStart: async (info) => notifications.push(info),
      onClientAction: async (action) => actions.push(action),
      ...overrides,
    },
  };
}

function eventWith(features) {
  return {
    schemaVersion: 1,
    type: 'chat.request',
    requestId: 'req-1',
    connectionId: 'conn-1',
    sub: 'user-1',
    source: 'websocket',
    text: '新宿で起こして',
    images: [],
    ...(features ? { features } : {}),
  };
}

const START_CALL = {
  responseId: 'resp-1',
  rawText: '',
  createdAt: '2026-09-30T00:00:00Z',
  toolCalls: [
    { callId: 'call-1', name: 'start_station_alarm', arguments: '{"station":"新宿"}' },
  ],
};

const REPLY = {
  responseId: 'resp-2',
  rawText: JSON.stringify({
    text: '新宿ね、了解。近づいたら起こすから',
    emotions: { caring: 0.6, neutral: 0.4 },
  }),
  createdAt: '2026-09-30T00:00:01Z',
  toolCalls: [],
};

test('start_station_alarm sends the action to the app and Lime replies', async () => {
  const stub = createMantleStub([START_CALL, REPLY]);
  const { dependencies, actions, executed, notifications } = buildDependencies(stub);

  const result = await createCoreChatService(dependencies)(eventWith(['station_alarm']));

  // ライムに駅アラームのツールを見せている
  const offered = stub.calls[0].tools.map((t) => t.name);
  assert.ok(offered.includes('start_station_alarm'));
  assert.deepEqual(stub.calls[0].mantleInput.features, ['station_alarm']);

  // アプリへ操作が送られた
  assert.deepEqual(actions, [
    { action: 'station_alarm.start', params: { station: '新宿' } },
  ]);
  assert.equal(executed[0].name, 'start_station_alarm');

  // 前置きセリフは無し（待ち時間が無いため）
  assert.equal(notifications[0].introText, '');

  // 結果を踏まえたライムの返事
  const output = JSON.parse(stub.calls[1].mantleInput.messages[0].output);
  assert.equal(output.ok, true);
  assert.equal(result.ok, true);
  assert.equal(result.text, '新宿ね、了解。近づいたら起こすから');
});

test('does not run station alarm tools for apps without the feature', async () => {
  const stub = createMantleStub([START_CALL, REPLY]);
  const { dependencies, actions, executed } = buildDependencies(stub);

  await createCoreChatService(dependencies)(eventWith());

  // 見せていない
  const offered = stub.calls[0].tools.map((t) => t.name);
  assert.ok(!offered.includes('start_station_alarm'));

  // 名前だけで呼ばれても実行しない・アプリにも送らない
  assert.equal(executed.length, 0);
  assert.equal(actions.length, 0);
});

test('does not send an action when the station is missing', async () => {
  const stub = createMantleStub([
    {
      ...START_CALL,
      toolCalls: [{ callId: 'call-1', name: 'start_station_alarm', arguments: '{}' }],
    },
    REPLY,
  ]);
  const { dependencies, actions, executed } = buildDependencies(stub);

  await createCoreChatService(dependencies)(eventWith(['station_alarm']));

  assert.equal(executed.length, 1);
  assert.equal(actions.length, 0);
  const output = JSON.parse(stub.calls[1].mantleInput.messages[0].output);
  assert.equal(output.error, true);
});
