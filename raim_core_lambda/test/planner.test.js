'use strict';

const test = require('node:test');
const assert = require('node:assert');

const dates = require('../lib/planner/planner-dates');
const {
  mentionsPlanner,
  shouldOpenPlanner,
  buildPlannerContext,
  findItemByShortId,
  shortIdOf,
} = require('../lib/planner/planner-context');
const {
  isUsableLine,
  writeEventExtras,
  findEventCandidate,
  templateLine,
} = require('../lib/planner/planner-writer');
const { runPlannerTool, PLANNER_TOOL_NAMES } = require('../lib/tools/planner');
const { getToolDefinitions, pickToolIntro, isKnownTool } = require('../lib/tools');
const { createCoreChatService } = require('../lib/core-chat-service');
const { buildMantleInput } = require('../lib/prompt-builder');

// 2026-11-11(水) 11:30 JST
const NOW = new Date('2026-11-11T02:30:00Z');

// ─────────────────────────────────────────────
// 日付
// ─────────────────────────────────────────────

test('dates: JST today, labels and calendar', () => {
  // UTC では前日でも、日本時間ではもう次の日
  assert.equal(dates.todayJst(new Date('2026-11-10T15:30:00Z')), '2026-11-11');
  assert.equal(dates.todayJst(NOW), '2026-11-11');
  assert.equal(dates.formatDateLabel('2026-11-14'), '11/14(土)');
  assert.equal(dates.relativeDateLabel('2026-11-12', NOW), '明日');
  const lines = dates.buildCalendarLines(NOW, 3);
  assert.deepEqual(lines, ['2026-11-11 (水) 今日', '2026-11-12 (木) 明日', '2026-11-13 (金) あさって']);
});

test('dates: validation and time normalization', () => {
  assert.equal(dates.isValidDate('2026-02-30'), false);
  assert.equal(dates.isValidDate('2026-11-14'), true);
  assert.equal(dates.normalizeTime('9:05'), '09:05');
  assert.equal(dates.normalizeTime('10時'), '10:00');
  assert.equal(dates.normalizeTime('25:00'), '');
  assert.equal(dates.normalizeTime(''), '');
  assert.equal(dates.isAcceptableEventDate('2026-11-10', NOW), true); // 昨日まで許す
  assert.equal(dates.isAcceptableEventDate('2026-11-01', NOW), false);
  assert.equal(dates.isAcceptableEventDate('2030-01-01', NOW), false);
});

test('dates: expiresAt is 7 days after the event day ends', () => {
  const ttl = dates.expiresAtForEvent('2026-11-14');
  // 11/22 0:00 JST = 11/21 15:00 UTC
  assert.equal(ttl, Date.UTC(2026, 10, 21, 15, 0) / 1000);
});

// ─────────────────────────────────────────────
// 関門
// ─────────────────────────────────────────────

test('gate: opens only for date/schedule words or a planner follow-up', () => {
  assert.equal(mentionsPlanner('金曜の10時に面接入れといて'), true);
  assert.equal(mentionsPlanner('明日テストなんだよね'), true);
  assert.equal(mentionsPlanner('１１／１４に歯医者'), true); // 全角
  assert.equal(mentionsPlanner('今日もいい天気だね'), true); // 「今日」は入る（ツールは頼まれたときだけ）
  assert.equal(mentionsPlanner('ゲームしてた'), false);
  assert.equal(mentionsPlanner('おすすめの映画ある？'), false);
  // 直す・消す言葉は予定を持っている人だけ
  assert.equal(mentionsPlanner('あれ中止になった'), false);
  assert.equal(mentionsPlanner('あれ中止になった', { hasItems: true }), true);

  const features = ['planner'];
  assert.equal(shouldOpenPlanner({ features: [], userText: '明日面接' }), false);
  assert.equal(shouldOpenPlanner({ features, userText: '明日面接', greeting: true }), false);
  assert.equal(shouldOpenPlanner({ features, userText: 'うん' }), false);
  assert.equal(shouldOpenPlanner({
    features,
    userText: 'うん',
    history: [{ role: 'user', text: '面接消して' }, { role: 'assistant', text: '消していい？', meta: { planner: true } }],
  }), true);
});

