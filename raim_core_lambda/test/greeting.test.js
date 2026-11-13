'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GREETING_INSTRUCTION,
  GREETING_ANGLES,
  LONG_GAP_MINUTES,
  pickGreetingAngle,
  buildGreetingInstruction,
  isAfterHardTalk,
  buildCareGreetingInstruction,
} = require('../lib/greeting');

test('pickGreetingAngle spreads over the angles', () => {
  const ids = new Set();
  for (let i = 0; i < GREETING_ANGLES.length; i += 1) {
    const angle = pickGreetingAngle({ hasMemory: true, random: () => (i + 0.5) / GREETING_ANGLES.length });
    ids.add(angle.id);
  }
  assert.equal(ids.size, GREETING_ANGLES.length);
  // random が 1 に近くても範囲外にならない
  assert.ok(pickGreetingAngle({ hasMemory: true, random: () => 0.9999999 }));
});

test('pickGreetingAngle skips "followup" when nothing is remembered', () => {
  for (let i = 0; i < 50; i += 1) {
    const angle = pickGreetingAngle({ hasMemory: false, random: () => i / 50 });
    assert.notEqual(angle.id, 'followup');
  }
});

test('after several days, "long time no see" wins over the angle', () => {
  assert.equal(pickGreetingAngle({ gapMinutes: LONG_GAP_MINUTES, random: () => 0 }), null);
  assert.ok(pickGreetingAngle({ gapMinutes: LONG_GAP_MINUTES - 1, random: () => 0 }));
  // 分からないときは切り口を使う
  assert.ok(pickGreetingAngle({ gapMinutes: null, random: () => 0 }));

  const longGap = buildGreetingInstruction(null);
  assert.ok(longGap.startsWith(GREETING_INSTRUCTION));
  assert.match(longGap, /久しぶり/);
  assert.doesNotMatch(longGap, /今回の切り口/);
});

test('buildGreetingInstruction adds the chosen angle', () => {
  const text = buildGreetingInstruction(GREETING_ANGLES[2]);
  assert.ok(text.startsWith(GREETING_INSTRUCTION));
  assert.ok(text.includes(GREETING_ANGLES[2].text));
});

// ── つらい話のあと ─────────────────────────

const NOW_HARD = new Date('2026-11-06T05:18:42.000Z');

function threadWith(text, createdAt = '2026-11-06T05:15:32.000Z') {
  return {
    messages: [
      { role: 'user', text, createdAt },
      { role: 'assistant', text: 'うん', createdAt },
    ],
  };
}

test('isAfterHardTalk: a recent hard talk is noticed', () => {
  assert.equal(isAfterHardTalk(threadWith('もう消えたい'), NOW_HARD), true);
  assert.equal(isAfterHardTalk(threadWith('今日しんどいな'), NOW_HARD), true);
});

test('isAfterHardTalk: an ordinary or old message is not', () => {
  assert.equal(isAfterHardTalk(threadWith('新宿で起こして'), NOW_HARD), false);
  // 3時間より前
  assert.equal(isAfterHardTalk(threadWith('もう消えたい', '2026-11-06T02:00:00.000Z'), NOW_HARD), false);
  assert.equal(isAfterHardTalk(null, NOW_HARD), false);
  assert.equal(isAfterHardTalk({ messages: [] }, NOW_HARD), false);
});

test('isAfterHardTalk: only the last user message counts', () => {
  const thread = {
    messages: [
      { role: 'user', text: 'もう消えたい', createdAt: '2026-11-06T05:10:00.000Z' },
      { role: 'assistant', text: '聞かせて', createdAt: '2026-11-06T05:10:00.000Z' },
      { role: 'user', text: 'ありがとう、ちょっと楽になった', createdAt: '2026-11-06T05:15:00.000Z' },
      { role: 'assistant', text: 'よかった', createdAt: '2026-11-06T05:15:00.000Z' },
    ],
  };
  assert.equal(isAfterHardTalk(thread, NOW_HARD), false);
});

test('care greeting has no angle and asks gently', () => {
  const text = buildCareGreetingInstruction();
  assert.ok(text.startsWith(GREETING_INSTRUCTION));
  assert.ok(text.includes('季節の話'));
  assert.ok(text.includes('そっと様子を聞く'));
  assert.ok(!text.includes('今回の切り口'));
  // ふつうの話しかけにも、つらい話のあとの保険が入っている
  assert.ok(GREETING_INSTRUCTION.includes('直前の会話がつらい話だったら'));
});

// 話しかけの16回中13回が「やっほー」で始まっていた（2026-11-13）
test('opening: about half start without a greeting word, the rest avoid the last opening', () => {
  const { buildOpeningLine, lastGreetingOpening, PLAIN_OPENING_LINE } = require('../lib/greeting');
  assert.equal(buildOpeningLine({ random: () => 0.1 }), PLAIN_OPENING_LINE);
  assert.match(buildOpeningLine({ previousOpening: 'やっほー', random: () => 0.9 }), /前回の話しかけの出だし「やっほー」とは違う/);
  assert.match(buildOpeningLine({ random: () => 0.9 }), /決まった言い方にしない/);
  // 知らせる話しかけは、いつも中身から
  assert.equal(buildOpeningLine({ previousOpening: 'やっほー', reminder: true, random: () => 0.9 }), PLAIN_OPENING_LINE);

  const messages = [
    { role: 'assistant', text: 'やっほー！また来てくれたね', meta: { greeting: true } },
    { role: 'user', text: 'ただいま' },
    { role: 'assistant', text: 'おかえり。今日はどうだった？', meta: { greeting: true } },
    { role: 'assistant', text: 'それはよかった', meta: {} },
  ];
  assert.equal(lastGreetingOpening(messages), 'おかえり');
  assert.equal(lastGreetingOpening([{ role: 'assistant', text: 'ふつうの返事' }]), '');
  assert.equal(lastGreetingOpening([]), '');
  assert.equal(lastGreetingOpening([{ role: 'assistant', text: 'あいうえおかきくけこさしすせそ', meta: { greeting: true } }]).length, 12);
});
