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
