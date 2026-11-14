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

test('prompt: planner context goes into the input only when given', () => {
  const scene = { id: 'default', description: 'x', few_shots: [] };
  const plain = buildMantleInput({ userText: 'やあ', scene });
  const withPlanner = buildMantleInput({ userText: '明日面接', scene, plannerContext: '【予定の手帳】テスト' });
  assert.doesNotMatch(JSON.stringify(plain.messages), /予定の手帳/);
  assert.match(JSON.stringify(withPlanner.messages), /予定の手帳】テスト/);
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
    async addTimer(sub, input) {
      n += 1;
      const endsAt = new Date(NOW.getTime() + input.durationSec * 1000).toISOString();
      const item = { itemId: `tm_${String(n).padStart(6, '0')}bb`, kind: 'timer', title: input.title, durationSec: input.durationSec, endsAt };
      items.push(item);
      return item;
    },
    async addMemo(sub, input) {
      n += 1;
      const item = { itemId: `mm_${String(n).padStart(6, '0')}cc`, kind: 'memo', text: input.text, createdAt: NOW.toISOString() };
      items.push(item);
      return item;
    },
    async addList(sub, input) {
      n += 1;
      const entries = input.entries.map((text, i) => ({ id: `e0000000${i}`, text, checked: false }));
      const item = { itemId: `ls_${String(n).padStart(6, '0')}dd`, kind: 'list', title: input.title, entries, createdAt: NOW.toISOString() };
      items.push(item);
      return item;
    },
    async addFollowUp(sub, candidate) {
      n += 1;
      const item = { itemId: `fu_${String(n).padStart(6, '0')}ee`, kind: 'followup', importance: 'normal', source: 'suggest', ...candidate };
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
    { title: 'テスト', date: '2026-11-12', time: '', importance: 'normal' }
  );
  // 大事さも決める（押されなくても、大事なものは必ずあとで聞く）
  assert.equal((await findEventCandidate({ userText: '明日面接', now: NOW, createResponse: reply('{"title":"面接","date":"2026-11-12","time":"","importance":"important"}') })).importance, 'important');
  assert.equal((await findEventCandidate({ userText: '明日ゴミ出し', now: NOW, createResponse: reply('{"title":"ゴミ出し","date":"2026-11-12","importance":"chore"}') })).importance, 'chore');
  assert.equal((await findEventCandidate({ userText: 'x', now: NOW, createResponse: reply('{"title":"x","date":"2026-11-12","importance":"すごい"}') })).importance, 'normal');
  assert.equal(await findEventCandidate({ userText: 'x', now: NOW, createResponse: reply('{"none":true}') }), null);
  assert.equal(await findEventCandidate({ userText: 'x', now: NOW, createResponse: reply('{"title":"昨日の","date":"2026-11-10"}') }), null);
  assert.equal(await findEventCandidate({ userText: 'x', now: NOW, createResponse: reply('壊れた') }), null);
});

// ─────────────────────────────────────────────
// 会話の流れ
// ─────────────────────────────────────────────

const {
  normalizeReminder, buildReminderInstruction, reminderMatchesItem, reminderNeedsClaim, reminderSpokenKey, reminderAlreadySpoken,
} = require('../lib/planner/planner-reminder');

