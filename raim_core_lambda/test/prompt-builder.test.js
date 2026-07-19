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
  // v13: few-shot例もMantleへ要求する形式（emotions Map + overall_intensity）で見せる。
  // 旧形式の単一 emotion / intensity は出力例に含めない。
  assert.equal(assistantExample.emotion, undefined);
  assert.equal(assistantExample.intensity, undefined);
  assert.deepEqual(assistantExample.emotions, {
    embarrassed: 0.3,
    happy: 0.4,
  });
  // overall_intensity は強度合計（0.3 + 0.4 = 0.7）を目安に入る。
  assert.equal(assistantExample.overall_intensity, 0.7);
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

  // 人格ダイジェストが先頭へ入るようになったため、
  // インデックス固定ではなく役割で検証する。
  const systemMessages = input.messages.filter((m) => m.role === 'system');
  const userMessages = input.messages.filter((m) => m.role === 'user');

  assert.ok(systemMessages.length >= 1);
  assert.match(
    systemMessages.map((m) => m.content).join('\n'),
    /embedding_text: 冗談 ジョーク/
  );

  // 実際のユーザー発話は最後のuserメッセージ。
  // few-shotのuser例と混同しないよう末尾を見る。
  assert.equal(userMessages[userMessages.length - 1].content, 'つまんないダジャレ言うぞ');
});

// ─────────────────────────────────────────────
// 継続会話の人格再注入
// ─────────────────────────────────────────────
//
// previous_response_id があっても人格が崩れる実測結果への対応。
// 詳細は raim-system-prompt.js の PERSONA_DIGEST のコメントを参照。

const FOLLOWUP_SCENE = {
  id: 'default',
  description: '汎用シーン',
  embedding_text: '雑談',
  default_emotions: { neutral: 0.5 },
  few_shots: [
    { user: 'こんにちは', raim: 'あ、こんにちは。今日はどんな話する？', emotions: { happy: 0.4, caring: 0.3 } },
    { user: '今日はいい天気だね', raim: 'うん、外出たくなる感じだね。', emotions: { happy: 0.5 } },
  ],
};

function followupSystemText(input) {
  return input.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n');
}

test('followup injects the persona digest by default', () => {
  const input = buildFollowupMantleInput({
    userText: 'こんにちは',
    scene: FOLLOWUP_SCENE,
  });

  const systemText = followupSystemText(input);

  // 口調ルールと禁止事項が毎回届く
  assert.ok(systemText.includes('ライムとして返答する'));
  assert.ok(systemText.includes('AI自己紹介'));

  // 12感情と出力形式も届く
  assert.ok(systemText.includes('playful'));
  assert.ok(systemText.includes('emotions'));

  // Sceneヒントは従来どおり残る
  assert.ok(systemText.includes('Sceneヒント'));
});

test('followup persona mode "none" restores the original behaviour', () => {
  const input = buildFollowupMantleInput({
    userText: 'こんにちは',
    scene: FOLLOWUP_SCENE,
    personaMode: 'none',
    fewShotCount: 0,
  });

  const systemText = followupSystemText(input);

  assert.ok(!systemText.includes('ライムとして返答する'));
  assert.ok(systemText.includes('Sceneヒント'));
});

test('followup persona mode "full" sends the complete system prompt', () => {
  const digest = buildFollowupMantleInput({
    userText: 'こんにちは',
    scene: FOLLOWUP_SCENE,
  });

  const full = buildFollowupMantleInput({
    userText: 'こんにちは',
    scene: FOLLOWUP_SCENE,
    personaMode: 'full',
  });

  // full の方が明確に長い（全文 vs ダイジェスト）
  assert.ok(followupSystemText(full).length > followupSystemText(digest).length);
});

test('followup includes a limited number of few-shot examples', () => {
  const input = buildFollowupMantleInput({
    userText: 'こんにちは',
    scene: FOLLOWUP_SCENE,
    fewShotCount: 1,
  });

  // few-shot 1組 = user + assistant の2メッセージ
  const assistantExamples = input.messages.filter((m) => m.role === 'assistant');
  assert.equal(assistantExamples.length, 1);

  // 口調のお手本がそのまま入っている
  assert.ok(assistantExamples[0].content.includes('あ、こんにちは'));
});

test('followup few-shot can be disabled', () => {
  const input = buildFollowupMantleInput({
    userText: 'こんにちは',
    scene: FOLLOWUP_SCENE,
    fewShotCount: 0,
  });

  assert.equal(input.messages.filter((m) => m.role === 'assistant').length, 0);
});
