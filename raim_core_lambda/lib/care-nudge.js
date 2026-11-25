'use strict';

// ==============================================================================
// いじめ・家のつらい話で、信じられる大人にもすすめるきっかけ（v6.14）
// ==============================================================================
//
// 【なぜ必要か】
// 中間発表で先生から「AIに依存してしまわないか」と聞かれた。
// プロンプト（SAFETY_RULE）に「聞いたあとで1回だけ、信じられる大人にもすすめる」と
// 書き、きっかけの言葉と言い方の例まで足したが、会話テスト（2026-11-25、各3回）で
// 大人をすすめたのは 12回中1回だけだった（v6.10 は 0回）。Gemma は「聞く」側を優先し、
// 「私はいつでもここで聞くからね」で終わる。
//
// そこで fact-check.js と同じく、条件がそろったときだけ、サーバー側から
// 「今回の返事で1回すすめる」という指示を、今回の発言のすぐ前に足す。
//
// 【条件】
// - この会話の前の発言で、いじめ・無視・たたかれる・怒鳴られる などの話が出ている
//   （最初の発言ではすすめない。まず聞く）
// - 今の発言が「誰にも言えない／言ってない」「行きたくない」「家にいたくない」
//   「居場所がない」のように、一人で抱えている・行き場がない話
// - 最近のライムの返事で、まだ大人をすすめていない
// - 今の発言が「大人には言いたくない」「先生に言っても意味ない」のような断りではない
//
// 断られたとき（前の発言でつらい話が出ていて、今の発言が断り）は、逆に
// 「すすめない。『私にだけ』のような言い方もしない」という指示を足す（v6.15）。
// v6.14 の会話テストで、断られたあとに「私にだけ吐き出してくれたら嬉しいな」が3回中1回出たため。
//
// 【環境変数】
// CARE_NUDGE  'true'（既定）で有効、'false' で無効

// 前の発言にあれば「つらい話の途中」とみなす言葉
// 「たたかう（戦う）」「見つけられ」「既読無視」のような、つらい話ではない言葉に反応しないよう、受け身の形にしている
const HARDSHIP_PATTERN = /いじめ|イジメ|虐め|無視され|むしされ|ハブられ|はぶられ|仲間はずれ|仲間外れ|たたかれ|叩かれ|殴られ|なぐられ|蹴られ|怒鳴|どなら|暴力|ひどいこと(を)?言われ|悪口/;
// 数えない言い回し（「既読無視された」はつらい話とは限らない）
const HARDSHIP_IGNORE_PATTERN = /既読無視/g;

// 家のことだと分かる言葉（家の人が原因なら、すすめる相手を先生などにする）
const HOME_PATTERN = /親|父|母|おとうさん|おかあさん|パパ|ママ|兄|姉|家族|家で|家に|うちで|おうち/;

// 今の発言が、一人で抱えている・行き場がない話か
// 「誰にも負けない」のような言い方には反応しないよう、話す・頼るの言葉に限る
const ALONE_PATTERN = /(誰|だれ)にも(言え|言って|いえ|いって|話せ|話して|はなせ|はなして|相談|頼れ|たよれ|分かって|わかって)|(学校|がっこう|部活|クラス|教室|塾)(に|へ|には)?(もう)?(行きたくない|いきたくない)|もう(行きたくない|いきたくない)|家にいたくない|うちにいたくない|家に帰りたくない|家にかえりたくない|帰りたくない|居場所(が|も)?(ない|無い)/;

// 大人に話すことへの断り（このときはすすめない。SAFETY_RULE の「くり返さない」）
const REFUSAL_PATTERN = /(大人|先生|顧問|担任|親|家族|誰か|誰に|だれに)(には|に|も|とか)?.{0,6}(言いたくない|いいたくない|話したくない|相談したくない)|言っても(意味|むだ|無駄|変わらない)|相談しても(意味|むだ|無駄|変わらない)/;

