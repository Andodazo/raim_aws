'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getVoiceParams,
  getVoiceParamsFromEmotions,
} = require('../lib/voice-mapper');

test('maps neutral and happy using the raim_serverside profile', () => {
  assert.deepEqual(getVoiceParams('neutral', 0.5), {
    speaker_id: 8,
    speedScale: 1,
    pitchScale: 0,
    intonationScale: 1,
    volumeScale: 1,
    endPitch: 0,
    endLengthScale: 1,
    pauseScale: 1,
  });
  assert.deepEqual(getVoiceParams('happy', 1), {
    speaker_id: 8,
    speedScale: 1.2,
    pitchScale: 0.06,
    intonationScale: 1.4,
    volumeScale: 1,
    endPitch: 0.24,
    endLengthScale: 1.2,
    pauseScale: 0.8,
  });
});

test('uses the dominant Scene emotion for streamed TTS', () => {
  assert.deepEqual(getVoiceParamsFromEmotions({ happy: 0.8, caring: 0.2 }, 1), {
    speaker_id: 8,
    speedScale: 1.16,
    pitchScale: 0.048,
    intonationScale: 1.32,
    volumeScale: 1,
    endPitch: 0.192,
    endLengthScale: 1.16,
    pauseScale: 0.84,
  });
});

// ── 12感情と人格に合わせたプロファイル ─────────────────
const voiceConfig = require('../voice-config.json');
const { resolveVoiceProfileName } = require('../lib/voice-mapper');

test('every profile has its own setting for all 12 emotions', () => {
  const emotions = [
    'neutral', 'happy', 'sad', 'angry', 'surprised', 'caring',
    'embarrassed', 'excited', 'curious', 'amused', 'thoughtful', 'playful',
  ];
  for (const [name, profile] of Object.entries(voiceConfig.profiles)) {
    for (const emotion of emotions) {
      const entry = profile.emotion_map[emotion];
      assert.ok(entry, `${name} に ${emotion} が無い`);
      for (const key of [
        'speedScale', 'pitchScale', 'intonationScale', 'volumeScale',
        'endPitch', 'endLengthScale', 'pauseScale',
      ]) {
        assert.ok(Number.isFinite(entry[key]), `${name}.${emotion}.${key}`);
      }
    }
  }
});

test('thoughtful no longer sounds the same as neutral', () => {
  // 以前は neutral へ置き換えていたので、感情が声に出なかった
  assert.notDeepEqual(getVoiceParams('thoughtful', 1), getVoiceParams('neutral', 1));
});

test('voice profile follows the persona when set to auto or unset', () => {
  assert.equal(resolveVoiceProfileName({ RAIM_PERSONA: 'downer' }, voiceConfig), 'tsumugi_downer');
  assert.equal(resolveVoiceProfileName({ RAIM_PERSONA: 'downer', RAIM_VOICE_PROFILE: 'auto' }, voiceConfig), 'tsumugi_downer');
  assert.equal(resolveVoiceProfileName({ RAIM_PERSONA: 'bright', RAIM_VOICE_PROFILE: 'auto' }, voiceConfig), 'tsumugi_parametric');
  assert.equal(resolveVoiceProfileName({}, voiceConfig), 'tsumugi_parametric');
});

test('twitter persona gets its own voice profile', () => {
  // 以前は downer 以外が全部 bright 扱いで、twitter でも bright の声だった
  assert.equal(resolveVoiceProfileName({ RAIM_PERSONA: 'twitter' }, voiceConfig), 'tsumugi_twitter');
  assert.equal(resolveVoiceProfileName({ RAIM_PERSONA: 'Twitter', RAIM_VOICE_PROFILE: 'auto' }, voiceConfig), 'tsumugi_twitter');
  // persona_profiles に無い人格名は bright の声にする
  assert.equal(resolveVoiceProfileName({ RAIM_PERSONA: 'unknown' }, voiceConfig), 'tsumugi_parametric');
});

test('an explicit voice profile wins, an unknown one falls back', () => {
  assert.equal(
    resolveVoiceProfileName({ RAIM_PERSONA: 'downer', RAIM_VOICE_PROFILE: 'tsumugi_parametric' }, voiceConfig),
    'tsumugi_parametric'
  );
  assert.equal(
    resolveVoiceProfileName({ RAIM_PERSONA: 'downer', RAIM_VOICE_PROFILE: 'nope' }, voiceConfig),
    'tsumugi_parametric'
  );
});

test('sad endings fall and stretch, surprised endings rise', () => {
  // つむぎはスタイルが1つなので、語尾と間で感情を出す
  const sad = getVoiceParams('sad', 1);
  assert.ok(sad.endPitch < 0);
  assert.ok(sad.endLengthScale > 1);
  assert.ok(sad.pauseScale > 1);
  assert.ok(getVoiceParams('surprised', 1).endPitch > 0);
});

test('ending values stay inside what the TTS Lambda accepts', () => {
  for (const [name, profile] of Object.entries(voiceConfig.profiles)) {
    for (const [emotion, entry] of Object.entries(profile.emotion_map)) {
      assert.ok(Math.abs(entry.endPitch) <= 0.3, `${name}.${emotion}.endPitch`);
      assert.ok(entry.endLengthScale >= 0.5 && entry.endLengthScale <= 2.5, `${name}.${emotion}.endLengthScale`);
      assert.ok(entry.pauseScale >= 0 && entry.pauseScale <= 3, `${name}.${emotion}.pauseScale`);
    }
  }
});
