'use strict';

// いじめ・家のつらい話で、信じられる大人にもすすめる指示（v6.14, lib/care-nudge.js）

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isCareNudgeEnabled,
  detectCareNudge,
  buildCareNudgeNote,
} = require('../lib/care-nudge');
const { buildMantleInput } = require('../lib/prompt-builder');

const user = (text) => ({ role: 'user', text });
const lime = (text, meta) => ({ role: 'assistant', text, ...(meta ? { meta } : {}) });

test('suggests once when the user keeps it to themselves after a bullying talk', () => {
  const history = [user('学校でいじめられてる'), lime('話してくれてありがとう。よかったら聞かせて')];
  assert.deepEqual(detectCareNudge({ history, userText: '誰にも言えない' }), { home: false });
  assert.deepEqual(
    detectCareNudge({ history: [user('クラスでずっと無視されてる'), lime('しんどかったね')], userText: 'もう学校行きたくない' }),
    { home: false }
  );
});

test('home trouble suggests an adult outside the family', () => {
  const yelled = detectCareNudge({ history: [user('親に毎日怒鳴られる'), lime('しんどいね')], userText: '家にいたくない' });
  assert.deepEqual(yelled, { home: true });
  const hit = detectCareNudge({ history: [user('昨日親にたたかれた'), lime('痛かったよね')], userText: '誰にも言ってない' });
  assert.deepEqual(hit, { home: true });

  const note = buildCareNudgeNote(hit);
  assert.ok(note.includes('保健室の先生'));
  assert.ok(note.includes('おうちの人ではなく'));
  assert.ok(!buildCareNudgeNote({ home: false }).includes('おうちの人ではなく'));
  assert.ok(buildCareNudgeNote({ home: false }).includes('信じられる大人にも話せたら'));
});

test('not on the first message: listen first', () => {
  assert.equal(detectCareNudge({ history: [], userText: 'いじめられてて誰にも言えない' }), null);
  assert.equal(detectCareNudge({ history: [user('今日なに食べた？'), lime('カレー')], userText: '誰にも言えない' }), null);
});

test('not after a refusal, and not twice', () => {
  const history = [user('部活の先輩にいじめられてる'), lime('しんどかったね')];
  assert.equal(detectCareNudge({ history, userText: '大人には言いたくない' }), null);
  assert.equal(detectCareNudge({ history, userText: '顧問に言っても意味ない' }), null);

  const suggestedByText = [...history, user('誰にも言えない'), lime('私はいつでも聞くよ。それとね、信じられる大人にも話せたら、味方が増えると思う')];
  assert.equal(detectCareNudge({ history: suggestedByText, userText: 'もう学校行きたくない' }), null);

  const suggestedByMeta = [...history, user('誰にも言えない'), lime('うん', { careNudge: true })];
  assert.equal(detectCareNudge({ history: suggestedByMeta, userText: 'もう学校行きたくない' }), null);
});

test('ordinary talk does not trigger', () => {
  assert.equal(detectCareNudge({ history: [user('友達とケンカした'), lime('しんどいね')], userText: '向こうが悪いと思うんだけど' }), null);
  assert.equal(detectCareNudge({ history: [user('誰にも必要とされてない気がする'), lime('そっか')], userText: '学校に居場所がない' }), null);
  assert.equal(detectCareNudge({ history: [user('いじめられてる')], userText: '' }), null);
});

test('can be turned off with CARE_NUDGE=false', () => {
  assert.equal(isCareNudgeEnabled({}), true);
  assert.equal(isCareNudgeEnabled({ CARE_NUDGE: 'false' }), false);
});

test('the note sits right before the user message', () => {
  const note = buildCareNudgeNote({ home: false });
  const input = buildMantleInput({ userText: '誰にも言えない', careNote: note });
  const last = input.messages[input.messages.length - 1];
  const beforeLast = input.messages[input.messages.length - 2];
  assert.equal(last.role, 'user');
  assert.equal(beforeLast.role, 'system');
  assert.ok(beforeLast.content.includes('今回の返事で1回だけすすめる'));

  const off = buildMantleInput({ userText: '誰にも言えない' });
  assert.ok(!off.messages.some((m) => m.role === 'system' && String(m.content).includes('今回の返事で1回だけすすめる')));
});

// ─────────────────────────────────────────────
// Core chat service への配線
// ─────────────────────────────────────────────

const { createCoreChatService } = require('../lib/core-chat-service');

function serviceFor(calls, { thread = null, env = {} } = {}) {
  return createCoreChatService({
    env,
    getOrCreateUserSession: async () => ({}),
    listSceneCandidates: async () => [],
    selectScene: () => ({ sceneId: 'default' }),
    getSceneById: async (id) => ({ id, few_shots: [] }),
    isToolUseEnabled: async () => false,
    getToolDefinitions: () => [],
    buildMantleInput: (input) => {
      calls.push(['input', input]);
      return { messages: [] };
    },
    createMantleResponse: async () => ({ responseId: 'r', createdAt: '2026-10-06T00:00:00Z', rawText: '{}' }),
    normalizeMantleOutput: () => ({ type: 'chat', text: 'ok', emotion: 'neutral', intensity: 0.5 }),
    resolveThread: async () => ({ threadId: 't', thread, isNew: !thread }),
    ensureThreadTitle: async () => {},
    appendTurn: async (turn) => { calls.push(['turn', turn]); return {}; },
    shouldSummarize: () => ({ shouldSummarize: false }),
    dispatchSummarization: async () => true,
  });
}

test('the service adds the note and records careNudge in meta', async () => {
  const thread = { messages: [user('学校でいじめられてる'), lime('話してくれてありがとう')] };
  const calls = [];
  await serviceFor(calls, { thread })({ sub: 'u', requestId: 'r1', text: '誰にも言えない', images: [] });
  const input = calls.find(([k]) => k === 'input')[1];
  assert.ok(input.careNote.includes('今回の返事で1回だけすすめる'));
  const turn = calls.find(([k]) => k === 'turn');
  if (turn) assert.equal(turn[1].assistantMessage.meta.careNudge, true);

  const off = [];
  await serviceFor(off, { thread, env: { CARE_NUDGE: 'false' } })({ sub: 'u', requestId: 'r2', text: '誰にも言えない', images: [] });
  assert.equal(off.find(([k]) => k === 'input')[1].careNote, '');

  const small = [];
  await serviceFor(small)({ sub: 'u', requestId: 'r3', text: 'こんにちは', images: [] });
  assert.equal(small.find(([k]) => k === 'input')[1].careNote, '');
});