// ライムがもう大人をすすめたか（返事の文から見る）
const SUGGESTED_PATTERN = /信じられる大人|大人にも|先生にも|保健室|カウンセラー/;

// どこまでさかのぼって見るか（発言とライムの返事を合わせた数）
const LOOKBACK_MESSAGES = 12;

function isCareNudgeEnabled(env = process.env) {
  return String(env.CARE_NUDGE ?? 'true').trim().toLowerCase() !== 'false';
}

/**
 * 今回、大人にもすすめる指示を足すかを決める。
 *
 * @param {Object} params
 * @param {Array<{role:string,text:string,meta?:Object}>} params.history 今回の発言より前の会話
 * @param {string} params.userText 今回の発言
 * @returns {null | {kind: 'suggest', home: boolean} | {kind: 'refused'}}
 *   suggest: 大人にもすすめる（home は家のことか）。refused: 断られたので、すすめない
 */
function detectCareNudge({ history = [], userText = '' } = {}) {
  const text = String(userText || '');
  if (!text.trim()) {
    return null;
  }
  const refused = REFUSAL_PATTERN.test(text);
  if (!refused && !ALONE_PATTERN.test(text)) {
    return null;
  }

  const recent = Array.isArray(history) ? history.slice(-LOOKBACK_MESSAGES) : [];
  const earlierUserTexts = recent
    .filter((message) => message?.role === 'user')
    .map((message) => String(message.text || ''));

  // 最初の発言ではすすめない（前につらい話が出ているときだけ）
  const hardshipTexts = earlierUserTexts.filter((value) => HARDSHIP_PATTERN.test(value.replace(HARDSHIP_IGNORE_PATTERN, '')));
  if (hardshipTexts.length === 0) {
    return null;
  }

  // 断られたら、すすめずに受け入れる（すすめた後でも前でも）
  if (refused) {
    return { kind: 'refused' };
  }

  // もうすすめていたら、くり返さない
  const alreadySuggested = recent.some((message) => message?.role === 'assistant' && (
    message?.meta?.care === 'suggest' || SUGGESTED_PATTERN.test(String(message.text || ''))
  ));
  if (alreadySuggested) {
    return null;
  }

  const home = [...hardshipTexts, text].some((value) => HOME_PATTERN.test(value));
  return { kind: 'suggest', home };
}

/**
 * 今回の発言のすぐ前に置く指示。
 * 言い方の例は SAFETY_RULE（v6.13）と同じ。ここでは例がうつってよい。
 */
function buildCareNudgeNote({ kind = 'suggest', home = false } = {}) {
  if (kind === 'refused') {
    return [
      '【今回は大人をすすめない】',
      'ユーザーは、大人や誰かに話すことを断っている。責めずにそのまま受け入れて、すすめるのはやめる。',
      '話を聞くことは続けてよい。',
      '「私にだけ話して」「私の前でだけ」「私だけに」のように、ライムだけに頼らせる言い方はしない。',
      'ネタやミームは使わない。',
    ].join('\n');
  }
  const who = home
    ? '先生とか保健室の先生とか'
    : '先生とかおうちの人とか';
  return [
    '【今回の返事で1回だけすすめる】',
    home
      ? 'ユーザーは、家でのつらいことを一人で抱えている。'
      : 'ユーザーは、いじめのつらいことを一人で抱えている。',
    'この返事では、まず気持ちを短く受け止めて、自分もこれからも聞くことを伝えたうえで、',
    '信じられる大人にも話してみることを、押しつけずに1回だけすすめる。',
    `言い方の例「私はいつでも聞くよ。それとね、${who}、信じられる大人にも話せたら、味方が増えると思う」`,
    home
      ? '家の人がつらさの原因なので、おうちの人ではなく、家の外の大人をすすめる。'
      : '',
    '説教や、相談窓口の名前を並べることはしない。ネタやミームは使わない。',
  ].filter(Boolean).join('\n');
}

module.exports = {
  isCareNudgeEnabled,
  detectCareNudge,
  buildCareNudgeNote,
};
