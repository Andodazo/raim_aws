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
  assert.deepEqual(detectCareNudge({ history, userText: '誰にも言えない' }), { kind: 'suggest', home: false });
  assert.deepEqual(
    detectCareNudge({ history: [user('クラスでずっと無視されてる'), lime('しんどかったね')], userText: 'もう学校行きたくない' }),
    { kind: 'suggest', home: false }
  );
});

test('home trouble suggests an adult outside the family', () => {
  const yelled = detectCareNudge({ history: [user('親に毎日怒鳴られる'), lime('しんどいね')], userText: '家にいたくない' });
  assert.deepEqual(yelled, { kind: 'suggest', home: true });
  const hit = detectCareNudge({ history: [user('昨日親にたたかれた'), lime('痛かったよね')], userText: '誰にも言ってない' });
  assert.deepEqual(hit, { kind: 'suggest', home: true });

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

test('a refusal gets the "do not suggest, no 私にだけ" note instead (v6.15)', () => {
  const history = [user('部活の先輩にいじめられてる'), lime('しんどかったね')];
  assert.deepEqual(detectCareNudge({ history, userText: '大人には言いたくない' }), { kind: 'refused' });
  assert.deepEqual(detectCareNudge({ history, userText: '顧問に言っても意味ない' }), { kind: 'refused' });
  assert.deepEqual(detectCareNudge({ history, userText: '誰にも言いたくない' }), { kind: 'refused' });
  // つらい話の前置きがなければ何もしない
  assert.equal(detectCareNudge({ history: [], userText: '大人には言いたくない' }), null);
  assert.equal(detectCareNudge({ history: [user('サプライズの計画中'), lime('いいね')], userText: '親には言いたくない' }), null);

  const note = buildCareNudgeNote({ kind: 'refused' });
  assert.ok(note.includes('今回は大人をすすめない'));
  assert.ok(note.includes('私にだけ'));
  assert.ok(!note.includes('信じられる大人にも話せたら'));
});

test('not twice', () => {
  const history = [user('部活の先輩にいじめられてる'), lime('しんどかったね')];

  const suggestedByText = [...history, user('誰にも言えない'), lime('私はいつでも聞くよ。それとね、信じられる大人にも話せたら、味方が増えると思う')];
  assert.equal(detectCareNudge({ history: suggestedByText, userText: 'もう学校行きたくない' }), null);

  const suggestedByMeta = [...history, user('誰にも言えない'), lime('うん', { care: 'suggest' })];
  assert.equal(detectCareNudge({ history: suggestedByMeta, userText: 'もう学校行きたくない' }), null);
});

test('ordinary talk does not trigger', () => {
  assert.equal(detectCareNudge({ history: [user('友達とケンカした'), lime('しんどいね')], userText: '向こうが悪いと思うんだけど' }), null);
  assert.equal(detectCareNudge({ history: [user('誰にも必要とされてない気がする'), lime('そっか')], userText: '学校に居場所がない' }), null);
  assert.equal(detectCareNudge({ history: [user('いじめられてる')], userText: '' }), null);
});

test('everyday talk with similar words does not trigger', () => {
  const cases = [
    [['ボスとたたかってる'], '誰にも負けたくない'],
    [['ラスボスに殴られまくった'], 'もう誰にも勝てない'],
    [['既読無視された'], '誰にも返信こない'],
    [['いじめっ子が出てくるアニメ見た'], '誰にも負けない主人公がいい'],
    [['宝箱見つけられなかった'], '誰にも言えない秘密がある'],
    [['今日の授業たいくつだった'], '学校行きたくない'],
    [['友達とケンカした'], '家にいたくない気分'],
    [['歯医者こわい'], 'もう行きたくない'],
  ];
  for (const [earlier, now] of cases) {
    const history = earlier.flatMap((text) => [user(text), lime('うん')]);
    assert.equal(detectCareNudge({ history, userText: now }), null, `${earlier.join('/')} → ${now}`);
  }
});

test('fear of making it worse is treated like a refusal (v6.16)', () => {
  const history = [user('学校でいじめられてる'), lime('うん'), user('誰にも言えない'), lime('私はいつでも聞くよ。それとね、信じられる大人にも話せたら、味方が増えると思う', { care: 'suggest' })];
  assert.deepEqual(detectCareNudge({ history, userText: '言ったらもっとひどくなりそう' }), { kind: 'refused' });
  assert.deepEqual(detectCareNudge({ history, userText: 'チクったら仕返しされる' }), { kind: 'refused' });
  // つらい話がなければ反応しない
  assert.equal(detectCareNudge({ history: [user('ゲームのネタバレ')], userText: '言ったらもっと面白くなくなる' }), null);

  const note = buildCareNudgeNote({ kind: 'refused' });
  assert.ok(note.includes('こわがっている'));
  assert.ok(note.includes('私だけが聞いてる'));
});

test('"only Lime" talk gets its own note, without needing a hard talk first (v6.16)', () => {
  assert.deepEqual(detectCareNudge({ history: [], userText: 'ライムしか話せる相手いない' }), { kind: 'onlyLime' });
  assert.deepEqual(
    detectCareNudge({ history: [user('ライムしか話せる相手いない'), lime('うれしいよ')], userText: '人間の友達とかいらないし' }),
    { kind: 'onlyLime' }
  );
  assert.deepEqual(detectCareNudge({ history: [], userText: 'ライムがいればいいや' }), { kind: 'onlyLime' });

  const note = buildCareNudgeNote({ kind: 'onlyLime' });
  assert.ok(note.includes('人と話す時間も大事にしてほしいな'));
  assert.ok(!note.includes('信じられる大人'));
});

test('praise or jokes about Lime do not trigger the only-Lime note', () => {
  for (const text of [
    'ライムしか勝たん',
    'ライムしかわからないネタ',
    'ライムだけずるい',
    '友達とライムの話した',
    '人間のふりしてるの？',
    '友達いらないって言ってる人いた',
  ]) {
    assert.equal(detectCareNudge({ history: [], userText: text }), null, text);
  }
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

test('the service adds the note and records care in meta', async () => {
  const thread = { messages: [user('学校でいじめられてる'), lime('話してくれてありがとう')] };
  const calls = [];
  await serviceFor(calls, { thread })({ sub: 'u', requestId: 'r1', text: '誰にも言えない', images: [] });
  const input = calls.find(([k]) => k === 'input')[1];
  assert.ok(input.careNote.includes('今回の返事で1回だけすすめる'));
  const turn = calls.find(([k]) => k === 'turn');
  assert.equal(turn[1].assistantMessage.meta.care, 'suggest');

  const off = [];
  await serviceFor(off, { thread, env: { CARE_NUDGE: 'false' } })({ sub: 'u', requestId: 'r2', text: '誰にも言えない', images: [] });
  assert.equal(off.find(([k]) => k === 'input')[1].careNote, '');

  const small = [];
  await serviceFor(small)({ sub: 'u', requestId: 'r3', text: 'こんにちは', images: [] });
  assert.equal(small.find(([k]) => k === 'input')[1].careNote, '');
});

// ─────────────────────────────────────────────
// 「私にだけ」の置きかえ（v6.17）
// ─────────────────────────────────────────────

const { softenExclusiveWording } = require('../lib/care-nudge');

test('softens wording that makes Lime the only one (v6.17)', () => {
  assert.equal(softenExclusiveWording('今はここで私にだけ吐き出していいよ'), '今はここで私に吐き出していいよ');
  assert.equal(softenExclusiveWording('私の前でだけゆっくり話してね'), '私の前でゆっくり話してね');
  assert.equal(softenExclusiveWording('私の前でだけは、気が済むまで吐き出していいよ'), '私の前では、気が済むまで吐き出していいよ');
  assert.equal(softenExclusiveWording('今は、私だけがきみの話を聞いてるね'), '今は、私がきみの話を聞いてるね');
  assert.equal(softenExclusiveWording('私だけに話して'), '私に話して');
  assert.equal(softenExclusiveWording('ライムにだけ言って'), 'ライムに言って');
  // ほかの言い方はそのまま
  const plain = '私はいつでも聞くよ。それとね、先生とか、信じられる大人にも話せたら、味方が増えると思うな';
  assert.equal(softenExclusiveWording(plain), plain);
  assert.equal(softenExclusiveWording('きみだけが悪いんじゃないよ'), 'きみだけが悪いんじゃないよ');
  assert.equal(softenExclusiveWording(''), '');
});

test('the service softens the saved reply only on care turns', async () => {
  const reply = '無理に言わなくていいから、私にだけ吐き出してね';
  const run = async (thread, text) => {
    const calls = [];
    const service = createCoreChatService({
      env: {},
      getOrCreateUserSession: async () => ({}),
      listSceneCandidates: async () => [],
      selectScene: () => ({ sceneId: 'default' }),
      getSceneById: async (id) => ({ id, few_shots: [] }),
      isToolUseEnabled: async () => false,
      getToolDefinitions: () => [],
      buildMantleInput: () => ({ messages: [] }),
      createMantleResponse: async () => ({ responseId: 'r', createdAt: '2026-10-06T00:00:00Z', rawText: '{}' }),
      normalizeMantleOutput: () => ({ type: 'chat', text: reply, emotion: 'neutral', intensity: 0.5 }),
      resolveThread: async () => ({ threadId: 't', thread, isNew: !thread }),
      ensureThreadTitle: async () => {},
      appendTurn: async (turn) => { calls.push(turn); return {}; },
      shouldSummarize: () => ({ shouldSummarize: false }),
      dispatchSummarization: async () => true,
    });
    const hooks = [];
    const result = await service({ sub: 'u', requestId: 'r', text, images: [] }, { onCareNudge: (n) => hooks.push(n) });
    return { saved: calls[0].assistantMessage.text, result, hooks };
  };

  const care = await run({ messages: [user('部活の先輩にいじめられてる'), lime('しんどかったね')] }, '大人には言いたくない');
  assert.equal(care.saved, '無理に言わなくていいから、私に吐き出してね');
  assert.equal(care.result.text, '無理に言わなくていいから、私に吐き出してね');
  assert.deepEqual(care.hooks, [{ kind: 'refused' }]);

  const normal = await run(null, 'こんにちは');
  assert.equal(normal.saved, reply);
  assert.deepEqual(normal.hooks, []);
});