function buildService({ text, features = ['planner'], mantleResponses, store, helperResponses = {}, request = {}, thread = null }) {
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
    if (response instanceof Error) throw response;
    return response;
  };
  const service = createCoreChatService({
    getOrCreateUserSession: async () => ({ sessionSummary: '' }),
    resolveThread: async () => ({ threadId: 't1', thread, isNew: false }),
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
  const run = (options = {}) => service({
    schemaVersion: 1, type: 'chat.request', requestId: 'r1', sub: 'u1', source: 'websocket',
    text, images: [], features, ...request,
  }, { onClientAction: async (a) => { actions.push(a); }, ...options });
  return { run, mainCalls, helperCalls, actions, appended };
}

const replyText = (text) => ({ responseId: `resp-${text.length}`, rawText: JSON.stringify({ emotions: { happy: 0.6 }, text }), toolCalls: [] });

test('flow: a normal chat does not open the planner or read the table', async () => {
  let listed = 0;
  const store = { ...createFakeStore(), listItems: async () => { listed += 1; return []; } };
  // 会話のはじめの3往復を過ぎたあと（あとで聞くことを探すのは、はじめの3往復だけ）
  const recent = (min) => new Date(NOW.getTime() - min * 60000).toISOString();
  const thread = {
    messages: [1, 2, 3].flatMap((n) => [
      { role: 'user', text: `話${n}`, createdAt: recent(10 - n) },
      { role: 'assistant', text: 'うん', createdAt: recent(10 - n) },
    ]),
  };
  const svc = buildService({ text: 'ゲームしてた', mantleResponses: [replyText('いいね')], store, thread });
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
  // 予定には入れない（押されなかったら、あとで聞くこととして持つ）
  assert.deepEqual(store.items.map((i) => i.kind), ['followup']);
  const followUp = store.items[0];
  assert.deepEqual(svc.actions, [{
    action: 'planner.suggest',
    params: {
      candidate: { title: 'テスト', date: '2026-11-12', time: '', importance: 'normal', followUpId: followUp.itemId },
      item: followUp,
    },
  }]);
});

// ─────────────────────────────────────────────
// 返事もツールと一緒に書かせる（2026-11-13）
// ─────────────────────────────────────────────

const toolTurn = (name, args, responseId = 'r-tool') => ({
  responseId, rawText: '', toolCalls: [{ name, callId: 'c1', arguments: JSON.stringify(args) }],
});

test('quick reply: a timer with a reply ends after one call', async () => {
  const store = createFakeStore();
  const svc = buildService({
    text: '3分計って',
    store,
    mantleResponses: [toolTurn('set_timer', { minutes: 3, reply: 'りょーかい、3分ね' }), replyText('使われないはず')],
  });
  const deltas = [];
  const result = await svc.run({ onMantleTextDelta: (d) => deltas.push(d) });
  assert.equal(result.ok, true);
  assert.equal(result.text, 'りょーかい、3分ね');
  assert.equal(svc.mainCalls.length, 1);
  // 返事はふつうの返事と同じ形で流す（吹き出しと声）
  assert.equal(JSON.parse(deltas.join('')).text, 'りょーかい、3分ね');
  assert.equal(svc.actions[0].action, 'planner.added');
  const turn = svc.appended[0];
  // 次の発言は会話の記録から送り直すので、ツールの結果を持ち越さない
  assert.equal('pendingToolOutput' in turn, false);
  assert.equal(turn.assistantMessage.text, 'りょーかい、3分ね');
  assert.deepEqual(turn.assistantMessage.meta.tools, [{ name: 'set_timer', query: '', ok: true, quick: true }]);
  // ツールの説明に reply がある
  assert.ok(svc.mainCalls[0].tools.find((t) => t.name === 'set_timer').parameters.properties.reply);
  assert.equal(svc.mainCalls[0].tools.find((t) => t.name === 'show_memos').parameters.properties.reply, undefined);
});

test('quick reply: failures, nothing changed, or no reply go through the second call as before', async () => {
  // パスワードは断る（1回目の「メモしといたよ」は言わない）
  const refused = buildService({
    text: 'Wi-Fiのパスワード abc123 メモして',
    store: createFakeStore(),
    mantleResponses: [toolTurn('add_memo', { text: 'Wi-Fi abc123', reply: 'メモしといたよ' }), replyText('それは自分で控えてね')],
  });
  const r1 = await refused.run();
  assert.equal(r1.text, 'それは自分で控えてね');
  assert.equal(refused.mainCalls.length, 2);

  // 返事を書かなかった
  const noReply = buildService({
    text: '3分計って',
    store: createFakeStore(),
    mantleResponses: [toolTurn('set_timer', { minutes: 3 }), replyText('3分ね')],
  });
  assert.equal((await noReply.run()).text, '3分ね');
  assert.equal(noReply.mainCalls.length, 2);

  // もう入っていた（手帳は変わらない）
  const store = createFakeStore([{ itemId: 'ls_aaaaaa00', kind: 'list', title: '買うもの', entries: [{ id: 'e00000001', text: '牛乳', checked: false }] }]);
  const already = buildService({
    text: '買うものに牛乳足して',
    store,
    mantleResponses: [toolTurn('add_to_list', { list: '買うもの', entries: ['牛乳'], reply: '足したよ' }), replyText('もう入ってたよ')],
  });
  assert.equal((await already.run()).text, 'もう入ってたよ');
  assert.equal(already.mainCalls.length, 2);
});

test('quick reply: the next turn starts fresh from the history, not from the tool call', async () => {
  // 前は次の発言の頭で、ツールの結果と言った返事を Mantle に渡してから続けていた
  const svc = buildService({
    text: 'ありがとう',
    store: createFakeStore(),
    thread: {
      messages: [],
      pendingToolOutput: { responseId: 'r-tool', callId: 'c1', output: '{}', assistantText: '{}' },
      lastResponseId: 'r-tool',
    },
    mantleResponses: [replyText('どういたしまして')],
  });
  await svc.run();
  assert.equal(svc.mainCalls[0].previousResponseId, '');
  assert.ok(!svc.mainCalls[0].mantleInput.messages.some((m) => m.type === 'function_call_output'));
});

test('quick reply: quickReplyOf only for tools that changed the notebook', () => {
  const { quickReplyOf } = require('../lib/tools/planner');
  const ok = { result: { ok: true }, change: { type: 'added', item: {} } };
  assert.equal(quickReplyOf('set_timer', { reply: ' 3分ね ' }, ok), '3分ね');
  assert.equal(quickReplyOf('show_memos', { reply: 'これだよ' }, { result: { ok: true }, change: { type: 'show', items: [] } }), '');
  assert.equal(quickReplyOf('add_to_list', { reply: '足したよ' }, { result: { ok: true, alreadyThere: {} }, change: null }), '');
  assert.equal(quickReplyOf('add_memo', { reply: 'メモしたよ' }, { result: { error: true }, change: null }), '');
  assert.equal(quickReplyOf('set_timer', { reply: 'あ'.repeat(201) }, ok), '');
  assert.equal(quickReplyOf('web_search', { reply: 'x' }, ok), '');
});

// 返事の終わりを先に送り、「予定に入れる？」はそのあとに届ける（2026-11-13）
test('flow: with deferAfterReply the suggestion is sent after the reply returns', async () => {
  const store = createFakeStore();
  const svc = buildService({
    text: '明日テストなんだよね',
    store,
    mantleResponses: [replyText('がんばってね')],
    helperResponses: { planner_candidate: '{"title":"テスト","date":"2026-11-12","time":""}' },
  });
  const deferred = [];
  const result = await svc.run({ deferAfterReply: (task) => deferred.push(task) });
  assert.equal(result.ok, true);
  assert.equal(svc.actions.length, 0);
  assert.equal(deferred.length, 1);
  await deferred[0]();
  assert.equal(svc.actions[0].action, 'planner.suggest');
});

// 予定の仕事が無い普通の会話では、何も預けない
test('flow: plain chat defers nothing', async () => {
  const svc = buildService({ text: 'ゲームしてた', store: createFakeStore(), mantleResponses: [replyText('いいね')] });
  const deferred = [];
  await svc.run({ deferAfterReply: (task) => deferred.push(task) });
  assert.equal(deferred.length, 0);
});

test('flow: apps without the planner feature never see planner tools', async () => {
  const store = createFakeStore();
  const svc = buildService({ text: '明日面接入れといて', features: [], store, mantleResponses: [replyText('うん')] });
  await svc.run();
  assert.equal(svc.helperCalls.length, 0);
  assert.equal(svc.mainCalls[0].tools.some((t) => t.name === 'add_schedule'), false);
});

// ─────────────────────────────────────────────
// 手で足した予定の仕上げ
// ─────────────────────────────────────────────

const { parsePlannerEnrichMessage, enrichPlannerItem } = require('../lib/planner/planner-enrich');
const { createSqsCoreHandler } = require('../lib/sqs-core-handler');

test('enrich: parses only planner.enrich messages', () => {
  assert.equal(parsePlannerEnrichMessage('{"type":"chat.request"}'), null);
  assert.equal(parsePlannerEnrichMessage('壊れた'), null);
  assert.deepEqual(
    parsePlannerEnrichMessage('{"type":"planner.enrich","sub":"u","itemId":"ev_1","connectionId":"c","requestId":"r"}'),
    { sub: 'u', itemId: 'ev_1', connectionId: 'c', requestId: 'r' }
  );
});

test('enrich: writes lines once and notifies the app', async () => {
  const store = createFakeStore([{ itemId: 'ev_1', kind: 'event', title: '歯医者', date: '2026-11-14', time: '', enriched: false }]);
  store.getItem = async (sub, id) => store.items.find((i) => i.itemId === id) || null;
  const notified = [];
  const deps = {
    store,
    writeEventExtras: async () => ({ lines: { eve: 'a', before: 'b', morning: 'c' }, importance: 'normal', fromLlm: true }),
    createResponse: null,
    notify: async (a) => notified.push(a),
  };
  assert.equal(await enrichPlannerItem({ sub: 'u', itemId: 'ev_1' }, deps), true);
  assert.equal(notified[0].action, 'planner.updated');
  // 2回目は作り直さない
  assert.equal(await enrichPlannerItem({ sub: 'u', itemId: 'ev_1' }, deps), false);
});

test('sqs: planner.enrich messages skip the chat flow', async () => {
  let chats = 0;
  const jobs = [];
  const handler = createSqsCoreHandler({
    handleCoreChat: async () => { chats += 1; return { ok: true }; },
    enrichPlannerItem: async (job) => { jobs.push(job); return true; },
    createResponseQueuePublisher: () => ({ clientAction: async () => {} }),
  });
  const result = await handler({
    Records: [{ eventSource: 'aws:sqs', messageId: 'm1', body: JSON.stringify({ type: 'planner.enrich', sub: 'u', itemId: 'ev_1', connectionId: 'c1' }) }],
  });
  assert.deepEqual(result.batchItemFailures, []);
  assert.equal(chats, 0);
  assert.equal(jobs[0].itemId, 'ev_1');
});

// ─────────────────────────────────────────────
// 予定を知らせる話しかけ
// ─────────────────────────────────────────────

test('reminder: only well-formed itemId and slot pass', () => {
  assert.deepEqual(normalizeReminder({ itemId: 'ev_123e4567-e89b-12d3-a456-426614174000', slot: 'eve' }), {
    itemId: 'ev_123e4567-e89b-12d3-a456-426614174000', slot: 'eve',
  });
  assert.equal(normalizeReminder({ itemId: 'ev_x', slot: 'eve' }), null);
  assert.equal(normalizeReminder({ itemId: 'ev_123e4567-e89b', slot: 'noon' }), null);
  assert.equal(normalizeReminder('ev_1'), null);
});

test('reminder: instruction names the event with today/tomorrow and the importance', () => {
  const item = { title: '面接', date: '2026-11-12', time: '10:00', note: 'スーツ', importance: 'important' };
  const text = buildReminderInstruction({ item, slot: 'eve', now: NOW });
  assert.match(text, /面接/);
  assert.match(text, /明日（11\/12\(木\)） 10:00/);
  assert.match(text, /スーツ/);
  assert.match(text, /応援/);
  assert.doesNotMatch(buildReminderInstruction({ item: { ...item, importance: 'normal' }, slot: 'before', now: NOW }), /応援/);
});

test('flow: a reminder greeting reads the item and uses the reminder instruction', async () => {
  const store = createFakeStore([
    { itemId: 'ev_000001aa-0000', kind: 'event', title: '歯医者', date: '2026-11-11', time: '15:00', importance: 'normal' },
  ]);
  store.getItem = async (sub, itemId) => store.items.find((i) => i.itemId === itemId) || null;
  const svc = buildService({
    text: '', mantleResponses: [replyText('このあと15時に歯医者だよ')], store,
    request: { greeting: true, reminder: { itemId: 'ev_000001aa-0000', slot: 'before' } },
  });
  const result = await svc.run();
  assert.equal(result.ok, true);
  const prompt = JSON.stringify(svc.mainCalls[0].mantleInput || svc.mainCalls[0]);
  assert.match(prompt, /予定を知らせる話しかけ/);
  assert.match(prompt, /歯医者/);
  assert.deepEqual(svc.appended[0].assistantMessage.meta.reminder, { itemId: 'ev_000001aa-0000', slot: 'before' });
  // ユーザーの発言の位置も「知らせる合図」にする（「アプリが開かれた合図」だと呼ばれたと受け取る）
  assert.match(prompt, /予定を知らせる時間になった合図/);
  assert.doesNotMatch(prompt, /アプリが開かれた合図/);

  // 予定が消えていたら、普段の話しかけにする
  const gone = buildService({
    text: '', mantleResponses: [replyText('やっほー')], store,
    request: { greeting: true, reminder: { itemId: 'ev_999999aa-0000', slot: 'before' } },
  });
  await gone.run();
  assert.doesNotMatch(JSON.stringify(gone.mainCalls[0].mantleInput || gone.mainCalls[0]), /予定を知らせる話しかけ/);
  assert.match(JSON.stringify(gone.mainCalls[0].mantleInput || gone.mainCalls[0]), /アプリが開かれた合図/);
  assert.equal(gone.appended[0].assistantMessage.meta.reminder, undefined);
});

test('reminder: a timer uses its own instruction and only the timer slot', () => {
  assert.deepEqual(normalizeReminder({ itemId: 'tm_123e4567-e89b', slot: 'timer' }), { itemId: 'tm_123e4567-e89b', slot: 'timer' });
  const timer = { itemId: 'tm_1', kind: 'timer', title: 'パスタ', durationSec: 300, endsAt: NOW.toISOString() };
  assert.equal(reminderMatchesItem(timer, 'timer'), true);
  assert.equal(reminderMatchesItem(timer, 'before'), false);
  assert.equal(reminderMatchesItem({ kind: 'event' }, 'timer'), false);
  assert.equal(reminderMatchesItem(null, 'timer'), false);
  const text = buildReminderInstruction({ item: timer, slot: 'timer', now: NOW });
  assert.match(text, /タイマーを知らせる話しかけ/);
  assert.match(text, /5分/);
  assert.match(text, /パスタ/);
  assert.doesNotMatch(text, /さっき/);
  const late = buildReminderInstruction({ item: timer, slot: 'timer', now: new Date(NOW.getTime() + 20 * 60000) });
  assert.match(late, /20分くらいたっている/);
  const plain = buildReminderInstruction({ item: { ...timer, title: 'タイマー', durationSec: 5400 }, slot: 'timer', now: NOW });
  assert.match(plain, /1時間30分/);
  assert.doesNotMatch(plain, /何のタイマーか/);
});

test('flow: a timer reminder greeting reads the timer', async () => {
  const store = createFakeStore([
    { itemId: 'tm_000001aa-0000', kind: 'timer', title: '洗濯物', durationSec: 1800, endsAt: NOW.toISOString() },
  ]);
  store.getItem = async (sub, itemId) => store.items.find((i) => i.itemId === itemId) || null;
  const svc = buildService({
    text: '', mantleResponses: [replyText('洗濯物の時間だよ')], store,
    request: { greeting: true, reminder: { itemId: 'tm_000001aa-0000', slot: 'timer' } },
  });
  await svc.run();
  const prompt = JSON.stringify(svc.mainCalls[0].mantleInput || svc.mainCalls[0]);
  assert.match(prompt, /タイマーを知らせる話しかけ/);
  assert.match(prompt, /洗濯物/);
  // Windows で開いたまま鳴ったときに「どうしたの？」と返していた（2026-11-13）
  assert.match(prompt, /タイマーの時間になった合図/);
  assert.doesNotMatch(prompt, /アプリが開かれた合図/);
  // 知らせは挨拶の言葉を付けずに中身から（「やっほー！」で始めていた）
  assert.match(prompt, /挨拶の言葉は付けずに/);
  assert.deepEqual(svc.appended[0].assistantMessage.meta.reminder, { itemId: 'tm_000001aa-0000', slot: 'timer' });
});

// Windows が時刻に話したあとスマホの通知を押すと、同じタイマーの話を2回していた（2026-11-13）
test('flow: the same reminder is spoken only once; snooze always speaks', async () => {
  const store = createFakeStore([
    { itemId: 'tm_000001aa-0000', kind: 'timer', title: '洗濯物', durationSec: 1800, endsAt: NOW.toISOString() },
  ]);
  store.getItem = async (sub, itemId) => {
    const item = store.items.find((i) => i.itemId === itemId);
    return item ? { ...item } : null;
  };
  const marks = [];
  store.markReminderSpoken = async (sub, itemId, slot, key) => {
    marks.push({ itemId, slot, key });
    const item = store.items.find((i) => i.itemId === itemId);
    item[`spoken_${slot}`] = key;
    return true;
  };
  const request = { greeting: true, reminder: { itemId: 'tm_000001aa-0000', slot: 'timer' } };

  // Mantle が失敗した回は、話していない扱い（印を付けない）
  const mantleDown = Object.assign(new Error('Mantle request timed out'), { coreErrorCode: 'LLM_TIMEOUT' });
  const broken = buildService({ text: '', mantleResponses: [mantleDown], store, request });
  await broken.run().catch(() => {});
  assert.equal(marks.length, 0);

  const first = buildService({ text: '', mantleResponses: [replyText('洗濯物の時間だよ')], store, request });
  assert.equal((await first.run()).ok, true);
  assert.deepEqual(marks, [{ itemId: 'tm_000001aa-0000', slot: 'timer', key: NOW.toISOString() }]);

  // 2回目：AIを呼ばず、会話にも残さない
  const second = buildService({ text: '', mantleResponses: [replyText('洗濯物の時間だよ')], store, request });
  const again = await second.run();
  assert.equal(again.ok, false);
  assert.equal(again.code, 'REMINDER_ALREADY_SPOKEN');
  assert.equal(again.retriable, false);
  assert.equal(second.mainCalls.length, 0);
  assert.equal(second.appended.length, 0);

  // 「もう一回」は何回でも話す（印も付けない）
  const snooze = buildService({
    text: '', mantleResponses: [replyText('洗濯物、もう一回だよ')], store,
    request: { greeting: true, reminder: { itemId: 'tm_000001aa-0000', slot: 'snooze' } },
  });
  assert.equal((await snooze.run()).ok, true);
  assert.match(JSON.stringify(snooze.mainCalls[0].mantleInput || snooze.mainCalls[0]), /タイマーを知らせる話しかけ/);
  assert.equal(marks.length, 1);

  // タイマーをかけ直して終わる時刻が変わったら、また話す
  store.items[0].endsAt = new Date(NOW.getTime() + 60000).toISOString();
  const moved = buildService({ text: '', mantleResponses: [replyText('洗濯物の時間だよ')], store, request });
  assert.equal((await moved.run()).ok, true);
});

test('reminder: spoken key follows the date/time, snooze is repeatable', () => {
  assert.equal(reminderNeedsClaim('timer'), true);
  assert.equal(reminderNeedsClaim('before'), true);
  assert.equal(reminderNeedsClaim('snooze'), false);
  assert.equal(reminderMatchesItem({ kind: 'timer' }, 'snooze'), true);
  assert.equal(reminderMatchesItem({ kind: 'event' }, 'snooze'), false);
  assert.deepEqual(normalizeReminder({ itemId: 'tm_123e4567-e89b', slot: 'snooze' }), { itemId: 'tm_123e4567-e89b', slot: 'snooze' });
  assert.equal(reminderSpokenKey({ kind: 'event', date: '2026-11-12', time: '10:00' }), '2026-11-12 10:00');
  assert.equal(reminderSpokenKey({ kind: 'event', date: '2026-11-12' }), '2026-11-12');
  assert.equal(reminderSpokenKey({ kind: 'timer', endsAt: '2026-11-11T03:00:00.000Z' }), '2026-11-11T03:00:00.000Z');
  const event = { kind: 'event', date: '2026-11-12', time: '10:00' };
  assert.equal(reminderAlreadySpoken({ ...event, spoken_before: '2026-11-12 10:00' }, 'before'), true);
  assert.equal(reminderAlreadySpoken({ ...event, spoken_before: '2026-11-12 09:00' }, 'before'), false);
  assert.equal(reminderAlreadySpoken({ ...event, spoken_eve: '2026-11-12 10:00' }, 'before'), false);
  assert.equal(reminderAlreadySpoken(event, 'before'), false);
});

test('store: markReminderSpoken writes spoken_<slot> only on an existing item', async () => {
  const { createPlannerStore } = require('../lib/planner/planner-store');
  const sent = [];
  const docClient = {
    async send(command) {
      sent.push(command.input);
      if (command.input.Key.itemId === 'ev_gone') {
        const error = new Error('gone');
        error.name = 'ConditionalCheckFailedException';
        throw error;
      }
      return {};
    },
  };
  const store = createPlannerStore({ docClient, now: () => NOW });
  assert.equal(await store.markReminderSpoken('u1', 'ev_1', 'before', '2026-11-12 10:00'), true);
  assert.equal(await store.markReminderSpoken('u1', 'ev_gone', 'before', '2026-11-12 10:00'), false);
  assert.deepEqual(sent[0].Key, { sub: 'u1', itemId: 'ev_1' });
  assert.deepEqual(sent[0].ExpressionAttributeNames, { '#spoken': 'spoken_before' });
  assert.deepEqual(sent[0].ExpressionAttributeValues, { ':key': '2026-11-12 10:00' });
  assert.equal(sent[0].ConditionExpression, 'attribute_exists(itemId)');
});

test('timer gate: timer words open the planner but do not look for an event suggestion', () => {
  const { mentionsTimer, mentionsEventDate } = require('../lib/planner/planner-context');
  assert.equal(mentionsTimer('3分計って'), true);
  assert.equal(mentionsTimer('３０分たったら教えて'), true);
  assert.equal(mentionsTimer('タイマーやめて'), true);
  assert.equal(mentionsTimer('5分で着く'), false);
  assert.equal(mentionsPlanner('カップ麺、3分計って'), true);
  assert.equal(mentionsEventDate('カップ麺、3分計って'), false);
  // 動いているタイマーがあれば、止める言葉でも開く
  const timers = [{ itemId: 'tm_aaaaaa00-0000', kind: 'timer', title: 'カップ麺', endsAt: new Date(Date.now() + 60000).toISOString() }];
  assert.equal(shouldOpenPlanner({ features: ['planner'], userText: 'やっぱ消して', items: timers }), true);
});

test('set_timer: starts within 24h, refuses longer or empty', async () => {
  const store = createFakeStore();
  const ok = await runPlannerTool('set_timer', { minutes: 3, label: 'カップ麺' }, { sub: 'u', store, items: [], now: NOW });
  assert.equal(ok.change.type, 'added');
  assert.equal(ok.change.item.kind, 'timer');
  assert.equal(ok.change.item.durationSec, 180);
  assert.equal(ok.result.started.length, '3分');
  assert.equal(ok.result.started.ringsAt, '11:33');

  const mixed = await runPlannerTool('set_timer', { hours: '1', minutes: 30 }, { sub: 'u', store, items: [], now: NOW });
  assert.equal(mixed.change.item.durationSec, 5400);
  assert.equal(mixed.change.item.title, 'タイマー');

  const long = await runPlannerTool('set_timer', { hours: 25 }, { sub: 'u', store, items: [], now: NOW });
  assert.equal(long.change, null);
  assert.match(long.result.message, /予定に入れるか/);
  const empty = await runPlannerTool('set_timer', { minutes: -3 }, { sub: 'u', store, items: [], now: NOW });
  assert.equal(empty.change, null);
});

test('cancel_timer: stops the only timer without asking, asks when there are several', async () => {
  const future = (min) => new Date(NOW.getTime() + min * 60000).toISOString();
  const one = [{ itemId: 'tm_aaaaaa00-0000', kind: 'timer', title: 'カップ麺', durationSec: 180, endsAt: future(2) }];
  const store = createFakeStore(one);
  const done = await runPlannerTool('cancel_timer', {}, { sub: 'u', store, items: one, now: NOW });
  assert.equal(done.change.type, 'deleted');
  assert.equal(store.items.length, 0);

  const two = [...one, { itemId: 'tm_bbbbbb00-0000', kind: 'timer', title: '洗濯', durationSec: 600, endsAt: future(8) }];
  const store2 = createFakeStore(two);
  const ask = await runPlannerTool('cancel_timer', {}, { sub: 'u', store: store2, items: two, now: NOW });
  assert.equal(ask.change, null);
  assert.match(ask.result.message, /どれ/);
  const pick = await runPlannerTool('cancel_timer', { id: 'bbbbbb' }, { sub: 'u', store: store2, items: two, now: NOW });
  assert.equal(pick.change.item.title, '洗濯');

  const none = await runPlannerTool('cancel_timer', {}, { sub: 'u', store: createFakeStore(), items: [], now: NOW });
  assert.match(none.result.message, /無かった/);
});

test('timer context: running timers are listed, rung ones are not', () => {
  const items = [
    { itemId: 'tm_aaaaaa00-0000', kind: 'timer', title: 'カップ麺', endsAt: new Date(NOW.getTime() + 180000).toISOString() },
    { itemId: 'tm_cccccc00-0000', kind: 'timer', title: '終わった', endsAt: new Date(NOW.getTime() - 60000).toISOString() },
  ];
  const context = buildPlannerContext({ items, now: NOW });
  assert.match(context, /id=aaaaaa タイマー「カップ麺」 11:33 に鳴る（あと約3分）/);
  assert.doesNotMatch(context, /終わった/);
  assert.match(context, /set_timer/);
});

test('flow: set_timer saves, notifies the app, and writes no extra lines or suggestion', async () => {
  const store = createFakeStore();
  const svc = buildService({
    text: 'カップ麺、3分計って',
    store,
    mantleResponses: [
      { responseId: 'r-t', rawText: '', toolCalls: [{ name: 'set_timer', callId: 'c1', arguments: JSON.stringify({ minutes: 3, label: 'カップ麺' }) }] },
      replyText('3分ね、計っとく'),
    ],
  });
  const result = await svc.run();
  assert.equal(result.ok, true);
  assert.deepEqual(svc.actions.map((a) => a.action), ['planner.added']);
  assert.equal(svc.actions[0].params.item.kind, 'timer');
  assert.equal(svc.helperCalls.length, 0);
  assert.ok(svc.mainCalls[0].tools.some((t) => t.name === 'set_timer'));
});

// ─────────────────────────────────────────────
// メモ帳（機能2）
// ─────────────────────────────────────────────

const memoLib = require('../lib/planner/planner-memo');
const plannerContext = require('../lib/planner/planner-context');
const { createPlannerStore } = require('../lib/planner/planner-store');

const shopping = () => ({
  itemId: 'ls_aaaaaa00-0000', kind: 'list', title: '買うもの', createdAt: '2026-11-01T00:00:00Z',
  entries: [
    { id: 'e00000001', text: '牛乳', checked: false },
    { id: 'e00000002', text: '卵', checked: false },
  ],
});

test('memo: secrets are refused; checked entries drop off the next day (JST)', () => {
  assert.equal(memoLib.looksSecret('Wi-Fi のパスワードは abc123'), true);
  assert.equal(memoLib.looksSecret('暗証番号 1234'), true);
  assert.equal(memoLib.looksSecret('4980 1234 5678 9012'), true);
  assert.equal(memoLib.looksSecret('駐輪場は3階'), false);
  assert.equal(memoLib.looksSecret('電話 090-1234-5678'), false);
  const entries = [
    { id: 'e1', text: 'a', checked: true, checkedAt: '2026-11-10T14:00:00Z' }, // 11/10 23:00 JST → 消す
    { id: 'e2', text: 'b', checked: true, checkedAt: '2026-11-10T16:00:00Z' }, // 11/11 01:00 JST → 残す
    { id: 'e3', text: 'c', checked: false },
  ];
  assert.deepEqual(memoLib.pruneCheckedEntries(entries, NOW).map((e) => e.id), ['e2', 'e3']);
  assert.equal(memoLib.findListByName([shopping()], '買うものリスト').title, '買うもの');
  assert.deepEqual(memoLib.matchEntries(shopping().entries, ['牛乳']).map((e) => e.id), ['e00000001']);
});

test('memo gate: memo words open it; list content opens it only with an action word', () => {
  const items = [shopping()];
  const open = (userText) => plannerContext.shouldOpenPlanner({ features: ['planner'], userText, items });
  assert.equal(open('駐輪場は3階ってメモして'), true);
  assert.equal(open('牛乳買った'), true);
  assert.equal(open('牛乳おいしいよね'), false);
  assert.equal(open('ゲームやった'), false);
  assert.equal(open('おすすめの映画ある？'), false);
  assert.equal(plannerContext.mayNeedPlanner('ゲームしてた'), false);
  // 買い物リストがまだ無くても、「買い物」と足す言葉がそろえば開く（2026-11-13）
  const openEmpty = (userText) => plannerContext.shouldOpenPlanner({ features: ['planner'], userText, items: [] });
  assert.equal(openEmpty('買い物にパン足して'), true);
  assert.equal(openEmpty('買い出しのとき卵も買う'), true);
  assert.equal(openEmpty('かいものに洗剤追加で'), true);
  assert.equal(plannerContext.mayNeedPlanner('買い物にパン足して'), true);
  assert.equal(openEmpty('買い物行ってきた'), false);
  assert.equal(openEmpty('買い物楽しかった'), false);
  assert.equal(openEmpty('パン足して'), false);
  // 「買い物行ってきた」：チェックしていない買い物リストがあるときだけ開く（2026-11-13）
  const shoppingList = [{ itemId: 'ls_cccccc00', kind: 'list', title: '買い物リスト', entries: [{ text: 'パン', checked: false }] }];
  const allChecked = [{ itemId: 'ls_cccccc00', kind: 'list', title: '買うもの', entries: [{ text: 'パン', checked: true }] }];
  const openWith = (userText, list) => plannerContext.shouldOpenPlanner({ features: ['planner'], userText, items: list });
  assert.equal(openWith('買い物行ってきた', shoppingList), true);
  assert.equal(openWith('買い出し終わったよ', shoppingList), true);
  assert.equal(openWith('買い物してきた', shoppingList), true);
  assert.equal(openWith('買い物行ってきた', allChecked), false);
  assert.equal(openWith('買い物楽しかった', shoppingList), false);
  assert.equal(openWith('散歩行ってきた', shoppingList), false);
  assert.equal(plannerContext.mayNeedPlanner('買い物行ってきた'), true);
  assert.equal(plannerContext.hasOpenShoppingList(shoppingList), true);
  assert.equal(plannerContext.hasOpenShoppingList(allChecked), false);
  const context = buildPlannerContext({ items: [...items, { itemId: 'mm_bbbbbb00', kind: 'memo', text: '駐輪場は3階', createdAt: NOW.toISOString() }], now: NOW });
  assert.match(context, /メモ帳/);
  assert.match(context, /メモ「駐輪場は3階」（11\/11）/);
  assert.match(context, /リスト「買うもの」: 牛乳、卵/);
});

test('add_memo saves; passwords are refused', async () => {
  const store = createFakeStore();
  const ok = await runPlannerTool('add_memo', { text: '駐輪場は3階' }, { sub: 'u', store, userText: '駐輪場は3階ってメモして', now: NOW });
  assert.equal(ok.change.type, 'added');
  assert.equal(store.items[0].kind, 'memo');
  const secret = await runPlannerTool('add_memo', { text: 'Wi-Fi abc123' }, { sub: 'u', store, userText: 'Wi-Fiのパスワードabc123メモして', now: NOW });
  assert.equal(secret.result.error, true);
  assert.match(secret.result.message, /自分で控えて/);
  assert.equal(store.items.length, 1);
});

test('add_to_list creates a list, adds new entries, revives checked ones, skips duplicates', async () => {
  const store = createFakeStore();
  const ctx = () => ({ sub: 'u', store, items: [...store.items], userText: '', now: NOW });
  const created = await runPlannerTool('add_to_list', { list: '買うもの', entries: ['牛乳', '卵'] }, ctx());
  assert.equal(created.change.type, 'added');
  assert.equal(created.change.params.addedEntryIds.length, 2);
  store.items[0].entries[0].checked = true;
  const added = await runPlannerTool('add_to_list', { list: '買い物リスト', entries: ['牛乳、パン', '卵'] }, ctx());
  assert.equal(added.change.type, 'updated');
  assert.equal(added.change.params.addedEntryIds.length, 2); // 牛乳を戻して、パンを足す
  assert.deepEqual(store.items[0].entries.map((e) => [e.text, e.checked]), [['牛乳', false], ['卵', false], ['パン', false]]);
  const same = await runPlannerTool('add_to_list', { list: '買うもの', entries: ['卵'] }, ctx());
  assert.equal(same.change, null);
  assert.ok(same.result.alreadyThere);
});

test('check_list_entries checks without asking; remove_list_entries removes; finds the list from the entry', async () => {
  const store = createFakeStore([shopping()]);
  const ctx = () => ({ sub: 'u', store, items: [...store.items], userText: '牛乳買った', now: NOW });
  const checked = await runPlannerTool('check_list_entries', { entries: ['牛乳'] }, ctx());
  assert.equal(checked.change.type, 'updated');
  assert.equal(store.items[0].entries[0].checked, true);
  assert.equal(store.items[0].entries[0].checkedAt, NOW.toISOString());
  const none = await runPlannerTool('check_list_entries', { entries: ['りんご'] }, ctx());
  assert.equal(none.result.error, true);
  await runPlannerTool('remove_list_entries', { list: '買うもの', entries: ['卵'] }, ctx());
  assert.deepEqual(store.items[0].entries.map((e) => e.text), ['牛乳']);
});

test('show_memos speaks 3 newest and shows all in a card; delete_memo needs agreement', async () => {
  const memos = [1, 2, 3, 4, 5].map((i) => ({
    itemId: `mm_00000${i}aa-0000`, kind: 'memo', text: `メモ${i}`, createdAt: `2026-11-0${i}T00:00:00Z`,
  }));
  const store = createFakeStore([...memos, shopping()]);
  const ctx = (userText = '') => ({ sub: 'u', store, items: [...store.items], userText, now: NOW });
  const all = await runPlannerTool('show_memos', {}, ctx());
  assert.deepEqual(all.result.newestMemos, ['メモ5', 'メモ4', 'メモ3']);
  assert.equal(all.result.moreMemos, 2);
  assert.equal(all.change.type, 'show');
  assert.equal(all.change.items.length, 5);
  const list = await runPlannerTool('show_memos', { id: 'aaaaaa' }, ctx());
  assert.deepEqual(list.result.notYet, ['牛乳', '卵']);
  assert.equal(list.change.items[0].kind, 'list');
  const refused = await runPlannerTool('delete_memo', { id: '000001' }, ctx('メモ1ってなんだっけ'));
  assert.equal(refused.result.error, true);
  const ok = await runPlannerTool('delete_memo', { id: '000001' }, ctx('うん、消して'));
  assert.equal(ok.change.type, 'deleted');
});

test('flow: show_memos sends planner.show with the items', async () => {
  const store = createFakeStore([shopping()]);
  const svc = buildService({
    text: '買うもの何だっけ',
    store,
    mantleResponses: [
      { responseId: 'r-m', rawText: '', toolCalls: [{ name: 'show_memos', callId: 'c1', arguments: JSON.stringify({ id: 'aaaaaa' }) }] },
      replyText('牛乳と卵だよ'),
    ],
  });
  await svc.run();
  assert.deepEqual(svc.actions.map((a) => a.action), ['planner.show']);
  assert.equal(svc.actions[0].params.items[0].title, '買うもの');
});

test('store: memos have no expiry; list updates drop old checked entries', async () => {
  const sent = [];
  const docClient = {
    async send(command) {
      sent.push(command);
      if (command.constructor.name === 'UpdateCommand') return { Attributes: { sub: 'u', itemId: 'ls_1', kind: 'list', entries: command.input.ExpressionAttributeValues[':entries'] } };
      return {};
    },
  };
  const store = createPlannerStore({ docClient, now: () => NOW });
  const memo = await store.addMemo('u', { text: '駐輪場は3階' });
  assert.equal(memo.kind, 'memo');
  assert.equal(sent[0].input.Item.expiresAt, undefined);
  const list = await store.addList('u', { title: '買うもの', entries: ['牛乳'] });
  assert.match(list.entries[0].id, /^e[0-9a-f]{8}$/);
  const updated = await store.updateItem('u', 'ls_1', { entries: [
    { id: 'e00000001', text: '古い', checked: true, checkedAt: '2026-11-09T00:00:00Z' },
    { id: 'e00000002', text: '今日', checked: true, checkedAt: NOW.toISOString() },
  ] });
  assert.deepEqual(updated.entries.map((e) => e.text), ['今日']);
});

// ─────────────────────────────────────────────
// 朝のまとめ（機能4）
// ─────────────────────────────────────────────

const brief = require('../lib/planner/morning-brief');

test('brief: today upcoming events only, in time order', () => {
  const items = [
    { itemId: 'ev_1', kind: 'event', title: 'バイト', date: '2026-11-11', time: '15:00' },
    { itemId: 'ev_2', kind: 'event', title: '朝ゼミ', date: '2026-11-11', time: '09:00' }, // もう過ぎた（11:30）
    { itemId: 'ev_3', kind: 'event', title: 'ゴミ出し', date: '2026-11-11', time: '' },
    { itemId: 'ev_4', kind: 'event', title: '面接', date: '2026-11-12', time: '10:00' },
    { itemId: 'mm_1', kind: 'memo', text: 'x' },
  ];
  assert.deepEqual(brief.todaysUpcomingEvents(items, NOW).map((e) => e.title), ['ゴミ出し', 'バイト']);
});

test('brief: weather is mentioned only when it matters', () => {
  const at = (h) => Math.floor(Date.parse(`2026-11-11T${String(h).padStart(2, '0')}:00:00+09:00`) / 1000);
  const today = brief.summarizeForecast([
    { dt: at(12), main: { temp: 14, temp_max: 15, temp_min: 13 }, weather: [{ main: 'Clouds' }] },
    { dt: at(18), main: { temp: 10, temp_max: 11, temp_min: 9 }, weather: [{ main: 'Rain' }] },
    { dt: at(24 + 3), main: { temp: 2, temp_max: 2, temp_min: 2 }, weather: [{ main: 'Snow' }] }, // 明日の分
  ], NOW);
  assert.deepEqual(today, { date: '2026-11-11', max: 15, min: 9, rain: true, snow: false });
  assert.deepEqual(brief.weatherReasons(today).map((r) => r.id), ['rain']);
  const mild = { max: 18, min: 10, rain: false, snow: false };
  assert.deepEqual(brief.weatherReasons(mild, { max: 17 }), []);
  assert.deepEqual(brief.weatherReasons(mild, { max: 24 }).map((r) => r.id), ['colder']);
  assert.deepEqual(brief.weatherReasons({ max: 31, min: 4, rain: false, snow: false }).map((r) => r.id), ['hot', 'cold']);
});

test('brief: instruction speaks two events and counts the rest', () => {
  const events = ['A', 'B', 'C', 'D'].map((t, i) => ({ title: t, time: `1${i}:00` }));
  const text = brief.buildBriefInstruction({ events, weather: [{ id: 'rain', text: '今日は雨の予報。傘の一言を添える' }] });
  assert.match(text, /10:00 A/);
  assert.match(text, /11:00 B/);
  assert.doesNotMatch(text, /C/);
  assert.match(text, /ほかに2つあるよ/);
  assert.match(text, /傘/);
  assert.doesNotMatch(brief.buildBriefInstruction({ events: events.slice(0, 1) }), /天気/);
});

test('brief: weather reads yesterday and saves today; failures stay quiet', async () => {
  const saved = [];
  const store = {
    getItem: async (sub, id) => (id === 'wx_2026-11-10' ? { max: 22, min: 12 } : null),
    saveWeather: async (sub, w) => saved.push(w),
  };
  const at = Math.floor(Date.parse('2026-11-11T15:00:00+09:00') / 1000);
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ list: [{ dt: at, main: { temp: 15, temp_max: 15, temp_min: 11 }, weather: [{ main: 'Clear' }] }] }),
  });
  const reasons = await brief.briefWeather({
    sub: 'u', location: { lat: 35.7, lon: 139.3 }, now: NOW, store, getApiKey: async () => 'k', fetchImpl,
  });
  assert.deepEqual(reasons.map((r) => r.id), ['colder']);
  assert.equal(saved[0].date, '2026-11-11');
  assert.equal(saved[0].max, 15);
  assert.deepEqual(await brief.briefWeather({ sub: 'u', location: null, now: NOW, store, getApiKey: async () => 'k', fetchImpl }), []);
  const broken = async () => ({ ok: false, status: 500 });
  assert.deepEqual(await brief.briefWeather({
    sub: 'u', location: { lat: 1, lon: 1 }, now: NOW, store, getApiKey: async () => 'k', fetchImpl: broken,
  }), []);
});