test('context: lists upcoming events with short ids and a calendar', () => {
  const items = [
    { itemId: 'ev_abcdef12-0000', kind: 'event', title: '面接', date: '2026-11-14', time: '10:00', note: '' },
    { itemId: 'ev_99999999-0000', kind: 'event', title: '昔の予定', date: '2026-11-01', time: '' },
  ];
  const context = buildPlannerContext({ items, now: NOW });
  assert.match(context, /【予定の手帳】/);
  assert.match(context, /id=abcdef 2026-11-14 11\/14\(土\) 10:00 面接/);
  assert.doesNotMatch(context, /昔の予定/);
  assert.match(context, /2026-11-13 \(金\) あさって/);
  assert.equal(shortIdOf('ev_abcdef12-0000'), 'abcdef');
  assert.equal(findItemByShortId(items, 'abcdef').title, '面接');
  assert.equal(findItemByShortId(items, 'zzzzzz'), null);
});

test('prompt: planner context goes into both initial and follow-up input, and only when given', () => {
  const scene = { id: 'default', description: 'x', few_shots: [] };
  const plain = buildMantleInput({ userText: 'やあ', scene });
  const withPlanner = buildMantleInput({ userText: '明日面接', scene, plannerContext: '【予定の手帳】テスト' });
  assert.doesNotMatch(JSON.stringify(plain.messages), /予定の手帳/);
  assert.match(JSON.stringify(withPlanner.messages), /予定の手帳】テスト/);
  const followup = buildMantleInput({
    userText: '明日面接', scene, usePreviousResponseId: true, plannerContext: '【予定の手帳】テスト',
  });
  assert.match(JSON.stringify(followup.messages), /予定の手帳】テスト/);
});

test('tools: planner tools are offered only when the planner is open, with no intro line', () => {
  const names = (opts) => getToolDefinitions(opts).map((t) => t.name);
  assert.ok(!names({ features: ['planner'] }).includes('add_schedule'));
  assert.ok(names({ features: ['planner'], planner: true }).includes('add_schedule'));
  for (const name of PLANNER_TOOL_NAMES) {
    assert.equal(pickToolIntro(name, 1), '');
    assert.equal(isKnownTool(name), true);
  }
});

// ─────────────────────────────────────────────
// ツールの実行
// ─────────────────────────────────────────────

function createFakeStore(initial = []) {
  const items = [...initial];
  let n = 0;
  return {
    items,
    async listItems() { return [...items]; },
    async addEvent(sub, input) {
      n += 1;
      const item = { itemId: `ev_${String(n).padStart(6, '0')}aa`, kind: 'event', ...input, lines: {}, importance: 'normal' };
      items.push(item);
      return item;
    },
    async updateItem(sub, itemId, changes) {
      const item = items.find((i) => i.itemId === itemId);
      if (!item) return null;
      Object.assign(item, changes);
      return { ...item };
    },
    async deleteItem(sub, itemId) {
      const index = items.findIndex((i) => i.itemId === itemId);
      if (index < 0) return null;
      return items.splice(index, 1)[0];
    },
  };
}

test('add_schedule saves a valid event and reports the change', async () => {
  const store = createFakeStore();
  const { result, change } = await runPlannerTool('add_schedule',
    { title: '面接', date: '2026-11-14', time: '10時' },
    { sub: 'u', store, now: NOW });
  assert.equal(result.ok, true);
  assert.equal(change.type, 'added');
  assert.equal(store.items[0].time, '10:00');
  assert.equal(result.added.day, '11/14(土)');
});

test('add_schedule refuses bad dates and empty titles', async () => {
  const store = createFakeStore();
  const bad = await runPlannerTool('add_schedule', { title: '面接', date: '来週' }, { sub: 'u', store, now: NOW });
  assert.equal(bad.result.error, true);
  assert.equal(bad.change, null);
  const empty = await runPlannerTool('add_schedule', { title: ' ', date: '2026-11-14' }, { sub: 'u', store, now: NOW });
  assert.equal(empty.result.error, true);
  assert.equal(store.items.length, 0);
});

