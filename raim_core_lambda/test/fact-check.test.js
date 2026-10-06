'use strict';

// 事実の質問への対策（lib/fact-check.js）

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isFactQuestion,
  isFactCheckEnabled,
  FACT_CHECK_INSTRUCTION,
  resolveSceneReasoningEffort,
} = require('../lib/fact-check');
const { buildMantleInput } = require('../lib/prompt-builder');
const { buildMantleRequest } = require('../lib/mantle-client');

test('fact questions from the 2026-10 samples trigger a search', () => {
  for (const text of [
    'ジェラドンって知ってる?',
    'くいやは知ってる？',
    'ジョジョ7部は知ってる？',
    '堀大輔知ってる？',
    'lolについて知ってる？',
    '米津玄師ってどんな人？',
    'この曲って誰が歌ってるの？',
    'ヒカキンって誰？',
  ]) {
    assert.ok(isFactQuestion(text), text);
  }
});

test('questions about the user, Lime, or the weather do not', () => {
  for (const text of [
    '私の名前知ってる？',
    '自分のこと知ってる？',
    'ライムって何でできてるの？',
    'あなたのこと教えて',
    '明日の天気知ってる？',
    'こんにちは',
    'マグロって何',
  ]) {
    assert.ok(!isFactQuestion(text), text);
  }
});

test('fact check is on by default and can be turned off', () => {
  assert.equal(isFactCheckEnabled({}), true);
  assert.equal(isFactCheckEnabled({ FACT_CHECK_SEARCH: 'false' }), false);
});

test('the instruction reaches initial, digest and full inputs', () => {
  const systemText = (input) => input.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');

  const initial = buildMantleInput({ userText: 'x', factCheck: true });
  const digest = buildMantleInput({ userText: 'x', usePreviousResponseId: true, factCheck: true });
  const off = buildMantleInput({ userText: 'x' });

  assert.ok(systemText(initial).includes('今回は調べてから答える'));
  assert.ok(systemText(digest).includes('今回は調べてから答える'));
  assert.ok(!systemText(off).includes('今回は調べてから答える'));
  assert.ok(FACT_CHECK_INSTRUCTION.includes('web_search'));
});

test('scene reasoning effort is opt-in', () => {
  assert.equal(resolveSceneReasoningEffort('question', {}), '');
  const env = { SCENE_REASONING_EFFORTS: 'question=low, advice=medium' };
  assert.equal(resolveSceneReasoningEffort('question', env), 'low');
  assert.equal(resolveSceneReasoningEffort('advice', env), 'medium');
  assert.equal(resolveSceneReasoningEffort('default', env), '');
});

test('a per-request effort overrides MANTLE_REASONING_EFFORT', () => {
  const env = { MANTLE_MODEL: 'm' };
  const mantleInput = { messages: [{ role: 'user', content: 'x' }] };

  assert.deepEqual(buildMantleRequest({ mantleInput }, env).reasoning, { effort: 'none' });
  assert.deepEqual(
    buildMantleRequest({ mantleInput, reasoningEffort: 'low' }, env).reasoning,
    { effort: 'low' }
  );
});

// ─────────────────────────────────────────────
// Core chat service への配線
// ─────────────────────────────────────────────

const { createCoreChatService } = require('../lib/core-chat-service');

function serviceFor(calls, { toolsEnabled = true, sceneId = 'question', env = {} } = {}) {
  return createCoreChatService({
    env,
    clearMantleResponseState: async () => {},
    getOrCreateUserSession: async () => ({}),
    getMantleSessionState: () => ({ usePreviousResponseId: false, previousResponseId: '' }),
    isMantleResponseExpiredError: () => false,
    listSceneCandidates: async () => [],
    selectScene: () => ({ sceneId }),
    getSceneById: async (id) => ({ id, few_shots: [] }),
    isToolUseEnabled: async () => toolsEnabled,
    getToolDefinitions: () => [],
    buildMantleInput: (input) => {
      calls.push(['input', input]);
      return { messages: [] };
    },
    createMantleResponse: async (input) => {
      calls.push(['model', input]);
      return { responseId: 'r', createdAt: '2026-10-06T00:00:00Z', rawText: '{}' };
    },
    normalizeMantleOutput: () => ({ type: 'chat', text: 'ok', emotion: 'neutral', intensity: 0.5 }),
    resolveThread: async () => ({ threadId: 't', thread: null, isNew: false }),
    ensureThreadTitle: async () => {},
    appendTurn: async () => ({}),
    shouldSummarize: () => ({ shouldSummarize: false }),
    dispatchSummarization: async () => true,
    updateMantleResponseState: async () => {},
  });
}

test('a fact question asks the prompt to search first when tools are on', async () => {
  const calls = [];
  await serviceFor(calls)({ sub: 'u', requestId: 'r1', text: 'ジェラドンって知ってる？', images: [] });
  assert.equal(calls.find(([k]) => k === 'input')[1].factCheck, true);
});

test('no search instruction without tools or for small talk', async () => {
  const noTools = [];
  await serviceFor(noTools, { toolsEnabled: false })({ sub: 'u', requestId: 'r2', text: 'ジェラドンって知ってる？', images: [] });
  assert.equal(noTools.find(([k]) => k === 'input')[1].factCheck, false);

  const smallTalk = [];
  await serviceFor(smallTalk)({ sub: 'u', requestId: 'r3', text: 'こんにちは', images: [] });
  assert.equal(smallTalk.find(([k]) => k === 'input')[1].factCheck, false);
});

test('scene reasoning effort is passed to Mantle', async () => {
  const calls = [];
  await serviceFor(calls, { env: { SCENE_REASONING_EFFORTS: 'question=low' } })({
    sub: 'u', requestId: 'r4', text: 'ポモドーロって何？', images: [],
  });
  assert.equal(calls.find(([k]) => k === 'model')[1].reasoningEffort, 'low');

  const plain = [];
  await serviceFor(plain, { sceneId: 'default' })({ sub: 'u', requestId: 'r5', text: 'こんにちは', images: [] });
  assert.equal(plain.find(([k]) => k === 'model')[1].reasoningEffort, '');
});
