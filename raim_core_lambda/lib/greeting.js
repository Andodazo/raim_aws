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

/** これ以上空いていたら、切り口を使わず「久しぶり」を優先する */
const LONG_GAP_MINUTES = 3 * 24 * 60;

const GREETING_ANGLES = Object.freeze([
  { id: 'time', text: '時間帯に合わせた一言（朝なら朝の、夜ならちょっと夜ふかしをいじる、など）' },
  { id: 'followup', text: '覚えていることの中から、前回の話の続きが気になると軽く聞く', needsMemory: true },
  { id: 'self', text: '自分の近況をひとこと（ゲームしてた、考えごとしてた、など）' },
  { id: 'welcome', text: '来てくれたことへのリアクション（待ってた、嬉しい、など）' },
  { id: 'question', text: '軽い質問を1つだけ（今日どうだった？など）' },
  { id: 'season', text: '曜日や季節に触れる（週末だね、寒くなってきたね、など）' },
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
  return angles[index];
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

module.exports = {
  GREETING_USER_TEXT,
  GREETING_SCENE_TEXT,
  GREETING_INSTRUCTION,
  GREETING_ANGLES,
  LONG_GAP_MINUTES,
  pickGreetingAngle,
  buildGreetingInstruction,
  HARD_TALK_WINDOW_MINUTES,
  HARD_TALK_WORDS,
  isAfterHardTalk,
  buildCareGreetingInstruction,
};