test('flow: a brief greeting with plans today uses the brief and sends the card; without plans it is a normal greeting', async () => {
  const store = createFakeStore([
    { itemId: 'ev_000001aa-0000', kind: 'event', title: 'バイト', date: '2026-11-11', time: '15:00' },
  ]);
  const svc = buildService({
    text: '', store, mantleResponses: [replyText('おはよ。今日は15時からバイトだね')],
    request: { greeting: true, brief: true },
  });
  const result = await svc.run();
  assert.equal(result.ok, true);
  const prompt = JSON.stringify(svc.mainCalls[0].mantleInput || svc.mainCalls[0]);
  assert.match(prompt, /その日はじめての話しかけ/);
  assert.match(prompt, /15:00 バイト/);
  assert.deepEqual(svc.actions.map((a) => a.action), ['planner.show']);
  assert.equal(svc.actions[0].params.brief, true);

  const empty = buildService({
    text: '', store: createFakeStore(), mantleResponses: [replyText('やっほー')],
    request: { greeting: true, brief: true },
  });
  await empty.run();
  assert.doesNotMatch(JSON.stringify(empty.mainCalls[0].mantleInput || empty.mainCalls[0]), /その日はじめて/);
  assert.equal(empty.actions.length, 0);
});

// スマホで聞いたあと Windows を開くと、もう1回まとめていた（2026-11-13）
test('flow: the brief is given once a day across devices', async () => {
  const store = createFakeStore([
    { itemId: 'ev_000001aa-0000', kind: 'event', title: 'バイト', date: '2026-11-11', time: '15:00' },
  ]);
  const claimed = new Set();
  store.claimBrief = async (sub, date) => {
    if (claimed.has(date)) return false;
    claimed.add(date);
    return true;
  };
  const first = buildService({
    text: '', store, mantleResponses: [replyText('今日は15時からバイトだね')],
    request: { greeting: true, brief: true },
  });
  await first.run();
  assert.match(JSON.stringify(first.mainCalls[0].mantleInput || first.mainCalls[0]), /その日はじめての話しかけ/);
  assert.deepEqual([...claimed], ['2026-11-11']);

  // 2台目：普段の話しかけ（カードも出さない）
  const second = buildService({
    text: '', store, mantleResponses: [replyText('おかえり')],
    request: { greeting: true, brief: true },
  });
  await second.run();
  assert.doesNotMatch(JSON.stringify(second.mainCalls[0].mantleInput || second.mainCalls[0]), /その日はじめて/);
  assert.equal(second.actions.length, 0);

  // 印を確かめられなかったら、まとめる
  store.claimBrief = async () => { throw new Error('ddb down'); };
  const failed = buildService({
    text: '', store, mantleResponses: [replyText('今日は15時からバイトだね')],
    request: { greeting: true, brief: true },
  });
  await failed.run();
  assert.match(JSON.stringify(failed.mainCalls[0].mantleInput || failed.mainCalls[0]), /その日はじめての話しかけ/);
});

