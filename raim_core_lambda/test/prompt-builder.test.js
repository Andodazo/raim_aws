'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSceneContext,
  buildFewShotMessages,
  buildFollowupMantleInput,
} = require('../lib/prompt-builder');

test('buildSceneContext includes new FewShot scene metadata', () => {
  const context = buildSceneContext({
    id: 'joke',
    description: '冗談・からかい・ユーモアの会話',
    embedding_text: '冗談 ジョーク 笑える',
    default_emotions: {
      happy: 0.5,
      excited: 0.3,
    },
  });

  assert.match(context, /embedding_text: 冗談 ジョーク 笑える/);
  assert.match(context, /default_emotions: happy:0.5, excited:0.3/);
});

test('buildFewShotMessages converts emotions map into Mantle output example', () => {
  const messages = buildFewShotMessages({
    few_shots: [
      {
        user: '笑わせて',
        raim: 'うーん、無茶振りだなぁ。ふふっ、何のお題？',
        emotions: {
          embarrassed: 0.3,
          happy: 0.4,
        },
      },
    ],
  });

  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, '笑わせて');

  const assistantExample = JSON.parse(messages[1].content);
  assert.equal(assistantExample.text, 'うーん、無茶振りだなぁ。ふふっ、何のお題？');
  assert.equal(assistantExample.emotion, 'happy');
  assert.equal(assistantExample.intensity, 0.4);
  assert.deepEqual(assistantExample.emotions, {
    embarrassed: 0.3,
    happy: 0.4,
  });
});

test('buildFollowupMantleInput includes scene hint without exposing it as user text', () => {
  const input = buildFollowupMantleInput({
    userText: 'つまんないダジャレ言うぞ',
    scene: {
      id: 'joke',
      description: '冗談・からかい・ユーモアの会話',
      embedding_text: '冗談 ジョーク',
      default_emotions: {
        happy: 0.5,
      },
    },
  });

  assert.equal(input.messages[0].role, 'system');
  assert.match(input.messages[0].content, /embedding_text: 冗談 ジョーク/);
  assert.equal(input.messages[1].role, 'user');
  assert.equal(input.messages[1].content, 'つまんないダジャレ言うぞ');
});
