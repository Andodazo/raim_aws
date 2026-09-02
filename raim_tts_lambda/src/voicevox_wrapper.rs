use std::env;
use std::ffi::CString;
use std::time::Instant;

use serde_json::Value;
use vvcore::{AccelerationMode, AudioQueryOptions, SynthesisOptions, VoicevoxCore};

use crate::types::VoiceParams;

const DEFAULT_CPU_THREADS: u16 = 6;

pub struct SimpleVoiceVox {
    vvc: VoicevoxCore,
}

impl SimpleVoiceVox {
    pub fn new() -> Result<Self, String> {
        let dict_dir = env::var("OPEN_JTALK_DICT_DIR")
            .map_err(|_| "OPEN_JTALK_DICT_DIR is required".to_string())?;
        let cpu_threads = env::var("VOICEVOX_CPU_THREADS")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_CPU_THREADS);
        let dict_dir = CString::new(dict_dir)
            .map_err(|_| "OPEN_JTALK_DICT_DIR contains an invalid value".to_string())?;

        let vvc = VoicevoxCore::new_from_options(
            AccelerationMode::CPU,
            cpu_threads,
            false,
            &dict_dir,
        )
        .map_err(|error| format!("INITIALIZATION_FAILED: {error:?}"))?;

        Ok(Self { vvc })
    }

    pub fn synthesize(&self, text: &str, params: &VoiceParams) -> Result<Vec<u8>, String> {
        let speaker_id = params.speaker_id;

        if !self.vvc.is_model_loaded(speaker_id) {
            let started = Instant::now();
            self.vvc
                .load_model(speaker_id)
                .map_err(|error| format!("MODEL_LOAD_FAILED: {error:?}"))?;
            eprintln!(
                "{}",
                serde_json::json!({
                    "event": "tts.model_loaded",
                    "speakerId": speaker_id,
                    "modelLoadMs": started.elapsed().as_millis()
                })
            );
        }

        let audio_query = self
            .vvc
            .audio_query(text, speaker_id, AudioQueryOptions { kana: false })
            .map_err(|error| format!("AUDIO_QUERY_FAILED: {error:?}"))?;

        let mut query: Value = serde_json::from_str(audio_query.as_str())
            .map_err(|_| "AUDIO_QUERY_FAILED: invalid AudioQuery JSON".to_string())?;

        apply_voice_params(&mut query, params)
            .map_err(|_| "AUDIO_QUERY_FAILED: invalid AudioQuery object".to_string())?;

        let query_json = serde_json::to_string(&query)
            .map_err(|_| "AUDIO_QUERY_FAILED: failed to serialize AudioQuery".to_string())?;

        let wav = self
            .vvc
            .synthesis(
                &query_json,
                speaker_id,
                SynthesisOptions {
                    enable_interrogative_upspeak: true,
                },
            )
            .map_err(|error| format!("SYNTHESIS_FAILED: {error:?}"))?;

        Ok(wav.as_slice().to_vec())
    }
}

pub(crate) fn apply_voice_params(
    query: &mut Value,
    params: &VoiceParams,
) -> Result<(), String> {
    let object = query
        .as_object_mut()
        .ok_or_else(|| "AudioQuery must be a JSON object".to_string())?;

    object.insert("speedScale".to_string(), Value::from(params.speed_scale));
    object.insert("pitchScale".to_string(), Value::from(params.pitch_scale));
    object.insert(
        "intonationScale".to_string(),
        Value::from(params.intonation_scale),
    );
    object.insert("volumeScale".to_string(), Value::from(params.volume_scale));

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn params() -> VoiceParams {
        serde_json::from_value(json!({
            "speaker_id": 8,
            "speedScale": 0.95,
            "pitchScale": 0.1,
            "intonationScale": 0.9,
            "volumeScale": 1.1
        }))
        .expect("voice params should deserialize")
    }

    #[test]
    fn applies_voice_params_without_removing_existing_fields() {
        let mut query = json!({
            "accentPhrases": [],
            "speedScale": 1.0,
            "pitchScale": 0.0,
            "intonationScale": 1.0,
            "volumeScale": 1.0
        });

        apply_voice_params(&mut query, &params()).expect("AudioQuery update should work");

        assert_eq!(query["accentPhrases"], json!([]));
        assert_eq!(query["speedScale"], json!(0.95));
        assert_eq!(query["pitchScale"], json!(0.1));
        assert_eq!(query["intonationScale"], json!(0.9));
        assert_eq!(query["volumeScale"], json!(1.1));
    }

    #[test]
    fn rejects_non_object_audio_query() {
        let mut query = json!([]);

        assert!(apply_voice_params(&mut query, &params()).is_err());
    }
}
