#!/usr/bin/env node
'use strict';

// ==============================================================================
// 会話の自動テスト（アプリを起動せずに、ライムの口調を確かめる）
// ==============================================================================
//
// 本物の Core のコード（core-chat-service）に、台本の発言を順に流す。
//
//   本物のまま : プロンプト、場面選び（Titan）、会話例（DynamoDB を読むだけ）、
//                続きの会話（previous_response_id と要約版）、Mantle
//   差し替え   : 会話の保存先と記憶はメモリの中だけ（DynamoDB に書かない）
//                検索・天気は使わない（口調を見るテストなので）
//                要約・音声・アプリは使わない
//
// 口調の良し悪しは人が読む。ここでは決まったチェック（「あなた」「w」、長さ、
// 同じ言い回しの繰り返しなど）だけを自動で付ける。
//
// 使い方（CloudShell。詳しくは README.md）:
//   node run_convo.js --core ~/core
//   node run_convo.js --core before=~/core-old --core after=~/core   # 2つの zip を比べる
//   node run_convo.js --core ~/core --only ノリ --runs 2
//   node run_convo.js --core ~/core --fake                           # AWS を使わない動作確認
//
// 台本は scenarios.json（--scenarios で別のファイルも使える）。
// 会話文は台本の中のものだけ。本物のユーザーの会話は読まない・書かない。

const fs = require('node:fs');
const path = require('node:path');
const { checkReply, findRepeats, countWatchWords } = require('./checks');

// ─────────────────────────────────────────────
// 引数
// ─────────────────────────────────────────────

function parseArgs(argv) {
  const options = {
    cores: [],
    scenarios: path.join(__dirname, 'scenarios.json'),
    env: '',
    only: '',
    runs: 1,
    concurrency: 3,
    fake: false,
    out: '',
    persona: '',
    region: '',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];

    if (arg === '--core') {
      const value = next();
      const eq = value.indexOf('=');
      options.cores.push(eq > 0
        ? { label: value.slice(0, eq), dir: value.slice(eq + 1) }
        : { label: '', dir: value });
    } else if (arg === '--scenarios') options.scenarios = next();
    else if (arg === '--env') options.env = next();
    else if (arg === '--only') options.only = next();
    else if (arg === '--runs') options.runs = Math.max(1, Number(next()) || 1);
    else if (arg === '--concurrency') options.concurrency = Math.max(1, Number(next()) || 1);
    else if (arg === '--fake') options.fake = true;
    else if (arg === '--out') options.out = next();
    else if (arg === '--persona') options.persona = next();
    else if (arg === '--region') options.region = next();
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`知らない引数です: ${arg}`);
  }

  return options;
}

const HELP = `
node run_convo.js --core <Core の zip を展開したフォルダ> [オプション]

  --core <dir> または --core <名前>=<dir>   何回でも書ける（2つ書くと並べて比べる）
  --env <file>        Core Lambda の環境変数（JSON）。README の手順で作る
  --scenarios <file>  台本（既定: scenarios.json）
  --only <文字>       id かタグにこの文字を含む台本だけ流す
  --runs <n>          同じ台本を n 回流す（返事のぶれを見る）
  --concurrency <n>   同時に流す台本の数（既定 3）
  --persona <name>    人格（bright / downer / twitter）。既定は環境変数のまま
  --region <name>     AWS のリージョン（既定 ap-northeast-1）
  --out <file>        結果のファイル名（既定 convo-report-<日時>.txt と .json）
  --fake              Mantle と場面選びをニセにして、AWS を使わずに流れだけ確かめる
`.trim();

function expandHome(dir) {
  return dir.startsWith('~') ? path.join(process.env.HOME || '', dir.slice(1)) : dir;
}

// ─────────────────────────────────────────────
// 環境変数（Core を読み込む前に決める。人格などは読み込んだ時点で固定されるため）
// ─────────────────────────────────────────────

function applyEnvironment(options) {
  if (options.env) {
    const vars = JSON.parse(fs.readFileSync(expandHome(options.env), 'utf8')) || {};
    for (const [key, value] of Object.entries(vars)) {
      process.env[key] = String(value);
    }
  }

  // CloudShell の AWS_REGION は開いているコンソールのリージョンになるので、Core と同じにそろえる
  process.env.AWS_REGION = options.region || process.env.RAIM_TEST_REGION || 'ap-northeast-1';

  if (options.persona) {
    process.env.RAIM_PERSONA = options.persona;
  }

  // 検索・天気は使わない（下の isToolUseEnabled でも止めている）
  process.env.FACT_CHECK_SEARCH = 'false';
}