test('store: claimBrief writes the mark only once', async () => {
  const { createPlannerStore } = require('../lib/planner/planner-store');
  const sent = [];
  let exists = false;
  const docClient = {
    async send(command) {
      sent.push(command.input);
      if (exists) {
        const error = new Error('exists');
        error.name = 'ConditionalCheckFailedException';
        throw error;
      }
      exists = true;
      return {};
    },
  };
  const store = createPlannerStore({ docClient, now: () => NOW });
  assert.equal(await store.claimBrief('u1', '2026-11-11'), true);
  assert.equal(await store.claimBrief('u1', '2026-11-11'), false);
  assert.equal(sent[0].Item.itemId, 'bf_2026-11-11');
  assert.equal(sent[0].Item.kind, 'brief');
  assert.equal(sent[0].ConditionExpression, 'attribute_not_exists(itemId)');
  assert.equal(sent[0].Item.expiresAt, Date.UTC(2026, 10, 13) / 1000);
});

test('store: addFollowUp keeps the importance the candidate was given', async () => {
  const { createPlannerStore } = require('../lib/planner/planner-store');
  const sent = [];
  const docClient = { async send(command) { sent.push(command.input); return {}; } };
  const store = createPlannerStore({ docClient, now: () => NOW });
  const important = await store.addFollowUp('u1', { title: '面接', date: '2026-11-12', time: '', importance: 'important' });
  assert.equal(important.importance, 'important');
  await store.addFollowUp('u1', { title: 'x', date: '2026-11-12', importance: 'bogus' });
  assert.equal(sent[1].Item.importance, 'normal');
  await store.addFollowUp('u1', { title: 'y', date: '2026-11-12' });
  assert.equal(sent[2].Item.importance, 'normal');
});

