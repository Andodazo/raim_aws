'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const pastTalk = require('../lib/tools/past-talk');
const { getToolDefinitions, isKnownTool } = require('../lib/tools');
const { createCoreChatService } = require('../lib/core-chat-service');

// 2026-11-11(水) 11:30 JST
const NOW = new Date('2026-11-11T02:30:00Z');
const jst = (date, time = '12:00') => new Date(`${date}T${time}:00+09:00`).toISOString();

test('past talk: the tool is offered only when the user asks about an earlier talk', () => {
  for (const text of ['この前話したお店なんだっけ', '先週言ってたやつ覚えてる？', '前に教えた曲、なんだっけ', 'こないだ話したじゃん']) {
    assert.equal(pastTalk.mentionsPastTalk(text), true, text);
  }
  for (const text of ['ヒトカゲの進化系なんだっけ', '前に進むしかない', '今日なに食べよう', '', 'ゲームの話しよう']) {
    assert.equal(pastTalk.mentionsPastTalk(text), false, text);
  }
  assert.equal(getToolDefinitions({}).some((t) => t.name === 'search_past_talk'), false);
  assert.equal(getToolDefinitions({ pastTalk: true }).some((t) => t.name === 'search_past_talk'), true);
  assert.equal(isKnownTool('search_past_talk'), true);
});

test('past talk: words added on 2026-11-15 open the tool, everyday talk still does not', () => {
  for (const text of [
    'カフェの話したっけ？',
    '前話したやつ何？',
    'あのとき喋ったゲーム、思い出せない',
    '先日伝えた予定、忘れちゃった',
    '今朝言ったっけ',
    '去年話した旅行のこと覚えてる？',
    '昨夜のあれなんだっけ',
  ]) {
    assert.equal(pastTalk.mentionsPastTalk(text), true, text);
  }
  for (const text of [
    '最近寒いね',
    '駅前のカフェ行きたい',
    '前から思ってたんだけど',
    '今朝は寒かった',
    '去年の今ごろは暑かったね',
    '東京の人口って何人だっけ',
    'あの時はありがとう',
    '宿題忘れた',
    'いつも話してて楽しいよ',
  ]) {
    assert.equal(pastTalk.mentionsPastTalk(text), false, text);
  }
});

test('past talk: the period comes from the words (code), then from the LLM', () => {
  // NOW は 11/11(水)
  assert.deepEqual(pastTalk.resolvePeriod({ userText: '先週話したやつ', now: NOW }), { from: '2026-11-02', to: '2026-11-08', label: '先週' });
  assert.deepEqual(pastTalk.resolvePeriod({ userText: '昨日言ってた', now: NOW }), { from: '2026-11-10', to: '2026-11-10', label: '昨日' });
  assert.deepEqual(pastTalk.resolvePeriod({ userText: '先月の話', now: NOW }), { from: '2026-10-01', to: '2026-10-31', label: '先月' });
  assert.deepEqual(pastTalk.resolvePeriod({ userText: '3日前に話した', now: NOW }), { from: '2026-11-07', to: '2026-11-09', label: '3日前' });
  assert.deepEqual(pastTalk.resolvePeriod({ userText: 'この前話した', period: 'this_week', now: NOW }), { from: '2026-11-09', to: '2026-11-11', label: '今週' });
  assert.equal(pastTalk.resolvePeriod({ userText: 'この前話した', period: 'any', now: NOW }), null);
  assert.equal(pastTalk.resolvePeriod({ userText: 'この前話した', period: 'いつか', now: NOW }), null);
});

test('past talk: forgotten memories are left out', () => {
  assert.equal(pastTalk.matchesForgotten('好きな食べ物はラーメンなんだ', ['好きな食べ物はラーメン']), true);
  assert.equal(pastTalk.matchesForgotten('駅前のカフェ、よかったよ', ['好きな食べ物はラーメン']), false);
  assert.equal(pastTalk.matchesForgotten('明日は晴れるらしい', ['駅前のカフェ「モカ」がお気に入り']), false);
});

function threadStore(threads) {
  const reads = [];
  return {
    reads,
    listThreads: async () => threads.filter((t) => !t.deletedAt).map(({ messages, ...rest }) => rest),
    getThread: async (sub, threadId) => {
      reads.push(threadId);
      return threads.find((t) => t.threadId === threadId) || null;
    },
  };
}

const cafeThread = {
  threadId: 'thread-cafe',
  title: '週末の話',
  sessionSummary: '週末に出かけた話をした',
  createdAt: jst('2026-11-03', '10:00'),
  updatedAt: jst('2026-11-03', '11:00'),
  messages: [
    { role: 'user', text: '週末どこ行ったと思う？', createdAt: jst('2026-11-03', '10:00') },
    { role: 'assistant', text: 'どこどこ？', createdAt: jst('2026-11-03', '10:00') },
    { role: 'user', text: '駅前のモカってカフェ、すごくよかった', createdAt: jst('2026-11-03', '10:05') },
    { role: 'assistant', text: 'いいね、今度また行きたいね', createdAt: jst('2026-11-03', '10:05') },
  ],
};

