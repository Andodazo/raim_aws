'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  canUsePreviousResponseId,
  getMantleSessionState,
  calculateResponseExpiresAt,
} = require('../lib/mantle-session-policy');

const NOW = new Date('2026-09-03T00:00:00Z');

test('lastResponseExpiresAt が未来なら継続できる', () => {
  const session = {
    lastResponseId: 'resp-1',
    lastResponseExpiresAt: '2026-09-20T00:00:00Z',
  };

  assert.equal(canUsePreviousResponseId(session, NOW), true);
});

test('lastResponseExpiresAt が過去なら継続しない', () => {
  const session = {
    lastResponseId: 'resp-1',
    lastResponseExpiresAt: '2026-08-01T00:00:00Z',
  };

  assert.equal(canUsePreviousResponseId(session, NOW), false);
});

// ConversationThread は lastResponseExpiresAt を持たない期間があった。
// createdAt から導出できないと、スレッド単位の継続判定が常に false になり
// previous_response_id が一切使われなくなる。
test('lastResponseExpiresAt が無くても createdAt が最近なら継続できる', () => {
  const thread = {
    lastResponseId: 'resp-1',
    lastResponseCreatedAt: '2026-09-02T00:00:00Z',
  };

  assert.equal(canUsePreviousResponseId(thread, NOW), true);
});

test('lastResponseExpiresAt が無く createdAt が有効日数より前なら継続しない', () => {
  const thread = {
    lastResponseId: 'resp-1',
    lastResponseCreatedAt: '2026-07-01T00:00:00Z',
  };

  assert.equal(canUsePreviousResponseId(thread, NOW), false);
});

test('lastResponseId が無ければ継続しない', () => {
  const thread = { lastResponseCreatedAt: '2026-09-02T00:00:00Z' };

  assert.equal(canUsePreviousResponseId(thread, NOW), false);
});

test('日付が両方とも無ければ継続しない', () => {
  const thread = { lastResponseId: 'resp-1' };

  assert.equal(canUsePreviousResponseId(thread, NOW), false);
});

test('session が無ければ継続しない', () => {
  assert.equal(canUsePreviousResponseId(null, NOW), false);
});

test('getMantleSessionState は継続できるときだけ previousResponseId を返す', () => {
  const usable = getMantleSessionState(
    { lastResponseId: 'resp-1', lastResponseCreatedAt: '2026-09-02T00:00:00Z' },
    NOW
  );
  const expired = getMantleSessionState(
    { lastResponseId: 'resp-1', lastResponseCreatedAt: '2026-07-01T00:00:00Z' },
    NOW
  );

  assert.equal(usable.usePreviousResponseId, true);
  assert.equal(usable.previousResponseId, 'resp-1');

  assert.equal(expired.usePreviousResponseId, false);
  assert.equal(expired.previousResponseId, '');
});

test('calculateResponseExpiresAt は createdAt から有効日数ぶん先を返す', () => {
  const expiresAt = calculateResponseExpiresAt('2026-09-01T00:00:00Z', 29);

  assert.equal(new Date(expiresAt).toISOString(), '2026-09-30T00:00:00.000Z');
});