// ─────────────────────────────────────────────
// 言ってたことを後で聞く（follow-up.js）
// ─────────────────────────────────────────────

const followUps = require('../lib/planner/follow-up');

/** 3回に1回の判定で「聞く」「聞かない」になる itemId を探す */
function idThat(asks, prefix = 'ev_') {
  for (let i = 0; i < 1000; i += 1) {
    const id = `${prefix}${String(i).padStart(6, '0')}-dice`;
    if (followUps.rollsToAsk(id) === asks) return id;
  }
  throw new Error('no id');
}

test('follow-up: asks only after it is over (timed 2h after start, date-only the next day)', () => {
  // NOW = 11/11 11:30 JST
  assert.equal(followUps.isOver({ date: '2026-11-11', time: '09:30' }, NOW), true);
  assert.equal(followUps.isOver({ date: '2026-11-11', time: '09:31' }, NOW), false);
  assert.equal(followUps.isOver({ date: '2026-11-11', time: '' }, NOW), false);
  assert.equal(followUps.isOver({ date: '2026-11-10', time: '' }, NOW), true);
  assert.equal(followUps.isOver({ date: '2026-11-12', time: '' }, NOW), false);
});

test('follow-up: importance decides (important always, normal about 1 in 3, chore never)', () => {
  const askId = idThat(true);
  const skipId = idThat(false);
  const base = { kind: 'event', title: '面接', date: '2026-11-10', time: '' };
  const due = (items) => followUps.dueFollowUps(items, NOW).map((i) => i.itemId);
  assert.deepEqual(due([{ ...base, itemId: skipId, importance: 'important' }]), [skipId]);
  assert.deepEqual(due([{ ...base, itemId: askId, importance: 'normal' }]), [askId]);
  assert.deepEqual(due([{ ...base, itemId: skipId, importance: 'normal' }]), []);
  assert.deepEqual(due([{ ...base, itemId: askId, importance: 'chore' }]), []);
  // 一度聞いたら聞かない
  assert.deepEqual(due([{ ...base, itemId: askId, importance: 'important', askedAt: NOW.toISOString() }]), []);
  // ふつうは3日目まで、大事なものは7日目まで
  assert.deepEqual(due([{ ...base, date: '2026-11-07', itemId: askId, importance: 'normal' }]), []);
  assert.deepEqual(due([{ ...base, date: '2026-11-07', itemId: askId, importance: 'important' }]), [askId]);
  // 大事なものを先に、同じなら古いものから
  const order = due([
    { ...base, itemId: askId, importance: 'normal', date: '2026-11-09' },
    { ...base, itemId: 'ev_b', importance: 'important', date: '2026-11-10' },
    { ...base, itemId: 'ev_a', importance: 'important', date: '2026-11-09' },
  ]);
  assert.deepEqual(order, ['ev_a', 'ev_b', askId]);
});

