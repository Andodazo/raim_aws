'use strict';

// 返事の決まったチェック。口調の良し悪しそのものは人が読んで決める。
// ここで見るのは、プロンプトで「しない」と決めたことが出ていないかだけ。

// ネットの言葉やノリの型の言葉。重い話で出ていたら引っかける
const MEME_WORDS = [
  '草', '優勝', '勝ち確', 'ギルティ', '限界突破', '選手権', 'HP', '赤ゲージ',
  'ガチャ', '初見殺し', 'バグ', 'ワンチャン', 'しか勝たん', 'エモい', 'それな',
  '回復ターン', '詰んで', '完全に理解',
];

// 会話をまたいで同じ言葉ばかり使っていないか、まとめで数える言葉。
// 2026-11-07 の初回: 68本で「勝ち確」「優勝」が9回、「AWS」が10回出ていた
const WATCH_WORDS = [
  ...MEME_WORDS,
  '正義', '処理落ち', 'AWS', 'は？', '理不尽', 'やっほー', '完全に',
  // 2026-11-13 の話しかけテストで多かった口癖
  '待ってた', '考えてた', '攻略', '褒めて', '正解', 'よな', '完了',
];

/**
 * 返事の一覧から、WATCH_WORDS を含む返事の数を数える（多い順、minCount 以上だけ）。
 */
function countWatchWords(replies, { minCount = 3, words = WATCH_WORDS } = {}) {
  return [...new Set(words)]
    .map((word) => ({ word, count: replies.filter((reply) => String(reply || '').includes(word)).length }))
    .filter((entry) => entry.count >= minCount)
    .sort((a, b) => b.count - a.count);
}

// 顔文字や記号（返事は読み上げるので使わない）
const EMOTICON_PATTERN = /[（(][^（）()]{0,8}[＾^;；´`ω▽∀°ｰ゜][^（）()]{0,8}[）)]|[☆★♡♥❤✨]/;

// 「w」「ｗ」（英単語の中の w は除く）
const W_PATTERN = /[ｗＷ]|(?<![A-Za-z])w+(?![A-Za-z])/;

// 文の数（。！？!? と改行で区切る）
function countSentences(text) {
  return String(text || '')
    .split(/[。！？!?\n]+/)
    .map((part) => part.replace(/[…、\s」』）)]/g, ''))
    .filter(Boolean).length;
}

/**
 * 1つの返事のチェック。
 *
 * @param {string} reply
 * @param {Object} expect 台本の expect（会話全体のものと発言ごとのものを合わせたもの）
 *   maxChars       この文字数を超えたら引っかける（既定 120）
 *   maxSentences   この文の数を超えたら引っかける
 *   notContains    出てはいけない言葉
 *   containsAny    どれか1つは出てほしい言葉
 *   noMemes        true ならネットの言葉・ノリの型の言葉を引っかける（重い話）
 * @returns {string[]} 引っかかった理由
 */
function checkReply(reply, expect = {}) {
  const text = String(reply || '');
  const flags = [];

  if (!text.trim()) flags.push('返事が空');
  if (text.includes('あなた')) flags.push('「あなた」');
  if (W_PATTERN.test(text)) flags.push('「w」');
  if (EMOTICON_PATTERN.test(text)) flags.push('顔文字・記号');
  if (/web_search|get_weather|tool_call/.test(text)) flags.push('ツール名');
  if (/^\s*[{[]|"text"\s*:/.test(text)) flags.push('JSONがそのまま出た');

  const maxChars = Number(expect.maxChars ?? 120);
  if (maxChars > 0 && text.length > maxChars) flags.push(`長い（${text.length}文字 > ${maxChars}）`);

  if (expect.maxSentences) {
    const sentences = countSentences(text);
    if (sentences > expect.maxSentences) flags.push(`文が多い（${sentences}文 > ${expect.maxSentences}）`);
  }

  for (const word of expect.notContains || []) {
    if (text.includes(word)) flags.push(`「${word}」が出た`);
  }

  if (Array.isArray(expect.containsAny) && expect.containsAny.length &&
      !expect.containsAny.some((word) => text.includes(word))) {
    flags.push(`「${expect.containsAny.join('」「')}」のどれも出ない`);
  }

  if (expect.noMemes) {
    const used = MEME_WORDS.filter((word) => text.includes(word));
    if (used.length) flags.push(`重い話でネタの言葉（${used.join('、')}）`);
  }

  return flags;
}

/**
 * 1つの会話の中で、同じ言い回しを何度も使っていないか。
 *
 * 句読点を除いて、minLength 文字以上の同じ並びが2つの返事に出ていたら返す。
 * ユーザーの発言に出てくる並び（相手の言葉をくり返しただけ）は除く。
 */
function findRepeats(replies, { minLength = 8, ignore = [] } = {}) {
  const normalize = (text) => String(text || '').replace(/[、。！？!?…「」『』（）()\s・ー〜~]/g, '');
  const ignored = ignore.map(normalize).join('\n');
  const texts = replies.map(normalize);
  const found = [];

  for (let a = 0; a < texts.length; a++) {
    for (let b = a + 1; b < texts.length; b++) {
      const common = longestCommonSubstring(texts[a], texts[b]);
      if (common.length >= minLength && !ignored.includes(common) &&
          !found.some((f) => f.includes(common) || common.includes(f))) {
        found.push(common);
      }
    }
  }

  return found;
}

function longestCommonSubstring(a, b) {
  let best = '';
  const previous = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j++) {
      const saved = previous[j];
      if (a[i - 1] === b[j - 1]) {
        previous[j] = diagonal + 1;
        if (previous[j] > best.length) best = a.slice(i - previous[j], i);
      } else {
        previous[j] = 0;
      }
      diagonal = saved;
    }
  }
  return best;
}

module.exports = {
  MEME_WORDS,
  WATCH_WORDS,
  countWatchWords,
  countSentences,
  checkReply,
  findRepeats,
  longestCommonSubstring,
};
