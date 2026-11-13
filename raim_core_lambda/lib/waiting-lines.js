'use strict';

// ==============================================================================
// Mantle の返事が遅いときの、ライムのひとこと
// ==============================================================================
//
// Mantle はふだん1〜3秒で返すが、たまに長く黙る（2026-11-13）。黙っている間は
// アプリが「考えているよ」のままなので、少し遅いとき（slow）と頼み直すとき（retry）に、
// ライムに一言言わせる（mantle-client.js の onWaiting）。
// 文はコードで決めて、その中からランダムに選ぶ（安藤さんと決めた）。プロンプトには書かない。
// 話しかけと知らせのときは言わない（ライムから先に話すのに「待って」は変なので）。

const WAITING_LINES = Object.freeze({
  slow: Object.freeze([
    'ちょっと待ってね、いま考えてる',
    'んー、ちょっと考えさせて',
    'いい返し考えてるから、ちょっと待ってて',
  ]),
  retry: Object.freeze([
    'ごめん、頭が固まってた。もうちょっとだけ待って',
    'あれ、なんか重いかも。もう少し待ってね',
  ]),
});

/**
 * 待たせているときのひとこと。stage が分からなければ ''。
 *
 * @param {'slow'|'retry'} stage
 * @param {Function} [random] テストで固定できるよう注入可能
 */
function pickWaitingLine(stage, random = Math.random) {
  const lines = WAITING_LINES[stage];
  if (!lines || lines.length === 0) return '';
  const index = Math.min(lines.length - 1, Math.floor(random() * lines.length));
  return lines[index];
}

module.exports = {
  WAITING_LINES,
  pickWaitingLine,
};