test('follow-up: an unpressed suggestion is asked unless the same thing became an event', () => {
  const fuId = idThat(true, 'fu_');
  const followUp = { itemId: fuId, kind: 'followup', title: 'テスト', date: '2026-11-10', time: '' };
  assert.deepEqual(followUps.dueFollowUps([followUp], NOW).map((i) => i.itemId), [fuId]);
  const event = { itemId: 'ev_x', kind: 'event', title: '数学のテスト', date: '2026-11-10', time: '', importance: 'important' };
  assert.deepEqual(followUps.dueFollowUps([followUp, event], NOW).map((i) => i.itemId), ['ev_x']);
});

// 押されなかった「予定に入れる？」も、大事なものは必ず聞く（2026-11-13）
test('follow-up: an unpressed suggestion follows its importance', () => {
  const skipId = idThat(false, 'fu_');
  const askId = idThat(true, 'fu_');
  const base = { kind: 'followup', title: '面接', date: '2026-11-07', time: '' };
  const due = (items) => followUps.dueFollowUps(items, NOW).map((i) => i.itemId);
  // 大事なものは3回に1回に外れても聞き、7日目まで待つ
  assert.deepEqual(due([{ ...base, itemId: skipId, importance: 'important' }]), [skipId]);
  assert.deepEqual(due([{ ...base, itemId: askId, importance: 'normal' }]), []);
  assert.deepEqual(due([{ ...base, date: '2026-11-10', itemId: askId, importance: 'normal' }]), [askId]);
  assert.deepEqual(due([{ ...base, date: '2026-11-10', itemId: askId, importance: 'chore' }]), []);
  // 天気やタイマーは聞かない
  assert.deepEqual(due([{ ...base, kind: 'timer', date: '2026-11-10', itemId: askId, importance: 'important' }]), []);
});