test('past talk: finds the message, says when, and returns the card', async () => {
  const store = threadStore([
    cafeThread,
    { threadId: 'thread-gone', deletedAt: jst('2026-11-05'), title: 'カフェ', messages: [] },
    { threadId: 'thread-other', title: 'ゲーム', sessionSummary: 'ゲームの話', createdAt: jst('2026-11-09'), updatedAt: jst('2026-11-09'), messages: [{ role: 'user', text: 'ゲームしてた', createdAt: jst('2026-11-09') }] },
  ]);
  const { result, best, stats } = await pastTalk.searchPastTalk({
    sub: 'u1', keywords: ['カフェ', 'かふぇ', '喫茶店'], userText: 'この前話したカフェなんだっけ', now: NOW, store,
  });
  assert.equal(result.found, true);
  assert.equal(result.results[0].when, '11/3(火)（8日前）');
  assert.ok(result.results[0].conversation.some((line) => line.text.includes('モカ')));
  assert.deepEqual(best, { threadId: 'thread-cafe', at: jst('2026-11-03', '10:05'), title: '週末の話', date: '2026-11-03' });
  assert.equal(store.reads.includes('thread-gone'), false);
  assert.equal(stats.threads, 2);
});

test('past talk: a period outside the talk, or nothing matching, is reported honestly', async () => {
  const store = threadStore([cafeThread]);
  const yesterday = await pastTalk.searchPastTalk({
    sub: 'u1', keywords: ['カフェ'], userText: '昨日話したカフェ', now: NOW, store,
  });
  assert.equal(yesterday.result.found, false);
  assert.equal(yesterday.best, null);
  assert.match(yesterday.result.note, /見つからなかった/);

  const none = await pastTalk.searchPastTalk({ sub: 'u1', keywords: ['水族館'], now: NOW, store });
  assert.equal(none.result.found, false);

  const empty = await pastTalk.searchPastTalk({ sub: 'u1', keywords: [], now: NOW, store });
  assert.equal(empty.result.ok, false);
});

test('past talk: forgotten items are not returned', async () => {
  const store = threadStore([cafeThread]);
  const { result } = await pastTalk.searchPastTalk({
    sub: 'u1', keywords: ['カフェ'], forgotten: ['駅前のモカってカフェがお気に入り'], now: NOW, store,
  });
  assert.equal(result.found, false);
});

test('flow: the search tool runs, sends the card, and the reply is built from the result', async () => {
  const store = threadStore([cafeThread]);
  const actions = [];
  const mainCalls = [];
  const responses = [
    { responseId: 'r-1', rawText: '', toolCalls: [{ name: 'search_past_talk', callId: 'c1', arguments: JSON.stringify({ keywords: ['カフェ'], period: 'any' }) }] },
    { responseId: 'r-2', rawText: JSON.stringify({ emotions: { happy: 0.6 }, text: '11/3に話してたね、駅前のモカってカフェ' }), toolCalls: [] },
  ];
  const appended = [];
  const service = createCoreChatService({
    getOrCreateUserSession: async () => ({ sessionSummary: '', forgottenMemories: [] }),
    resolveThread: async () => ({ threadId: 't-now', thread: null, isNew: false }),
    ensureThreadTitle: async () => {},
    appendTurn: async (turn) => { appended.push(turn); return {}; },
    shouldSummarize: () => ({ shouldSummarize: false }),
    dispatchSummarization: async () => true,
    listSceneCandidates: async () => [],
    selectScene: async () => ({ sceneId: 'default' }),
    getSceneById: async () => ({ id: 'default', few_shots: [] }),
    createMantleResponse: async (args) => { mainCalls.push(args); return responses[mainCalls.length - 1]; },
    isToolUseEnabled: async () => true,
    listThreads: store.listThreads,
    getThread: store.getThread,
    now: () => NOW,
  });
  const result = await service({
    schemaVersion: 1, type: 'chat.request', requestId: 'r1', sub: 'u1', source: 'websocket',
    text: 'この前話したカフェなんだっけ', images: [], features: [],
  }, { onClientAction: async (a) => { actions.push(a); } });

  assert.equal(result.ok, true);
  assert.equal(mainCalls[0].tools.some((t) => t.name === 'search_past_talk'), true);
  assert.match(JSON.stringify(mainCalls[0].mantleInput), /前の話を探す/);
  const output = JSON.parse(mainCalls[1].mantleInput.messages[0].output);
  assert.equal(output.found, true);
  assert.deepEqual(actions, [{ action: 'history.found', params: { threadId: 'thread-cafe', at: jst('2026-11-03', '10:05'), title: '週末の話', date: '2026-11-03' } }]);
  assert.deepEqual(appended[0].assistantMessage.meta.tools, [{ name: 'search_past_talk', query: '', ok: true, found: true }]);
});
