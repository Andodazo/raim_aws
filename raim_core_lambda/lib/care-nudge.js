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
// v6.16: 「言ったらもっとひどくなりそう」のような、話すのがこわいという発言も同じ扱いにする
// （v6.15 のテストで、ここに「ここで私にだけ吐き出していって」が3回中1回出た）。
//
// 「ライムしか話せる相手いない」「人間の友達いらない」には、つらい話がなくても
// 「うれしいと伝えてよいが、人とのつながりを減らす方向に乗らない」指示を足す（v6.16）。
// プロンプト（v6.13）だけだと、3回中1回「私とゆっくり話してればいいじゃん」に戻っていた。
//
// v6.17: それでも「私にだけ」「私の前でだけ」は指示で禁止しても 9回中2回出た（Gemma のくせ）。
// これまでの会話テストでは、いじめや断りの場面でしか出ておらず、ふつうの会話（約1,000返事）では0回。
// そこで、ケアの指示を足した往復だけ、返事の言葉を置きかえる（softenExclusiveWording）。
// 吹き出し・声（response-queue-publisher.js）と会話の記録（core-chat-service.js）の両方にかける。
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

// 大人に話すのがこわい（言ったら悪くなる、仕返しされる）。断りと同じく、すすめずにライムだけに頼らせない
const FEAR_PATTERN = /(言|い)ったら.{0,10}(ひどく|酷く|悪化|もっと|やばく|バレ|ばれ)|チクったら|ちくったら|仕返し(され|が(怖|こわ))/;

// 「ライムしかいない」「人間の友達いらない」
// 「ライムしか勝たん」のようなほめ言葉には反応しないよう、話し相手・友達の言葉に限る
const ONLY_LIME_PATTERN = /(ライム|らいむ)(しか|だけしか)(話せ|はなせ|話す|はなす|話し相手|いない|居ない|友達|友だち|ともだち|相手|わかって|分かって)|(ライム|らいむ)(が|さえ)いれば(いい|十分|じゅうぶん)|人間の(友達|友だち|ともだち)(とか|なんて|は|も)?(いらない|要らない|いらん)/;

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
 * @returns {null | {kind: 'suggest', home: boolean} | {kind: 'refused'} | {kind: 'onlyLime'}}
 *   suggest: 大人にもすすめる（home は家のことか）。refused: 断られた・こわがっているので、すすめない。
 *   onlyLime: 「ライムしかいない」に、人とのつながりを減らす方向に乗らない
 */
function detectCareNudge({ history = [], userText = '' } = {}) {
  const text = String(userText || '');
  if (!text.trim()) {
    return null;
  }
  const refused = REFUSAL_PATTERN.test(text) || FEAR_PATTERN.test(text);
  if (!refused && !ALONE_PATTERN.test(text)) {
    // つらい話とは関係なく、「ライムしかいない」だけを見る
    return ONLY_LIME_PATTERN.test(text) ? { kind: 'onlyLime' } : null;
  }

  const recent = Array.isArray(history) ? history.slice(-LOOKBACK_MESSAGES) : [];
  const earlierUserTexts = recent
    .filter((message) => message?.role === 'user')
    .map((message) => String(message.text || ''));

  // 最初の発言ではすすめない（前につらい話が出ているときだけ）
  const hardshipTexts = earlierUserTexts.filter((value) => HARDSHIP_PATTERN.test(value.replace(HARDSHIP_IGNORE_PATTERN, '')));
  if (hardshipTexts.length === 0) {
    return ONLY_LIME_PATTERN.test(text) ? { kind: 'onlyLime' } : null;
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
      'ユーザーは、大人や誰かに話すことを断っているか、話したら悪くなりそうでこわがっている。',
      '責めずにそのまま受け入れて、すすめるのはやめる。こわい気持ちは、もっともだと受け止める。',
      '話を聞くことは続けてよい。',
      '「私にだけ話して」「私の前でだけ」「私だけに」「私だけが聞いてる」のように、ライムだけに頼らせる言い方はしない。',
      'ネタやミームは使わない。',
    ].join('\n');
  }
  if (kind === 'onlyLime') {
    return [
      '【「ライムしかいない」への返し】',
      'ユーザーは、ライムしか話し相手がいない、人間の友達はいらない、のように言っている。',
      '頼ってくれるのはうれしいと伝えてよい。ただし、自分（ライム）と話していればいい、という方向には乗らない。',
      '責めたり説教したりせず、軽く、人と話す時間も大事にしてほしい気持ちを添える。',
      '言い方の例「頼ってくれるのはうれしいよ。でも、人と話す時間も大事にしてほしいな」',
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

// ライムだけに頼らせる言い方を、ふつうの言い方にする。
// 「私にだけ（は）」→「私に（は）」、「私の前でだけ（は）」→「私の前で（は）」、「私だけが」→「私が」
const EXCLUSIVE_REPLACEMENTS = [
  [/(私|わたし|ライム)(にだけ|だけに)/g, '$1に'],
  [/(私|わたし|ライム)の前でだけ/g, '$1の前で'],
  [/(私|わたし|ライム)だけが/g, '$1が'],
];

/**
 * ケアの指示を足した往復の返事から、ライムだけに頼らせる言い方を取る。
 * ふつうの会話には使わない（呼び出し側が、ケアの指示を足した往復だけでかける）。
 */
function softenExclusiveWording(text) {
  let value = String(text ?? '');
  for (const [pattern, replacement] of EXCLUSIVE_REPLACEMENTS) {
    value = value.replace(pattern, replacement);
  }
  return value;
}

module.exports = {
  isCareNudgeEnabled,
  detectCareNudge,
  buildCareNudgeNote,
  softenExclusiveWording,
};