test('follow-up: session start is after a greeting or a 1h gap; one ask per session', () => {
  const at = (min) => new Date(NOW.getTime() - min * 60000).toISOString();
  assert.deepEqual(followUps.sessionState([], NOW), { turns: 0, asked: false });
  const messages = [
    { role: 'user', text: 'a', createdAt: at(200) },
    { role: 'assistant', text: 'b', createdAt: at(200) },
    { role: 'assistant', text: 'やっほー', createdAt: at(30), meta: { greeting: true } },
    { role: 'user', text: 'c', createdAt: at(20) },
    { role: 'assistant', text: 'd', createdAt: at(20) },
  ];
  assert.deepEqual(followUps.sessionState(messages, NOW), { turns: 1, asked: false });
  // 1時間あいたら新しい区切り
  assert.deepEqual(followUps.sessionState(messages.slice(0, 2), NOW), { turns: 0, asked: false });
  // その区切りでもう聞いていた
  const asked = [...messages, { role: 'assistant', text: 'そういえば', createdAt: at(10), meta: { followUp: { itemId: 'ev_1' } } }];
  assert.equal(followUps.sessionState(asked, NOW).asked, true);
});

test('follow-up: mentions and replies are matched by the words of the title', () => {
  const item = { title: 'A社の面接', date: '2026-11-10', time: '' };
  assert.equal(followUps.mentionsItem('面接だめだったかも', item), true);
  assert.equal(followUps.mentionsItem('ゲームしてた', item), false);
  assert.equal(followUps.replyAskedAbout('そういえば、昨日のあれどうだった？', item), true);
  assert.equal(followUps.replyAskedAbout('いいね、楽しそう', item), false);
  const messages = [
    { role: 'user', text: '明日面接なんだよね', createdAt: '2026-11-09T12:00:00Z' },
  ];
  // 予定の前に話していたのは数えない
  assert.equal(followUps.talkedAboutSince(item, messages), false);
  assert.equal(followUps.talkedAboutSince(item, [{ role: 'user', text: '面接おわった', createdAt: '2026-11-10T05:00:00Z' }]), true);
});

