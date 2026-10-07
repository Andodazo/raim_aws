'use strict';

// 前回の発話からの経過時間

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  findLastTalkedAt,
  describeElapsed,
  buildConversationGapContext,
} = require('../lib/conversation-gap');
const { buildMantleInput } = require('../lib/prompt-builder');

const NOW = new Date('2026-10-05T01:35:00Z');

test('existing thread uses the last message time, not updatedAt', () => {
  const thread = {
    // 要約で updatedAt が新しくなっていても使わない
    updatedAt: '2026-10-05T01:00:00Z',
    lastResponseCreatedAt: '2026-10-02T07:31:00Z',
    messages: [
      { role: 'user', text: 'いいね', createdAt: '2026-10-02T07:31:03Z' },
      { role: 'assistant', text: 'えへへ', createdAt: '2026-10-02T07:31:03Z' },
    ],
  };
  const result = findLastTalkedAt({ thread, isNew: false, session: null });
  assert.equal(result.lastTalkedAt, '2026-10-02T07:31:03Z');
  assert.equal(result.sameThread, true);
});

test('new thread uses the user-level last response time', () => {
  const result = findLastTalkedAt({
    thread: { messages: [] },
    isNew: true,
    session: { lastResponseCreatedAt: '2026-10-04T12:00:00Z' },
  });
  assert.equal(result.lastTalkedAt, '2026-10-04T12:00:00Z');
  assert.equal(result.sameThread, false);
});

test('no history gives no context', () => {
  const result = findLastTalkedAt({ thread: { messages: [] }, isNew: true, session: {} });
  assert.equal(result.lastTalkedAt, '');
  assert.equal(buildConversationGapContext({ ...result, now: NOW }), '');
});

test('elapsed labels', () => {
  assert.equal(describeElapsed(3), 'ついさっき（数分前）');
  assert.equal(describeElapsed(42), '40分くらい前');
  assert.equal(describeElapsed(60 * 5), '5時間くらい前');
  assert.equal(describeElapsed(60 * 24 * 2.5), '2日前');
  assert.equal(describeElapsed(60 * 24 * 15), '2週間くらい前');
  assert.equal(describeElapsed(60 * 24 * 45), '1か月以上前');
});

test('a gap of days suggests "久しぶり" and forbids "さっき"', () => {
  const text = buildConversationGapContext({
    lastTalkedAt: '2026-10-02T07:31:03Z',
    sameThread: true,
    now: NOW,
  });
  assert.ok(text.includes('この会話で前に話したのは2日前'));
  assert.ok(text.includes('久しぶり'));
  assert.ok(text.includes('「さっき」とは言わない'));
});

test('a short gap adds no extra rule', () => {
  const text = buildConversationGapContext({
    lastTalkedAt: '2026-10-05T01:32:00Z',
    sameThread: true,
    now: NOW,
  });
  assert.ok(text.includes('ついさっき'));
  assert.ok(!text.includes('久しぶり'));
});

test('gap context reaches both initial and followup inputs', () => {
  const gap = '【前回の発話】\nこの会話で前に話したのは2日前。';
  const systemText = (input) => input.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');

  const initial = buildMantleInput({ userText: 'こんにちは', conversationGap: gap });
  assert.ok(systemText(initial).includes('前に話したのは2日前'));

  const followup = buildMantleInput({
    userText: 'こんにちは',
    usePreviousResponseId: true,
    conversationGap: gap,
  });
  assert.ok(systemText(followup).includes('前に話したのは2日前'));

  const withoutGap = buildMantleInput({ userText: 'こんにちは' });
  // 人格プロンプト自体が【前回の発話】という見出しに触れているので、本文で判定する
  assert.ok(!systemText(withoutGap).includes('前に話したのは'));
});

test('a short gap in another conversation is not mentioned (avoids "また挨拶してくれた")', () => {
  const now = new Date('2026-10-07T05:00:00Z');
  assert.equal(buildConversationGapContext({
    lastTalkedAt: '2026-10-07T04:50:00Z',
    sameThread: false,
    now,
  }), '');

  const longGap = buildConversationGapContext({
    lastTalkedAt: '2026-10-03T04:50:00Z',
    sameThread: false,
    now,
  });
  assert.ok(longGap.includes('別の会話で最後に話したのは4日前'));
  assert.ok(longGap.includes('久しぶり'));
});

test('the prompt limits "また" to things said in this conversation', () => {
  const { buildSystemPrompt, getPersonaDigest } = require('../lib/prompts/raim-system-prompt');
  assert.ok(buildSystemPrompt().includes('この会話の中に同じ発言が本当にあるときだけ'));
  for (const persona of ['bright', 'downer']) {
    assert.ok(getPersonaDigest(persona).includes('この会話の中に同じ発言が本当にあるときだけ'));
  }
});

test('the tool rules tell the model to prefer newer articles', () => {
  const { buildSystemPrompt, TOOLS_DIGEST } = require('../lib/prompts/raim-system-prompt');
  assert.ok(buildSystemPrompt({ withTools: true }).includes('published_date が新しい方を信じる'));
  assert.ok(TOOLS_DIGEST.includes('published_date が新しい記事を優先'));
});
