'use strict';

// 会話の要約と題名を、Summary の2つの版で比べる（今の版と試験版など）。
//
// 手で書いた試験用の会話（transcripts.json）を、本番と同じ流れで要約する。
//   - 10往復ごとと、最後に1回（10の倍数でなければ）要約する
//   - 毎回、それまでの会話全部と、前回の要約を渡す（本番の summarizeThread と同じ）
//   - 題名は、要約から付けた今の題名を次の要約に渡す（試験版だけが使う。今の版は無視する）
// どのテーブルにも書かない。Mantle を呼ぶだけ。
//
// 使い方（CloudShell）:
//   node ~/summary-compare/summary_compare.js --summary 今=~/summary-now --summary 試験=~/summary-test --env ~/summary-env.json
//   （任意）--only long_topic_change   1本だけ（, で複数）
//           --transcripts ほかの.json
//           --out summary-report.txt

const fs = require('node:fs');
const path = require('node:path');

const SUMMARIZE_EVERY_TURNS = 10;

const expandHome = (p) => (p.startsWith('~') ? path.join(process.env.HOME || '', p.slice(1)) : p);

function parseArgs(argv) {
  const options = {
    versions: [],
    env: '',
    transcripts: path.join(__dirname, 'transcripts.json'),
    only: [],
    out: 'summary-report.txt',
    fake: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--summary') {
      const value = String(argv[++i] || '');
      const at = value.indexOf('=');
      if (at <= 0) throw new Error('--summary は 名前=フォルダ の形にしてください（例: 今=~/summary-now）');
      options.versions.push({ name: value.slice(0, at), dir: path.resolve(expandHome(value.slice(at + 1))) });
    } else if (arg === '--env') options.env = argv[++i];
    else if (arg === '--transcripts') options.transcripts = argv[++i];
    else if (arg === '--only') options.only = String(argv[++i] || '').split(',').filter(Boolean);
    else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--fake') options.fake = true; // Mantle を呼ばない動作確認用
    else throw new Error(`知らない引数です: ${arg}`);
  }
  if (options.versions.length === 0) throw new Error('--summary を1つ以上指定してください');
  if (!options.env) throw new Error('--env を指定してください');
  return options;
}

function loadVersion({ name, dir }) {
  const service = require(path.join(dir, 'lib', 'summarize-service.js'));
  const store = require(path.join(dir, 'lib', 'conversation-thread-store.js'));
  return {
    name,
    generateSummary: service.generateSummary,
    toSummaryHistory: store.toSummaryHistory,
    // 試験版は LLM の題名を整える。今の版は【事実】の1行目
    titleOf: store.resolveThreadTitle
      ? (result) => store.resolveThreadTitle({ title: result.title, summary: result.summary })
      : (result) => store.deriveTitleFromSummary(result.summary),
    makesTitle: Boolean(store.resolveThreadTitle),
  };
}

function toMessages(turns) {
  const messages = [];
  for (const [user, assistant] of turns) {
    messages.push({ role: 'user', text: user });
    if (assistant) messages.push({ role: 'assistant', text: assistant });
  }
  return messages;
}

function checkpointsOf(turnCount) {
  const points = [];
  for (let n = SUMMARIZE_EVERY_TURNS; n <= turnCount; n += SUMMARIZE_EVERY_TURNS) points.push(n);
  if (points[points.length - 1] !== turnCount) points.push(turnCount);
  return points;
}

/** 本番と同じ順に、1本の会話を要約していく */
async function runTranscript(version, transcript, env, fake) {
  const steps = [];
  let previousSummary = '';
  let title = '';
  let titleFromSummary = false;

  for (const turn of checkpointsOf(transcript.turns.length)) {
    const history = version.toSummaryHistory(toMessages(transcript.turns.slice(0, turn)));
    const currentTitle = titleFromSummary ? title : '';
    const startedAt = Date.now();
    let result;
    try {
      result = await version.generateSummary(
        { history, previousSummary, forgotten: [], currentTitle },
        fake ? { env, createSummary: fakeSummary } : { env }
      );
    } catch (error) {
      steps.push({ turn, error: error.message, title, summary: previousSummary });
      continue;
    }
    const ms = Date.now() - startedAt;

    if (result.summary) previousSummary = result.summary;
    const next = result.summary ? version.titleOf(result) : '';
    if (next) {
      title = next;
      titleFromSummary = true;
    }
    steps.push({ turn, ms, rawTitle: result.title, title, summary: result.summary || '' });
  }
  return steps;
}

// --fake: 最後のユーザー発言を事実にするだけ
async function fakeSummary({ messages }) {
  const last = messages[messages.length - 1].content.split('\n').filter((l) => l.startsWith('ユーザー:')).pop() || '';
  const hasTitle = messages.some((m) => String(m.content).startsWith('【今の題名】'));
  return {
    text: JSON.stringify({ facts: ['挨拶をした', last.replace('ユーザー:', '').trim()], relationship: [], title: hasTitle ? '同じ題名' : '最初の題名' }),
    usage: null,
  };
}

