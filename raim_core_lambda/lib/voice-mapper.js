'use strict';

// ============================================================================
// Voice parameter mapper
// ============================================================================
//
// raim_serverside/lib/voice-mapper.js の考え方をCore Lambda向けに移植する。
// 感情はドミナント感情へ正規化し、TTS Lambdaへ送る連続パラメータを
// neutralから線形補間する。音声パラメータはクライアントへ送らない。

const fs = require('fs');
const path = require('path');

const EMOTION_FALLBACK = Object.freeze({
  curious: 'happy',
  amused: 'happy',
  thoughtful: 'neutral',
  playful: 'happy',
});

const DEFAULT_VOICE_PARAMS = Object.freeze({
  speaker_id: 8,
  speedScale: 1.0,
  pitchScale: 0.0,
  intonationScale: 1.0,
  volumeScale: 1.0,
});

function loadConfig() {
  const configPath = path.join(__dirname, '..', 'voice-config.json');

  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.warn(`[VoiceMapper] voice-config.json unavailable: ${error.message}`);
    return null;
  }
}

const VOICE_CONFIG = loadConfig();
const ACTIVE_PROFILE_NAME = String(
  process.env.RAIM_VOICE_PROFILE || VOICE_CONFIG?.active_profile || 'tsumugi_parametric'
);
const ACTIVE_PROFILE = VOICE_CONFIG?.profiles?.[ACTIVE_PROFILE_NAME] || null;

function clamp01(value, fallback = 0.5) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return fallback;
  }

  return Math.max(0, Math.min(1, number));
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function defaultVoiceParams() {
  return { ...DEFAULT_VOICE_PARAMS };
}

function getVoiceParams(emotion = 'neutral', intensity = 0.5) {
  if (!ACTIVE_PROFILE?.emotion_map) {
    return defaultVoiceParams();
  }

  const mappedEmotion = ACTIVE_PROFILE.emotion_map[emotion]
    ? emotion
    : (EMOTION_FALLBACK[emotion] || 'neutral');
  const target = ACTIVE_PROFILE.emotion_map[mappedEmotion];
  const neutral = ACTIVE_PROFILE.emotion_map.neutral;

  if (!target || !neutral) {
    return defaultVoiceParams();
  }

  const safeIntensity = clamp01(intensity);
  const lerp = (key) => {
    const neutralValue = Number(neutral[key] ?? DEFAULT_VOICE_PARAMS[key]);
    const targetValue = Number(target[key] ?? neutralValue);
    return round3(neutralValue + (targetValue - neutralValue) * safeIntensity);
  };

  return {
    speaker_id: Number(target.speaker_id ?? DEFAULT_VOICE_PARAMS.speaker_id),
    speedScale: lerp('speedScale'),
    pitchScale: lerp('pitchScale'),
    intonationScale: lerp('intonationScale'),
    volumeScale: lerp('volumeScale'),
  };
}

function getVoiceParamsFromEmotions(emotions, overallIntensity = 1.0) {
  if (!emotions || typeof emotions !== 'object' || Array.isArray(emotions)) {
    return getVoiceParams('neutral', 0.5);
  }

  let dominantEmotion = 'neutral';
  let dominantValue = 0;

  for (const [emotion, value] of Object.entries(emotions)) {
    const number = Number(value);

    if (Number.isFinite(number) && number > dominantValue) {
      dominantEmotion = emotion;
      dominantValue = number;
    }
  }

  if (dominantValue <= 0) {
    return getVoiceParams('neutral', 0.5);
  }

  return getVoiceParams(
    dominantEmotion,
    clamp01(dominantValue) * clamp01(overallIntensity, 1.0)
  );
}

module.exports = {
  ACTIVE_PROFILE_NAME,
  EMOTION_FALLBACK,
  defaultVoiceParams,
  getVoiceParams,
  getVoiceParamsFromEmotions,
};
