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

    apply_ending(object, params);

    Ok(())
}

/// 感情に合わせて、語尾の高さ・長さと、文中の間の長さを変える。
///
/// つむぎにはスタイルが「ノーマル」しか無いので、以前は文全体の速さ・高さ・抑揚
/// だけで感情を出していた。「そっかぁ…」の伸びや、驚いたときの語尾の上がり方は
/// 出せなかったので、AudioQuery の音（モーラ）を直接いじる。
/// 何も指定されていなければ（既定値なら）何も変えない。
fn apply_ending(object: &mut serde_json::Map<String, Value>, params: &VoiceParams) {
    // VOICEVOX core は accent_phrases で返す。念のためエンジン以外の書き方も見る
    let key = if object.contains_key("accent_phrases") {
        "accent_phrases"
    } else {
        "accentPhrases"
    };
    let Some(phrases) = object.get_mut(key).and_then(Value::as_array_mut) else {
        return;
    };

    if params.pause_scale != 1.0 {
        for phrase in phrases.iter_mut() {
            if let Some(pause) = phrase.get_mut("pause_mora").filter(|pause| pause.is_object()) {
                scale_number(pause, "vowel_length", params.pause_scale);
            }
        }
    }

    if params.end_pitch == 0.0 && params.end_length_scale == 1.0 {
        return;
    }

    let Some(moras) = phrases
        .last_mut()
        .and_then(|phrase| phrase.get_mut("moras"))
        .and_then(Value::as_array_mut)
    else {
        return;
    };

    // 最後の声のある音を語尾とする。無声の音（「です」の「す」など）は pitch が 0 で、
    // 高さを足すと逆に声が出てしまうので、高さはいじらない
    let voiced = moras
        .iter()
        .rposition(|mora| mora.get("pitch").and_then(Value::as_f64).unwrap_or(0.0) > 0.0);

    if let Some(index) = voiced {
        let mora = &mut moras[index];
        if let Some(pitch) = mora.get("pitch").and_then(Value::as_f64) {
            mora["pitch"] = Value::from(pitch + params.end_pitch);
        }
    }

    let last = voiced.or_else(|| moras.len().checked_sub(1));
    if let Some(index) = last {
        scale_number(&mut moras[index], "vowel_length", params.end_length_scale);
    }
}

fn scale_number(value: &mut Value, key: &str, factor: f64) {
    if let Some(number) = value.get(key).and_then(Value::as_f64) {
        value[key] = Value::from(number * factor);
    }
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

    fn mora(text: &str, pitch: f64, vowel_length: f64) -> Value {
        json!({
            "text": text,
            "consonant": null,
            "consonant_length": null,
            "vowel": "a",
            "vowel_length": vowel_length,
            "pitch": pitch
        })
    }

    fn query_with_two_phrases() -> Value {
        json!({
            "accent_phrases": [
                {
                    "moras": [mora("ソ", 5.5, 0.1), mora("ッ", 0.0, 0.0), mora("カ", 5.8, 0.12)],
                    "accent": 1,
                    "pause_mora": mora("、", 0.0, 0.3),
                    "is_interrogative": false
                },
                {
                    "moras": [mora("デ", 5.6, 0.1), mora("ス", 0.0, 0.08)],
                    "accent": 1,
                    "pause_mora": null,
                    "is_interrogative": false
                }
            ],
            "speedScale": 1.0
        })
    }

    fn ending_params(end_pitch: f64, end_length_scale: f64, pause_scale: f64) -> VoiceParams {
        serde_json::from_value(json!({
            "speaker_id": 8,
            "endPitch": end_pitch,
            "endLengthScale": end_length_scale,
            "pauseScale": pause_scale
        }))
        .expect("voice params should deserialize")
    }

    #[test]
    fn leaves_moras_alone_with_default_ending() {
        let mut query = query_with_two_phrases();
        let before = query["accent_phrases"].clone();

        apply_voice_params(&mut query, &params()).expect("AudioQuery update should work");

        assert_eq!(query["accent_phrases"], before);
    }

    #[test]
    fn raises_and_stretches_the_last_voiced_mora() {
        let mut query = query_with_two_phrases();

        apply_voice_params(&mut query, &ending_params(0.05, 1.5, 1.0))
            .expect("AudioQuery update should work");

        let last = &query["accent_phrases"][1]["moras"];
        // 「デ」が語尾。無声の「ス」は高さを足さない（足すと声が出てしまう）
        assert!((last[0]["pitch"].as_f64().unwrap() - 5.65).abs() < 1e-9);
        assert!((last[0]["vowel_length"].as_f64().unwrap() - 0.15).abs() < 1e-9);
        assert_eq!(last[1]["pitch"], json!(0.0));
        assert_eq!(last[1]["vowel_length"], json!(0.08));
        // 最後の句以外は変えない
        assert_eq!(query["accent_phrases"][0]["moras"][2]["pitch"], json!(5.8));
    }

    #[test]
    fn scales_pauses_between_phrases() {
        let mut query = query_with_two_phrases();

        apply_voice_params(&mut query, &ending_params(0.0, 1.0, 1.5))
            .expect("AudioQuery update should work");

        let pause = query["accent_phrases"][0]["pause_mora"]["vowel_length"]
            .as_f64()
            .unwrap();
        assert!((pause - 0.45).abs() < 1e-9);
        assert_eq!(query["accent_phrases"][1]["pause_mora"], Value::Null);
    }

    #[test]
    fn rejects_non_object_audio_query() {
        let mut query = json!([]);

        assert!(apply_voice_params(&mut query, &params()).is_err());
    }
}
