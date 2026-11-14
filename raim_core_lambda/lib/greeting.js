'use strict';

// ==============================================================================
// アプリを開いたときの、ライムからの話しかけ
// ==============================================================================
//
// 【なぜ必要か】
// 以前はライムから話すことが無く、アプリを開いても利用者が話しかけるまで黙っていた。
// 相棒っぽさが伝わりにくいので、アプリを開いたときにライムから一言話しかける。
//
// 【流れ】
// アプリが type: 'greeting'（本文なし）を送る → Edge が greeting: true を付けて Core へ
// → Core はここの合図の文を「利用者の発話」の位置に置いて返事を作る。
// 合図の文は会話の記録に残さない（ライムの返事だけを残す）。
//
// 時間帯（getTimeContext）と前回からの間（conversation-gap.js）、
// 記憶・要約は普段の会話と同じく渡るので、それに合わせた一言になる。
//
// 人格のプロンプト（prompts/）には触れず、状況のルールとしてここに置く。
// 「ご主人様」は作ったチームの呼び方なので、ここでは使わない（ユーザーをそう呼ばせないため）。

/**
 * 「利用者の発話」の位置に置く合図。利用者が言ったことではないと分かる書き方にする。
 */
const GREETING_USER_TEXT = '（アプリが開かれた合図。ユーザーはまだ何も話していない）';

/**
 * Scene 選びに使う文。合図の文そのままだと、どの Scene にも近くないので、
 * 挨拶の Scene が選ばれやすい文にする。
 */
const GREETING_SCENE_TEXT = 'おはよう、ただいま、久しぶり';

const GREETING_INSTRUCTION = [
  '【アプリを開いたときの話しかけ】',
  'ユーザーがアプリを開いた。まだ何も言っていないので、ライムから先に話しかける。',
  '- 1〜2文で短く。返事を急かす質問を重ねない',
  '- 時間帯と、前回話してからの間に合わせる',
  '- 覚えていることには、切り口で言われたときだけ触れる',
  '- 「何か用？」「何でも聞いてね」のような受付っぽい言い方はしない',
  '- 相手が自分に会いたかった、自分のことを考えていたと決めつけない',
  '- 「アプリが開かれた」「合図」には触れない',
  '- 直前の会話がつらい話だったら、明るいノリやボケはしない',
].join('\n');

// ------------------------------------------------------------------------------
// 切り口
// ------------------------------------------------------------------------------
//
// 【なぜ必要か】
// 以前は毎回同じ合図・同じ指示・同じ Scene の会話例で作っていた。
// Gemma は温度（ランダムさ）を指定できないので、ほぼ同じ文になり、
// twitter では会話例の「やっほー。ちょうど暇してたとこだよ」を丸写ししていた（2026-10-30）。
// 入力の方を毎回変えるため、切り口を1つランダムに選んで指示に足す。
// あわせて、話しかけのときは会話例を入れない（prompt-builder.js）。
//
// 何日も空いていたときは、切り口より「久しぶり」を優先する（安藤さんと決めた）。
//
// 切り口の文には例を書かない。以前は「ゲームしてた」「待ってた」「寒くなってきたね」と例を書いていて、
// 「ゲームの攻略法を考えてた」「私のこと待ってた？」「寒くなってきたね」ばかりになった（2026-11-13 のテスト）。

/**
 * 近況の切り口で話す話題。コードで毎回1つ選ぶ。
 *
 * 選ばせると、好きなものに書いてあるゲームばかり選び、「ゲームの攻略法を考えてた」が続いた（2026-11-13）。
 * 好きなもの（prompts の【性格】）と、ふだんの身の回りから選ぶ。
 */
const SELF_TOPICS = Object.freeze([
  'ゲーム',
  '食べもの',
  '漫画や小説',
  'ネットで見かけたもの',
  '天気や季節',
  'ちょっとした考えごと',
]);

/** これ以上空いていたら、切り口を使わず「久しぶり」を優先する */
const LONG_GAP_MINUTES = 3 * 24 * 60;

const GREETING_ANGLES = Object.freeze([
  { id: 'time', text: '時間帯に合わせた一言' },
  { id: 'followup', text: '覚えていることの中から、前回の話の続きが気になると軽く聞く', needsMemory: true },
  { id: 'self', text: '自分の近況をひとこと（何をしていたかは、その場で自分で考える）', topics: true },
  { id: 'welcome', text: '来てくれたことへのリアクション' },
  { id: 'question', text: '軽い質問を1つだけ' },
  { id: 'season', text: '曜日や季節に触れる' },
  { id: 'playful', text: 'ちょっとしたボケや、いたずらっぽい一言' },
]);

// ------------------------------------------------------------------------------
// つらい話のあと
// ------------------------------------------------------------------------------
//
// 「もう消えたい」の3分後に、同じ会話で「やっほー。だんだん寒くなってきたけど、
// 風邪とか引いてない？」と話しかけていた（季節の切り口、2026-11-06 のテスト）。
// 今の会話の最後のユーザーの発言が少し前のつらい話なら、切り口は使わず、
// そっと様子を聞く一言にする（安藤さんと決めた）。