// 目で見る前の、決まったチェック
function factsOf(summary) {
  const lines = String(summary || '').split('\n');
  const facts = [];
  let inFacts = false;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('【')) { inFacts = t.startsWith('【事実】'); continue; }
    if (inFacts && t.startsWith('-')) facts.push(t.replace(/^-\s*/, ''));
  }
  return facts;
}

const isGreeting = (fact) => /挨拶|あいさつ|おはよう|こんにちは|こんばんは|おやすみ|お礼を言|感謝を/.test(fact);
const isRequest = (fact) => /指示|依頼|頼ん|入れて|タイマー|メモ|リマインド|尋ねた|聞いた|教えて/.test(fact);

async function runLimited(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const vars = JSON.parse(fs.readFileSync(expandHome(options.env), 'utf8')) || {};
  for (const [key, value] of Object.entries(vars)) process.env[key] = String(value);
  if (!options.fake && !process.env.MANTLE_MODEL && !process.env.SUMMARY_MODEL) {
    throw new Error('env に MANTLE_MODEL も SUMMARY_MODEL もありません。Summary の設定を取ってください');
  }

  let transcripts = JSON.parse(fs.readFileSync(expandHome(options.transcripts), 'utf8'));
  if (options.only.length > 0) transcripts = transcripts.filter((t) => options.only.includes(t.id));
  if (transcripts.length === 0) throw new Error('会話がありません（--only の名前を確かめてください）');

  const versions = options.versions.map(loadVersion);
  const jobs = [];
  for (const transcript of transcripts) {
    for (const version of versions) jobs.push({ transcript, version });
  }

  let done = 0;
  const results = await runLimited(jobs, 3, async ({ transcript, version }) => {
    const steps = await runTranscript(version, transcript, process.env, options.fake);
    done += 1;
    process.stderr.write(`  ${done}/${jobs.length} ${transcript.id}（${version.name}）\n`);
    return { id: transcript.id, version: version.name, steps };
  });
  const stepsOf = (id, name) => results.find((r) => r.id === id && r.version === name).steps;

  const out = [];
  const write = (line = '') => out.push(line);

  // 題名の一覧（往復ごとに → でつなぐ）
  write('===== 題名の移り変わり（10往復ごと → 最後）=====');
  for (const transcript of transcripts) {
    write(`■ ${transcript.id}（${transcript.turns.length}往復）  期待: ${transcript.expect}`);
    for (const version of versions) {
      const titles = stepsOf(transcript.id, version.name).map((s) => (s.error ? '（失敗）' : s.title || '（なし）'));
      write(`  ${version.name}: ${titles.join(' → ')}`);
    }
  }
  write();

  // 数で見るもの
  write('===== 数（最後の要約の【事実】）=====');
  for (const version of versions) {
    let facts = 0;
    let greetings = 0;
    let requestFirst = 0;
    let titleChanges = 0;
    let failures = 0;
    for (const transcript of transcripts) {
      const steps = stepsOf(transcript.id, version.name);
      failures += steps.filter((s) => s.error).length;
      const last = steps[steps.length - 1];
      const list = factsOf(last?.summary);
      facts += list.length;
      greetings += list.filter(isGreeting).length;
      if (list.length > 0 && isRequest(list[0])) requestFirst += 1;
      for (let i = 1; i < steps.length; i++) {
        if (steps[i].title && steps[i - 1].title && steps[i].title !== steps[i - 1].title) titleChanges += 1;
      }
    }
    write(`  ${version.name}: 事実の行 ${facts}、うち挨拶・お礼 ${greetings}、1行目が頼みごとの会話 ${requestFirst}/${transcripts.length}、題名が途中で変わった回数 ${titleChanges}、失敗 ${failures}`);
  }
  write('  （挨拶・頼みごとの判定は言葉で拾っているだけなので、目でも確かめてください）');
  write();

  // 全部の要約
  write('===== 要約の全文 =====');
  for (const transcript of transcripts) {
    write(`■ ${transcript.id}: ${transcript.note}`);
    for (const version of versions) {
      for (const step of stepsOf(transcript.id, version.name)) {
        if (step.error) {
          write(`  [${version.name}] ${step.turn}往復目: 失敗 ${step.error}`);
          continue;
        }
        const raw = version.makesTitle ? `（LLM の題名「${step.rawTitle || ''}」）` : '';
        write(`  [${version.name}] ${step.turn}往復目  題名「${step.title}」${raw}  ${(step.ms / 1000).toFixed(1)}秒`);
        for (const line of String(step.summary).split('\n')) {
          if (line.trim()) write(`      ${line}`);
        }
      }
      write();
    }
  }

  const outPath = path.resolve(expandHome(options.out));
  fs.writeFileSync(outPath, `${out.join('\n')}\n`);
  const tableEnd = out.findIndex((line) => line.startsWith('===== 要約の全文'));
  console.log(out.slice(0, tableEnd).join('\n'));
  console.log(`全文: ${outPath}`);
}

main().catch((error) => {
  console.error(`止まりました: ${error.message}`);
  process.exitCode = 1;
});