test('update_schedule changes only given fields; "なし" clears the time', async () => {
  const store = createFakeStore([{ itemId: 'ev_abcdef00', kind: 'event', title: '面接', date: '2026-11-14', time: '10:00' }]);
  const out = await runPlannerTool('update_schedule', { id: 'abcdef', time: '11:00' },
    { sub: 'u', store, items: store.items, now: NOW });
  assert.equal(out.change.type, 'updated');
  assert.deepEqual(out.change.changedFields, ['time']);
  assert.equal(store.items[0].time, '11:00');
  await runPlannerTool('update_schedule', { id: 'abcdef', time: 'なし' }, { sub: 'u', store, items: store.items, now: NOW });
  assert.equal(store.items[0].time, '');
  const missing = await runPlannerTool('update_schedule', { id: 'nope00', time: '11:00' }, { sub: 'u', store, items: store.items, now: NOW });
  assert.equal(missing.result.error, true);
});

test('delete_schedule needs the user to have agreed in this turn', async () => {
  const store = createFakeStore([{ itemId: 'ev_abcdef00', kind: 'event', title: '面接', date: '2026-11-14', time: '' }]);
  const ctx = (userText) => ({ sub: 'u', store, items: store.items, userText, now: NOW });
  const refused = await runPlannerTool('delete_schedule', { id: 'abcdef' }, ctx('面接の日って何日だっけ'));
  assert.equal(refused.result.error, true);
  assert.equal(store.items.length, 1);
  const ok = await runPlannerTool('delete_schedule', { id: 'abcdef' }, ctx('うん、消して'));
  assert.equal(ok.change.type, 'deleted');
  assert.equal(store.items.length, 0);
});

// ─────────────────────────────────────────────
// 知らせる文・予定っぽいもの
// ─────────────────────────────────────────────

test('usable lines reject relative dates, emoji and odd lengths', () => {
  assert.equal(isUsableLine('面接の準備、できてる？スーツも忘れずにね'), true);
  assert.equal(isUsableLine('明日は面接だね'), false);
  assert.equal(isUsableLine('あと1時間で面接だよ'), false);
  assert.equal(isUsableLine('がんばって🔥'), false);
  assert.equal(isUsableLine('ね'), false);
});

test('writeEventExtras uses LLM lines when usable and templates otherwise', async () => {
  const createResponse = async () => ({
    rawText: '{"importance":"important","eve":"面接の準備、できてる？","before":"明日だよ！","morning":"面接の日だね。深呼吸していこ"}',
  });
  const out = await writeEventExtras({ title: '面接', createResponse });
  assert.equal(out.fromLlm, true);
  assert.equal(out.importance, 'important');
  assert.equal(out.lines.eve, '面接の準備、できてる？');
  assert.equal(out.lines.before, templateLine('before', '面接')); // 「明日」が入っていたので決まり文句
  const failed = await writeEventExtras({ title: '面接', createResponse: async () => { throw new Error('x'); } });
  assert.equal(failed.fromLlm, false);
  assert.equal(failed.importance, 'normal');
});

test('findEventCandidate returns a future event or null', async () => {
  const reply = (text) => async () => ({ rawText: text });
  assert.deepEqual(
    await findEventCandidate({ userText: '明日テストなんだよね', now: NOW, createResponse: reply('{"title":"テスト","date":"2026-11-12","time":""}') }),
    { title: 'テスト', date: '2026-11-12', time: '' }
  );
  assert.equal(await findEventCandidate({ userText: 'x', now: NOW, createResponse: reply('{"none":true}') }), null);
  assert.equal(await findEventCandidate({ userText: 'x', now: NOW, createResponse: reply('{"title":"昨日の","date":"2026-11-10"}') }), null);
  assert.equal(await findEventCandidate({ userText: 'x', now: NOW, createResponse: reply('壊れた') }), null);
});

// ─────────────────────────────────────────────
// 会話の流れ
// ─────────────────────────────────────────────