// ─────────────────────────────────────────────
// Core の読み込みと、部品の差し替え
// ─────────────────────────────────────────────

function loadCore(dir) {
  const root = path.resolve(expandHome(dir));
  const lib = (name) => require(path.join(root, 'lib', name));

  return {
    root,
    createCoreChatService: lib('core-chat-service.js').createCoreChatService,
    buildMessageRecord: lib('conversation-thread-store.js').buildMessageRecord,
    deriveTitle: lib('conversation-thread-store.js').deriveTitle,
    calculateResponseExpiresAt: lib('mantle-session-policy.js').calculateResponseExpiresAt,
    promptVersion: lib('prompts/raim-system-prompt.js').RAIM_SYSTEM_PROMPT_VERSION,
  };
}

const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

/**
 * 1つの会話ぶんの、メモリの中だけの保存先。
 * Core が DynamoDB に読み書きする部分をここに置き換える。
 */
function createMemoryStore(core, { sub, userMemory = '', planner = [], recentGreetings = [] }) {
  const session = {
    sub,
    activeThreadId: '',
    userMemory,
    // 前の会話でした話しかけ（新しい順）。台本の recentGreetings で入れられる
    recentGreetings: [...recentGreetings],
    userMemoryUpdatedAt: userMemory ? new Date().toISOString() : '',
  };
  let thread = null;
  const plannerItems = buildPlannerItems(planner);

  return {
    getThreadSnapshot: () => clone(thread),

    dependencies: {
      getOrCreateUserSession: async () => clone(session),
      updateRecentGreetings: async (_sub, list) => {
        session.recentGreetings = [...list];
      },
      updateMantleResponseState: async (_sub, { responseId, createdAt }) => {
        session.lastResponseId = responseId;
        session.lastResponseCreatedAt = createdAt;
      },
      clearMantleResponseState: async () => {
        delete session.lastResponseId;
        delete session.lastResponseCreatedAt;
        if (thread) {
          delete thread.lastResponseId;
          delete thread.lastResponseCreatedAt;
          delete thread.lastResponseExpiresAt;
        }
      },

      resolveThread: async ({ userText }) => {
        if (!thread) {
          thread = {
            sub,
            threadId: `convo-test-${sub}`,
            title: core.deriveTitle(userText || ''),
            messages: [],
            createdAt: new Date().toISOString(),
          };
          session.activeThreadId = thread.threadId;
          return { threadId: thread.threadId, thread: clone(thread), isNew: true };
        }
        return { threadId: thread.threadId, thread: clone(thread), isNew: false };
      },
      getThread: async () => clone(thread),
      ensureThreadTitle: async () => {},
      appendTurn: async ({ userMessage, assistantMessage, responseId, responseCreatedAt, memoryInjectedAt }) => {
        const now = new Date().toISOString();
        if (userMessage) {
          thread.messages.push(core.buildMessageRecord({ ...userMessage, role: 'user', createdAt: now }));
        }
        thread.messages.push(core.buildMessageRecord({ ...assistantMessage, role: 'assistant', createdAt: now }));
        if (responseId) {
          thread.lastResponseId = responseId;
          thread.lastResponseCreatedAt = responseCreatedAt;
          thread.lastResponseExpiresAt = core.calculateResponseExpiresAt(responseCreatedAt);
        }
        if (memoryInjectedAt) {
          thread.memoryInjectedAt = String(memoryInjectedAt);
        }
        return clone(thread);
      },

      // 要約は頼まない（Summary Lambda も DynamoDB も触らない）
      shouldSummarize: () => ({ shouldSummarize: false, reason: null }),
      dispatchSummarization: async () => true,

      // 予定の手帳もメモリの中だけ（台本の planner。あとで聞く・朝のまとめを見る）
      plannerStore: createMemoryPlanner(plannerItems),
      briefWeather: async () => [],

      // 口調を見るテストなので、検索・天気は使わない
      isToolUseEnabled: async () => false,
      resolveImages: async () => [],
      onToolCallStart: async () => {},
      onClientAction: async () => {},
    },
  };
}

/** 日本時間の今日（YYYY-MM-DD）から days 日ずらした日付 */
function jstDate(days = 0) {
  const shifted = new Date(Date.now() + 9 * 3600000 + days * 86400000);
  return shifted.toISOString().slice(0, 10);
}

