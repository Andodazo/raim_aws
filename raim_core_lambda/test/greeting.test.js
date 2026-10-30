'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  GREETING_INSTRUCTION,
  GREETING_ANGLES,
  LONG_GAP_MINUTES,
  pickGreetingAngle,
  buildGreetingInstruction,
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