test('follow-up: instructions say when, what, and not to push', () => {
  const item = { kind: 'event', title: '面接', date: '2026-11-10', time: '10:00', importance: 'important' };
  const greeting = followUps.buildFollowUpGreetingInstruction({ item, now: NOW });
  assert.match(greeting, /昨日の10:00：面接（大事な予定）/);
  assert.match(greeting, /深追いせず/);
  const turn = followUps.buildFollowUpTurnInstruction({ item: { ...item, kind: 'followup', time: '' }, now: NOW });
  assert.match(turn, /昨日：面接（ユーザーが前に話していた(大事な)?こと/);
  assert.match(turn, /そういえば/);
  const brief = require('../lib/planner/morning-brief').buildBriefInstruction({
    events: [{ kind: 'event', title: 'バイト', date: '2026-11-11', time: '15:00' }],
    followUpLines: followUps.buildFollowUpBriefLines({ item, now: NOW }),
  });
  assert.match(brief, /今日の予定より先に/);
  assert.match(brief, /面接/);
});

const yesterdayInterview = (extra = {}) => ({
  itemId: 'ev_000001aa-0000', kind: 'event', title: '面接', date: '2026-11-10', time: '10:00', importance: 'important', ...extra,
});

test('flow: a greeting asks about a finished important event and marks it asked', async () => {
  const store = createFakeStore([yesterdayInterview()]);
  const svc = buildService({
    text: '', store, mantleResponses: [replyText('そういえば昨日の面接どうだった？')],
    request: { greeting: true },
  });
  await svc.run();
  const prompt = JSON.stringify(svc.mainCalls[0].mantleInput || svc.mainCalls[0]);
  assert.match(prompt, /そういえばの話しかけ/);
  assert.equal(store.items[0].askedAt, NOW.toISOString());
  assert.deepEqual(svc.appended[0].assistantMessage.meta.followUp, { itemId: 'ev_000001aa-0000', by: 'raim' });

  // もう聞いたので、次の話しかけは普段どおり
  const again = buildService({ text: '', store, mantleResponses: [replyText('やっほー')], request: { greeting: true } });
  await again.run();
  assert.doesNotMatch(JSON.stringify(again.mainCalls[0].mantleInput || again.mainCalls[0]), /そういえばの話しかけ/);
});

test('flow: a brief greeting folds the follow-up in', async () => {
  const store = createFakeStore([
    yesterdayInterview(),
    { itemId: 'ev_000002aa-0000', kind: 'event', title: 'バイト', date: '2026-11-11', time: '15:00' },
  ]);
  const svc = buildService({
    text: '', store, mantleResponses: [replyText('昨日の面接どうだった？今日は15時からバイトだね')],
    request: { greeting: true, brief: true },
  });
  await svc.run();
  const prompt = JSON.stringify(svc.mainCalls[0].mantleInput || svc.mainCalls[0]);
  assert.match(prompt, /その日はじめての話しかけ/);
  assert.match(prompt, /終わったことを1つだけ聞く/);
  assert.equal(store.items[0].askedAt, NOW.toISOString());
});

test('flow: a care greeting or reminder never asks', async () => {
  const store = createFakeStore([yesterdayInterview()]);
  const at = new Date(NOW.getTime() - 30 * 60000).toISOString();
  const svc = buildService({
    text: '', store, mantleResponses: [replyText('大丈夫？')],
    request: { greeting: true },
    thread: { messages: [{ role: 'user', text: 'もう消えたい', createdAt: at }] },
  });
  await svc.run();
  assert.doesNotMatch(JSON.stringify(svc.mainCalls[0].mantleInput || svc.mainCalls[0]), /そういえば/);
  assert.equal(store.items[0].askedAt, undefined);
});

test('flow: early in a conversation the reply may ask; it is marked only when it did', async () => {
  const store = createFakeStore([yesterdayInterview()]);
  const quiet = buildService({ text: 'ゲームしてた', store, mantleResponses: [replyText('いいね')] });
  await quiet.run();
  assert.match(JSON.stringify(quiet.mainCalls[0].mantleInput || quiet.mainCalls[0]), /そういえば（終わったことを聞く）/);
  assert.equal(store.items[0].askedAt, undefined);
  assert.equal(quiet.appended[0].assistantMessage.meta.followUp, undefined);

  const asks = buildService({ text: 'ゲームしてた', store, mantleResponses: [replyText('いいね。そういえば面接どうだった？')] });
  await asks.run();
  assert.equal(store.items[0].askedAt, NOW.toISOString());
  assert.deepEqual(asks.appended[0].assistantMessage.meta.followUp, { itemId: 'ev_000001aa-0000', by: 'raim' });
});

test('flow: when the user brings it up first, it is marked without adding the instruction', async () => {
  const store = createFakeStore([yesterdayInterview()]);
  const svc = buildService({ text: '面接たぶん受かった！', store, mantleResponses: [replyText('すごい！')] });
  await svc.run();
  assert.doesNotMatch(JSON.stringify(svc.mainCalls[0].mantleInput || svc.mainCalls[0]), /終わったことを聞く/);
  assert.equal(store.items[0].askedAt, NOW.toISOString());
  assert.deepEqual(svc.appended[0].assistantMessage.meta.followUp, { itemId: 'ev_000001aa-0000', by: 'user' });
});

test('flow: an old app without the planner feature never reads for follow-ups mid-chat', async () => {
  let listed = 0;
  const store = { ...createFakeStore([yesterdayInterview()]), listItems: async () => { listed += 1; return []; } };
  const svc = buildService({ text: 'ゲームしてた', features: [], store, mantleResponses: [replyText('いいね')] });
  await svc.run();
  assert.equal(listed, 0);
});

test('tool: add_schedule drops the matching unpressed suggestion', async () => {
  const store = createFakeStore([
    { itemId: 'fu_000009ee', kind: 'followup', title: 'テスト', date: '2026-11-12', time: '' },
  ]);
  const { change } = await runPlannerTool('add_schedule', { title: '数学のテスト', date: '2026-11-12' }, {
    sub: 'u1', store, items: [...store.items], now: NOW,
  });
  assert.deepEqual(change.params, { removedIds: ['fu_000009ee'] });
  assert.deepEqual(store.items.map((i) => i.kind), ['event']);
});