/** 日本時間で今から hours 時間後の日付と時刻 */
function jstDateTime(hours) {
  const shifted = new Date(Date.now() + 9 * 3600000 + hours * 3600000);
  return { date: shifted.toISOString().slice(0, 10), time: shifted.toISOString().slice(11, 16) };
}

const ID_PREFIX = Object.freeze({ event: 'ev', followup: 'fu', timer: 'tm' });

const REMINDER_LABELS = Object.freeze({ timer: 'タイマーが鳴った', eve: '前の日の夜', before: '1時間前', morning: '当日の朝' });
// 知らせの話しかけで出てほしくない言葉（ふつうの話しかけと取り違えたとき・仕組みの言葉）
const REMINDER_EXPECT = Object.freeze({ notContains: ['どうしたの', '何かあった', '通知', 'アプリ', '登録'] });

/**
 * 台本の planner（{ title, daysAgo?, hoursFromNow?, time?, importance?, kind?, seconds? }）を、手帳の項目にする。
 * daysAgo: 1 は昨日（-1 は明日）、hoursFromNow: 3 は今から3時間後（今日のうちの予定に使う）
 * kind: "timer" はいま鳴ったタイマー（seconds はタイマーの長さ。既定 180）
 */
function buildPlannerItems(planner = []) {
  return (Array.isArray(planner) ? planner : []).map((raw, index) => {
    // 知らせの話しかけは itemId の形を確かめるので、本物と同じくらいの長さにする
    const itemId = `${ID_PREFIX[raw.kind] || 'ev'}_convo-item-${index}`;
    if (raw.kind === 'timer') {
      return {
        itemId,
        kind: 'timer',
        title: raw.title || 'タイマー',
        durationSec: Number(raw.seconds) || 180,
        endsAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
      };
    }
    const when = raw.hoursFromNow !== undefined
      ? jstDateTime(Number(raw.hoursFromNow))
      : { date: jstDate(-Number(raw.daysAgo || 0)), time: raw.time || '' };
    return {
      itemId,
      kind: raw.kind || 'event',
      title: raw.title,
      date: when.date,
      time: when.time,
      note: raw.note || '',
      importance: raw.importance || 'normal',
      lines: {},
      createdAt: new Date().toISOString(),
    };
  });
}

function createMemoryPlanner(items) {
  return {
    listItems: async () => clone(items),
    getItem: async (_sub, itemId) => clone(items.find((i) => i.itemId === itemId) || null),
    updateItem: async (_sub, itemId, changes) => {
      const item = items.find((i) => i.itemId === itemId);
      if (!item) return null;
      Object.assign(item, changes);
      return clone(item);
    },
    addFollowUp: async (_sub, candidate) => {
      const item = { itemId: `fu_convo-${items.length}`, kind: 'followup', importance: 'normal', ...candidate };
      items.push(item);
      return clone(item);
    },
    deleteItem: async () => null,
    saveWeather: async () => {},
  };
}

// --fake: AWS を使わずに流れだけ確かめる
function createFakeDependencies() {
  let count = 0;
  return {
    listSceneCandidates: async () => [],
    selectScene: async () => ({ sceneId: 'default', reason: 'fake', score: 0 }),
    getSceneById: async (id) => ({ id, description: '', default_emotions: { happy: 0.5 }, few_shots: [] }),
    createMantleResponse: async ({ mantleInput }) => {
      count += 1;
      return {
        responseId: `fake-${count}`,
        createdAt: new Date().toISOString(),
        rawText: JSON.stringify({
          emotions: { happy: 0.6, curious: 0.4 },
          text: `ニセの返事${count}です`,
        }),
        usage: { input_tokens: 0 },
      };
    },
  };
}

// ─────────────────────────────────────────────
// 1つの台本を流す
// ─────────────────────────────────────────────

