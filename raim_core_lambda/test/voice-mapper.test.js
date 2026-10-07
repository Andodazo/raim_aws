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
  });
  assert.deepEqual(getVoiceParams('happy', 1), {
    speaker_id: 8,
    speedScale: 1.1,
    pitchScale: 0.03,
    intonationScale: 1.2,
    volumeScale: 1,
  });
});

test('uses the dominant Scene emotion for streamed TTS', () => {
  assert.deepEqual(getVoiceParamsFromEmotions({ happy: 0.8, caring: 0.2 }, 1), {
    speaker_id: 8,
    speedScale: 1.08,
    pitchScale: 0.024,
    intonationScale: 1.16,
    volumeScale: 1,
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
      for (const key of ['speedScale', 'pitchScale', 'intonationScale', 'volumeScale']) {
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