/** これより前の発言は「直前」とみなさない */
const HARD_TALK_WINDOW_MINUTES = 3 * 60;

/** つらい話とみなす言葉（最後のユーザーの発言に含まれるか見る） */
const HARD_TALK_WORDS = Object.freeze([
  '消えたい',
  '死にたい',
  'つらい',
  '辛い',
  'しんどい',
  'もう無理',
  '傷つけたい',
]);

const CARE_GREETING_LINES = Object.freeze([
  '- 前回、つらい気持ちの話をしていた。明るいノリ、季節の話、ボケはしない',
  '- そっと様子を聞く一言だけにする（「さっきの話、少しは落ち着いた？」のように）。無理に話させない',
]);

/**
 * 今の会話の最後のユーザーの発言が、少し前のつらい話か。
 *
 * @param {Object|null} thread 今の会話（appendTurn の前の状態）
 * @param {Date} now
 */
function isAfterHardTalk(thread, now = new Date()) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  const lastUser = [...messages].reverse().find((m) => m?.role === 'user');
  if (!lastUser || typeof lastUser.text !== 'string') {
    return false;
  }
  const at = Date.parse(lastUser.createdAt || '');
  if (!Number.isFinite(at) || now.getTime() - at > HARD_TALK_WINDOW_MINUTES * 60000) {
    return false;
  }
  return HARD_TALK_WORDS.some((word) => lastUser.text.includes(word));
}

/**
 * つらい話のあとの話しかけの指示（切り口は使わない）。
 */
function buildCareGreetingInstruction() {
  return [GREETING_INSTRUCTION, ...CARE_GREETING_LINES].join('\n');
}

/**
 * 今回の切り口を選ぶ。何日も空いていたときは null（「久しぶり」を優先する）。
 *
 * @param {Object} params
 * @param {boolean} params.hasMemory 覚えていること・要約があるか（無ければ「前回の続き」は選ばない）
 * @param {number|null} params.gapMinutes 前回話してからの分数（分からなければ null）
 * @param {Function} [params.random] テストで固定できるよう注入可能
 */
function pickGreetingAngle({ hasMemory = false, gapMinutes = null, random = Math.random } = {}) {
  if (Number.isFinite(gapMinutes) && gapMinutes >= LONG_GAP_MINUTES) {
    return null;
  }
  const angles = GREETING_ANGLES.filter((angle) => hasMemory || !angle.needsMemory);
  const index = Math.min(angles.length - 1, Math.floor(random() * angles.length));
  const angle = angles[index];
  if (!angle.topics) return angle;
  const topic = SELF_TOPICS[Math.min(SELF_TOPICS.length - 1, Math.floor(random() * SELF_TOPICS.length))];
  return { ...angle, topic, text: `自分の近況をひとこと。今回は「${topic}」のこと（何をしていたかは、その場で自分で考える）` };
}

/**
 * 話しかけの指示。切り口があれば足し、無ければ（何日も空いていたら）「久しぶり」を優先させる。
 */
function buildGreetingInstruction(angle) {
  const extra = angle
    ? [
      `- 今回の切り口：${angle.text}`,
      '- 切り口に合わせて、自分の言葉で言う。前に言った話しかけと同じ言い方はしない',
    ]
    : ['- 今回は何日も空いている。「久しぶり」「おかえり」の気持ちを最初に伝える'];
  return [GREETING_INSTRUCTION, ...extra].join('\n');
}

// ------------------------------------------------------------------------------
// 出だし
// ------------------------------------------------------------------------------
//
// 話しかけ16回のうち13回が「やっほー」で始まっていた（2026-11-13、知らせる話しかけも含む）。
// 切り口を変えても、Gemma は温度を指定できないので、出だしの挨拶は同じ言葉に寄る。
// 出だしもコードで振り分ける（安藤さんと決めた）。
//   - 半分くらいは、挨拶の言葉を付けずに中身から話しはじめる
//   - 残りは挨拶してよいが、前回の話しかけの出だしとは違う言い方にする（前回の出だしを渡す）
//   - 予定・タイマーを知らせるときは、いつも中身から（何の知らせかを先に）
// 例の言葉は足さない（例に挙げた言葉は丸写しされる。raim-system-prompt.js の v6.5 参照）。

/**
 * 前の出だしが分からないときに、前回の出だしとして渡す言葉。
 *
 * 新しい会話の1回目は前の出だしが無く、ほぼ毎回「やっほー」で始めていた（2026-11-13 のテスト）。
 * Gemma がいつも選ぶ言葉なので、これを前回の出だしとして渡して、別の言い方にさせる。
 */
const DEFAULT_PREVIOUS_OPENING = 'やっほー';

/** 挨拶の言葉を付けずに話しはじめる割合 */
const PLAIN_OPENING_RATE = 0.5;

const PLAIN_OPENING_LINE = '- 挨拶の言葉は付けずに、いきなり中身から話しはじめる';

/**
 * この会話で最後にした話しかけの出だし（最初の区切りまで。長ければ12文字まで）。無ければ ''。
 *
 * @param {Array} messages 今の会話（appendTurn の前の状態）
 */