async function runScenario({ core, scenario, runIndex, fake }) {
  const sub = `convo-${scenario.id}-${runIndex}-${Math.random().toString(36).slice(2, 8)}`;
  const store = createMemoryStore(core, {
    sub,
    userMemory: scenario.memory || '',
    planner: scenario.planner || [],
    recentGreetings: scenario.recentGreetings || [],
  });
  // 手帳のある台本は、手帳を持つアプリとして送る（会話の途中で「そういえば」を聞くのはそのときだけ）
  const features = scenario.planner ? ['planner'] : [];
  const handle = core.createCoreChatService({
    ...store.dependencies,
    ...(fake ? createFakeDependencies() : {}),
  });

  const steps = [];
  if (scenario.greeting) {
    steps.push({ greeting: true, say: '（アプリを開いた）', expect: scenario.greetingExpect || {} });
  }
  const plannerItems = buildPlannerItems(scenario.planner || []);
  for (const turn of scenario.turns || []) {
    // 台本の途中の話しかけ（{ "greeting": true }）と、知らせの話しかけ（{ "reminder": { "item": 0, "slot": "timer" } }）
    if (turn.reminder) {
      const item = plannerItems[Number(turn.reminder.item) || 0];
      const slot = String(turn.reminder.slot || 'timer');
      steps.push({
        greeting: true,
        reminder: item ? { itemId: item.itemId, slot } : null,
        say: `（${REMINDER_LABELS[slot] || '知らせ'}: ${item?.title || '?'}）`,
        expect: { ...REMINDER_EXPECT, ...(turn.expect || {}) },
      });
    } else if (turn.greeting) {
      steps.push({ greeting: true, say: '（アプリを開いた）', expect: turn.expect || {} });
    } else {
      steps.push({ greeting: false, say: turn.say, expect: turn.expect || {} });
    }
  }

  const results = [];
  for (const [index, step] of steps.entries()) {
    let sceneId = '';
    const started = Date.now();
    let reply = '';
    let error = '';
    // Mantle の返事が遅いときのひとこと（waiting-lines.js。古い Core では来ない）
    const waiting = [];

    try {
      const response = await handle(
        step.greeting
          ? {
            sub,
            requestId: `${sub}-${index}`,
            greeting: true,
            brief: scenario.brief === true,
            features,
            ...(step.reminder ? { reminder: step.reminder } : {}),
          }
          : { sub, requestId: `${sub}-${index}`, text: step.say, features },
        {
          onSceneSelected: async (scene) => { sceneId = scene?.id || ''; },
          onWaitingLine: async (text) => { waiting.push(text); },
        }
      );
      if (response?.type === 'error') {
        error = `${response.code || 'error'}: ${response.message || ''}`;
      } else {
        reply = String(response?.text || '');
      }
    } catch (caught) {
      error = caught?.message || String(caught);
    }

    const snapshot = store.getThreadSnapshot();
    const lastAssistant = (snapshot?.messages || []).filter((m) => m.role === 'assistant').pop();
    const flags = error
      ? [`エラー: ${error}`]
      : checkReply(reply, { ...(scenario.expect || {}), ...step.expect });

    results.push({
      say: step.say,
      greeting: step.greeting,
      reminder: Boolean(step.reminder),
      reply,
      error,
      waiting,
      sceneId,
      mode: lastAssistant?.meta?.mode || '',
      ms: Date.now() - started,
      flags,
    });

    // 1往復目で失敗したら、続きは流しても意味がないので止める
    if (error && index === 0) break;
  }

  // 会話全体: 同じ言い回しを何度も使っていないか
  const repeats = findRepeats(
    results.filter((r) => !r.error).map((r) => r.reply),
    { ignore: steps.map((s) => s.say) }
  );

  return { id: scenario.id, tag: scenario.tag || '', note: scenario.note || '', run: runIndex, results, repeats };
}

// ─────────────────────────────────────────────
// 結果の書き出し
// ─────────────────────────────────────────────

// 挨拶の言葉（出だしがこれで始まれば「挨拶から」と数える）
const GREETING_WORDS = Object.freeze([
  'やっほ', 'ヤッホ', 'おかえり', 'おはよ', 'こんにちは', 'こんばんは', 'ただいま', 'やあ', 'よっ', 'おーい',
  'ハロー', 'はろー', 'もしもし', 'おつかれ', 'お疲れ', 'ひさしぶり', '久しぶり', 'おひさ', 'ばあ', 'じゃーん',
]);

/** 話しかけの出だし（最初の区切りまで。core の greeting.js の lastGreetingOpening と同じ切り方） */
function greetingOpening(reply) {
  const word = String(reply || '').trim().split(/[。、！!？?,.\s]/)[0].trim().slice(0, 12) || '（空）';
  return { word, greeting: GREETING_WORDS.some((g) => word.startsWith(g)) };
}