function buildService({ text, features = ['planner'], mantleResponses, store, helperResponses = {} }) {
  const mainCalls = [];
  const helperCalls = [];
  const actions = [];
  const appended = [];
  let index = 0;
  const createMantleResponse = async (args) => {
    const mode = args?.mantleInput?.mode;
    if (mode === 'planner_extras' || mode === 'planner_candidate') {
      helperCalls.push(mode);
      return { rawText: helperResponses[mode] || '{"none":true}' };
    }
    mainCalls.push(args);
    const response = mantleResponses[Math.min(index, mantleResponses.length - 1)];
    index += 1;
    return response;
  };
  const service = createCoreChatService({
    getOrCreateUserSession: async () => ({ sessionSummary: '' }),
    getMantleSessionState: () => ({ usePreviousResponseId: false, previousResponseId: '' }),
    isMantleResponseExpiredError: () => false,
    clearMantleResponseState: async () => {},
    updateMantleResponseState: async () => {},
    resolveThread: async () => ({ threadId: 't1', thread: null, isNew: false }),
    ensureThreadTitle: async () => {},
    appendTurn: async (turn) => { appended.push(turn); return {}; },
    shouldSummarize: () => ({ shouldSummarize: false }),
    dispatchSummarization: async () => true,
    listSceneCandidates: async () => [],
    selectScene: async () => ({ sceneId: 'default' }),
    getSceneById: async () => ({ id: 'default', few_shots: [] }),
    createMantleResponse,
    isToolUseEnabled: async () => true,
    executeTool: async () => ({ ok: true }),
    plannerStore: store,
    now: () => NOW,
    plannerHelperTimeoutMs: 1000,
  });
  const run = () => service({
    schemaVersion: 1, type: 'chat.request', requestId: 'r1', sub: 'u1', source: 'websocket',
    text, images: [], features,
  }, { onClientAction: async (a) => { actions.push(a); } });
  return { run, mainCalls, helperCalls, actions, appended };
}

const replyText = (text) => ({ responseId: `resp-${text.length}`, rawText: JSON.stringify({ emotions: { happy: 0.6 }, text }), toolCalls: [] });

test('flow: a normal chat does not open the planner or read the table', async () => {
  let listed = 0;
  const store = { ...createFakeStore(), listItems: async () => { listed += 1; return []; } };
  const svc = buildService({ text: 'ゲームしてた', mantleResponses: [replyText('いいね')], store });
  const result = await svc.run();
  assert.equal(result.ok, true);
  assert.equal(listed, 0);
  assert.equal(svc.helperCalls.length, 0);
  assert.equal(svc.mainCalls[0].tools.some((t) => t.name === 'add_schedule'), false);
  assert.equal(svc.appended[0].assistantMessage.meta.planner, undefined);
});

test('flow: add_schedule saves, notifies the app, then sends LLM lines', async () => {
  const store = createFakeStore();
  const svc = buildService({
    text: '金曜の10時に面接、入れといて',
    store,
    mantleResponses: [
      { responseId: 'r-a', rawText: '', toolCalls: [{ name: 'add_schedule', callId: 'c1', arguments: JSON.stringify({ title: '面接', date: '2026-11-13', time: '10:00' }) }] },
      replyText('金曜10時の面接、入れといたよ'),
    ],
    helperResponses: {
      planner_extras: '{"importance":"important","eve":"面接の準備、できてる？","before":"いってらっしゃい、応援してる","morning":"面接の日だね"}',
      planner_candidate: '{"title":"面接","date":"2026-11-13","time":"10:00"}',
    },
  });
  const result = await svc.run();
  assert.equal(result.ok, true);
  assert.equal(store.items.length, 1);
  assert.deepEqual(svc.actions.map((a) => a.action), ['planner.added', 'planner.updated']);
  assert.equal(svc.actions[1].params.item.importance, 'important');
  assert.equal(store.items[0].enriched, true);
  // 入れた回は「予定に入れる？」は出さない
  assert.ok(!svc.actions.some((a) => a.action === 'planner.suggest'));
  assert.equal(svc.appended[0].assistantMessage.meta.planner, true);
  // ツールを返す2回目の呼び出しにはツールを渡さない
  assert.equal(svc.mainCalls[1].tools, null);
});

test('flow: a passing mention sends a suggestion instead of saving', async () => {
  const store = createFakeStore();
  const svc = buildService({
    text: '明日テストなんだよね',
    store,
    mantleResponses: [replyText('がんばってね')],
    helperResponses: { planner_candidate: '{"title":"テスト","date":"2026-11-12","time":""}' },
  });
  await svc.run();
  assert.equal(store.items.length, 0);
  assert.deepEqual(svc.actions, [{ action: 'planner.suggest', params: { candidate: { title: 'テスト', date: '2026-11-12', time: '' } } }]);
});

test('flow: apps without the planner feature never see planner tools', async () => {
  const store = createFakeStore();
  const svc = buildService({ text: '明日面接入れといて', features: [], store, mantleResponses: [replyText('うん')] });
  await svc.run();
  assert.equal(svc.helperCalls.length, 0);
  assert.equal(svc.mainCalls[0].tools.some((t) => t.name === 'add_schedule'), false);
});