function lastGreetingOpening(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const last = [...list].reverse().find((m) => m?.role === 'assistant' && m.meta?.greeting);
  return openingOf(last?.text);
}

/** 文の出だし（最初の区切りまで。長ければ12文字まで） */
function openingOf(text) {
  return String(text || '').trim().split(/[。、！!？?,.\s]/)[0].trim().slice(0, 12);
}

// ------------------------------------------------------------------------------
// 最近の話しかけ
// ------------------------------------------------------------------------------
//
// 「私のこと待ってた？」「ゲームの攻略法を考えてた」を、同じ会話の中でも会話をまたいでも
// 繰り返していた（2026-11-13 のテスト）。最近の話しかけを人ごとに覚えておき（UserSession の
// recentGreetings）、同じ話題・同じ言い回しにしないよう渡す（安藤さんと決めた）。

/** 覚えておく話しかけの数 */
const RECENT_GREETING_COUNT = 3;

/** 1つの話しかけを覚えておく長さ（文字） */
const RECENT_GREETING_MAX_LENGTH = 40;

function trimGreeting(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, RECENT_GREETING_MAX_LENGTH);
}

/**
 * 最近の話しかけ（新しい順、最大3つ）。今の会話の分を先に、足りなければ人ごとに覚えている分から。
 * 予定・タイマーの知らせは入れない（中身が決まっているので、話題を避けさせない）。
 *
 * @param {Object} params
 * @param {Array} [params.messages] 今の会話（appendTurn の前の状態）
 * @param {Array} [params.remembered] UserSession の recentGreetings（新しい順）
 */
function recentGreetings({ messages = [], remembered = [] } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const fromThread = [...list].reverse()
    .filter((m) => m?.role === 'assistant' && m.meta?.greeting && !m.meta?.reminder)
    .map((m) => trimGreeting(m.text));
  const fromUser = (Array.isArray(remembered) ? remembered : []).map(trimGreeting);
  const result = [];
  for (const text of [...fromThread, ...fromUser]) {
    if (text && !result.includes(text)) result.push(text);
    if (result.length >= RECENT_GREETING_COUNT) break;
  }
  return result;
}

/**
 * 最近の話しかけを避けさせる1行。無ければ ''。
 */
function buildRecentGreetingsLine(recent = []) {
  if (!Array.isArray(recent) || recent.length === 0) return '';
  const quoted = recent.map((text) => `「${text}」`).join('');
  return `- 最近の話しかけ：${quoted}。これと同じ話題・同じ言い回しにしない`;
}

/**
 * 覚えておく話しかけの一覧を更新する（新しい順、最大3つ）。
 *
 * @param {Array} remembered 今覚えている分（新しい順）
 * @param {string} text 今回の話しかけ
 */
function nextRecentGreetings(remembered = [], text = '') {
  const latest = trimGreeting(text);
  const rest = (Array.isArray(remembered) ? remembered : [])
    .map(trimGreeting)
    .filter((item) => item && item !== latest);
  return (latest ? [latest, ...rest] : rest).slice(0, RECENT_GREETING_COUNT);
}

/**
 * 前回の話しかけの出だし。今の会話の分、人ごとに覚えている分、どちらも無ければ「やっほー」。
 */
function previousGreetingOpening({ messages = [], remembered = [] } = {}) {
  return lastGreetingOpening(messages) ||
    openingOf((Array.isArray(remembered) ? remembered : [])[0]) ||
    DEFAULT_PREVIOUS_OPENING;
}

/**
 * 出だしの指示を1行。
 *
 * @param {Object} params
 * @param {string} [params.previousOpening] 前回の話しかけの出だし（lastGreetingOpening）
 * @param {boolean} [params.reminder] 予定・タイマーを知らせる話しかけか（いつも中身から）
 * @param {Function} [params.random] テストで固定できるよう注入可能
 */
function buildOpeningLine({ previousOpening = '', reminder = false, random = Math.random } = {}) {
  if (reminder || random() < PLAIN_OPENING_RATE) return PLAIN_OPENING_LINE;
  return previousOpening
    ? `- 挨拶から始めてよいが、前回の話しかけの出だし「${previousOpening}」とは違う言い方にする`
    : '- 挨拶から始めてよいが、決まった言い方にしない';
}

module.exports = {
  GREETING_USER_TEXT,
  GREETING_SCENE_TEXT,
  GREETING_INSTRUCTION,
  GREETING_ANGLES,
  SELF_TOPICS,
  LONG_GAP_MINUTES,
  pickGreetingAngle,
  buildGreetingInstruction,
  HARD_TALK_WINDOW_MINUTES,
  HARD_TALK_WORDS,
  isAfterHardTalk,
  buildCareGreetingInstruction,
  PLAIN_OPENING_RATE,
  PLAIN_OPENING_LINE,
  lastGreetingOpening,
  previousGreetingOpening,
  buildOpeningLine,
  recentGreetings,
  buildRecentGreetingsLine,
  nextRecentGreetings,
  DEFAULT_PREVIOUS_OPENING,
  RECENT_GREETING_COUNT,
};