function rankWords(words, limit = 8) {
  const counts = new Map();
  for (const word of words) counts.set(word, (counts.get(word) || 0) + 1);
  return [...counts.entries()]
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function countFlags(conversation) {
  return conversation.results.reduce((sum, r) => sum + r.flags.length, 0) +
    (conversation.repeats.length ? 1 : 0);
}

function formatReport({ cores, scenarios, byCore, startedAt, options }) {
  const lines = [];
  const labels = cores.map((c) => c.label);
  lines.push(`会話テスト ${startedAt}`);
  lines.push(`人格: ${process.env.RAIM_PERSONA || 'bright'}  台本: ${scenarios.length}本 × ${options.runs}回${options.fake ? '  （--fake: ニセの返事）' : ''}`);
  for (const core of cores) {
    lines.push(`Core${core.label ? ` [${core.label}]` : ''}: ${core.root}  (${core.promptVersion})`);
  }
  lines.push('');

  // 引っかかった所だけの表
  lines.push('===== 引っかかった所 =====');
  let flagged = 0;
  for (const scenario of scenarios) {
    for (const core of cores) {
      for (const conversation of byCore[core.label].filter((c) => c.id === scenario.id)) {
        const tag = `${core.label ? `[${core.label}] ` : ''}${scenario.id}${options.runs > 1 ? ` #${conversation.run}` : ''}`;
        conversation.results.forEach((r, i) => {
          for (const flag of r.flags) {
            lines.push(`- ${tag} ${i + 1}往復目: ${flag}`);
            flagged += 1;
          }
        });
        for (const repeat of conversation.repeats) {
          lines.push(`- ${tag}: 同じ言い回し「${repeat}」`);
          flagged += 1;
        }
      }
    }
  }
  if (!flagged) lines.push('（なし）');
  lines.push('');

  // 全部の返事
  lines.push('===== 全部の返事 =====');
  for (const scenario of scenarios) {
    lines.push('');
    lines.push(`■ ${scenario.id}${scenario.tag ? `（${scenario.tag}）` : ''}${scenario.note ? `  … ${scenario.note}` : ''}`);
    if (scenario.memory) lines.push(`  記憶: ${scenario.memory.split('\n').filter(Boolean).join(' ')}`);

    for (let run = 1; run <= options.runs; run++) {
      if (options.runs > 1) lines.push(`  --- ${run}回目`);
      const conversations = cores.map((core) =>
        byCore[core.label].find((c) => c.id === scenario.id && c.run === run));
      const turnCount = Math.max(...conversations.map((c) => c?.results.length || 0));

      for (let i = 0; i < turnCount; i++) {
        const say = conversations.find((c) => c?.results[i])?.results[i].say || '';
        lines.push(`  ユーザー「${say}」`);
        conversations.forEach((conversation, index) => {
          const r = conversation?.results[i];
          if (!r) return;
          const label = labels[index] ? `[${labels[index]}] ` : '';
          const waitingText = r.waiting?.length ? r.waiting.map((w) => `（待ってね:「${w}」）`).join('') : '';
          const body = `${waitingText}${r.error ? `（エラー: ${r.error}）` : r.reply}`;
          const meta = `${r.sceneId || '-'}/${r.mode || '-'} ${(r.ms / 1000).toFixed(1)}s`;
          lines.push(`    ${label}ライム: ${body}   [${meta}]${r.flags.length ? `  ⚠ ${r.flags.join(' / ')}` : ''}`);
        });
      }
      conversations.forEach((conversation, index) => {
        if (conversation?.repeats.length) {
          lines.push(`    ${labels[index] ? `[${labels[index]}] ` : ''}⚠ 同じ言い回し: ${conversation.repeats.map((r) => `「${r}」`).join(' ')}`);
        }
      });
    }
  }

  lines.push('');
  lines.push('===== まとめ =====');
  for (const core of cores) {
    const conversations = byCore[core.label];
    const turns = conversations.reduce((s, c) => s + c.results.length, 0);
    const errors = conversations.reduce((s, c) => s + c.results.filter((r) => r.error).length, 0);
    const replies = conversations.flatMap((c) => c.results.filter((r) => !r.error).map((r) => r.reply.length)).sort((a, b) => a - b);
    const median = replies.length ? replies[Math.floor(replies.length / 2)] : 0;
    const flaggedConversations = conversations.filter((c) => countFlags(c) > 0).length;
    const waitingCount = conversations.reduce((s, c) => s + c.results.filter((r) => r.waiting?.length).length, 0);
    lines.push(`${core.label ? `[${core.label}] ` : ''}往復 ${turns}、エラー ${errors}、待ってねを言った往復 ${waitingCount}、返事の長さの中央値 ${median}文字、引っかかった会話 ${flaggedConversations}/${conversations.length}`);

    // 会話をまたいで同じ言葉ばかり使っていないか（1つの会話の中だけでは見えない）
    const allReplies = conversations.flatMap((c) => c.results.filter((r) => !r.error).map((r) => r.reply));
    const frequent = countWatchWords(allReplies);
    lines.push(`  よく出た言葉（返事${allReplies.length}件中）: ${frequent.length ? frequent.map((f) => `${f.word} ${f.count}`).join('、') : 'なし'}`);

    // 話しかけの出だし（やっほーばかりになっていないか。知らせはいつも中身から始めるはず）
    for (const [label, reminder] of [['話しかけ', false], ['知らせ', true]]) {
      const openings = conversations.flatMap((c) => c.results
        .filter((r) => r.greeting && r.reminder === reminder && !r.error)
        .map((r) => greetingOpening(r.reply)));
      if (openings.length === 0) continue;
      const greeted = openings.filter((o) => o.greeting);
      const ranking = rankWords(openings.map((o) => o.word));
      lines.push(`  ${label}の出だし: 挨拶から ${greeted.length}/${openings.length}  （${ranking.map((r) => `${r.word} ${r.count}`).join('、')}）`);
    }
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────
// メイン
// ─────────────────────────────────────────────

async function runLimited(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || options.cores.length === 0) {
    console.log(HELP);
    process.exit(options.help ? 0 : 1);
  }

  applyEnvironment(options);

  const allScenarios = JSON.parse(fs.readFileSync(expandHome(options.scenarios), 'utf8'));
  const scenarios = allScenarios.filter((s) =>
    !options.only || s.id.includes(options.only) || String(s.tag || '').includes(options.only));
  if (!scenarios.length) {
    throw new Error(`台本が見つかりません（--only ${options.only}）`);
  }
  const ids = new Set();
  for (const s of scenarios) {
    if (ids.has(s.id)) throw new Error(`台本の id が重複しています: ${s.id}`);
    ids.add(s.id);
  }

  const cores = options.cores.map((c, i) => ({
    label: options.cores.length > 1 ? (c.label || `core${i + 1}`) : c.label,
    ...loadCore(c.dir),
  }));

  // Core のログ（[Greeting] など）は結果に混ぜない。会話文はもともとログに出ない
  const write = (text) => process.stderr.write(`${text}\n`);
  const quiet = () => {};
  console.log = quiet;
  console.info = quiet;
  console.warn = quiet;

  const startedAt = new Date().toISOString();
  const byCore = {};
  for (const core of cores) {
    const tasks = [];
    for (let run = 1; run <= options.runs; run++) {
      for (const scenario of scenarios) {
        tasks.push(async () => {
          const result = await runScenario({ core, scenario, runIndex: run, fake: options.fake });
          write(`${core.label ? `[${core.label}] ` : ''}${scenario.id}${options.runs > 1 ? ` #${run}` : ''}: ${result.results.length}往復${countFlags(result) ? ` ⚠${countFlags(result)}` : ''}`);
          return result;
        });
      }
    }
    byCore[core.label] = await runLimited(tasks, options.concurrency);
  }

  const report = formatReport({ cores, scenarios, byCore, startedAt, options });
  const stamp = startedAt.replace(/[-:]/g, '').replace(/\..*$/, '');
  const outText = options.out || `convo-report-${stamp}.txt`;
  const outJson = outText.replace(/\.txt$/, '') + '.json';
  fs.writeFileSync(outText, report + '\n');
  fs.writeFileSync(outJson, JSON.stringify({ startedAt, persona: process.env.RAIM_PERSONA || 'bright', cores: cores.map((c) => ({ label: c.label, root: c.root, promptVersion: c.promptVersion })), byCore }, null, 2));
  process.stdout.write(report + '\n');
  write(`\n結果: ${outText}（全部の返事）、${outJson}`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`失敗しました: ${error?.stack || error}\n`);
    process.exit(1);
  });
}

module.exports = { parseArgs, createMemoryStore, runScenario, formatReport, buildPlannerItems, greetingOpening };
