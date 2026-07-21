use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;
pub const REQUEST_TYPE: &str = "tts.synthesize";
pub const SUCCESS_TYPE: &str = "tts.synthesized";
pub const ERROR_TYPE: &str = "tts.error";

pub const DEFAULT_MAX_TEXT_CHARS: usize = 200;
pub const DEFAULT_SPEED_SCALE: f64 = 1.0;
pub const DEFAULT_PITCH_SCALE: f64 = 0.0;
pub const DEFAULT_INTONATION_SCALE: f64 = 1.0;
pub const DEFAULT_VOLUME_SCALE: f64 = 1.0;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsRequest {
    pub schema_version: u32,

    #[serde(rename = "type")]
    pub message_type: String,

    pub request_id: String,
    pub chunk_id: String,
    pub text: String,
    pub voice_params: VoiceParams,
}

#[derive(Debug, Clone, Deserialize)]
pub struct VoiceParams {
    #[serde(rename = "speaker_id", alias = "speakerId")]
    pub speaker_id: u32,

    #[serde(rename = "speedScale", default = "default_speed_scale")]
    pub speed_scale: f64,

    #[serde(rename = "pitchScale", default = "default_pitch_scale")]
    pub pitch_scale: f64,

    #[serde(rename = "intonationScale", default = "default_intonation_scale")]
    pub intonation_scale: f64,

    #[serde(rename = "volumeScale", default = "default_volume_scale")]
    pub volume_scale: f64,
}

fn default_speed_scale() -> f64 {
    DEFAULT_SPEED_SCALE
}

fn default_pitch_scale() -> f64 {
    DEFAULT_PITCH_SCALE
}

fn default_intonation_scale() -> f64 {
    DEFAULT_INTONATION_SCALE
}

fn default_volume_scale() -> f64 {
    DEFAULT_VOLUME_SCALE
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationError {
    pub code: &'static str,
    pub message: String,
}

impl TtsRequest {
    pub fn validate(&self, max_text_chars: usize) -> Result<(), ValidationError> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(ValidationError {
                code: "UNSUPPORTED_SCHEMA_VERSION",
                message: "Unsupported schema version".to_string(),
            });
        }

        if self.message_type != REQUEST_TYPE {
            return Err(ValidationError {
                code: "UNSUPPORTED_MESSAGE_TYPE",
                message: "Unsupported message type".to_string(),
            });
        }

        if self.request_id.trim().is_empty() || self.chunk_id.trim().is_empty() {
            return Err(ValidationError {
                code: "INVALID_REQUEST",
                message: "requestId and chunkId are required".to_string(),
            });
        }

        if self.text.trim().is_empty() || self.text.chars().count() > max_text_chars {
            return Err(ValidationError {
                code: "INVALID_TEXT",
                message: "Invalid text".to_string(),
            });
        }

        self.voice_params.validate()
    }
}

impl VoiceParams {
    pub fn validate(&self) -> Result<(), ValidationError> {
        let values = [
            ("speedScale", self.speed_scale, 0.5, 2.0),
            ("pitchScale", self.pitch_scale, -0.15, 0.15),
            ("intonationScale", self.intonation_scale, 0.0, 2.0),
            ("volumeScale", self.volume_scale, 0.0, 2.0),
        ];

        for (name, value, minimum, maximum) in values {
            if !value.is_finite() || !(minimum..=maximum).contains(&value) {
                return Err(ValidationError {
                    code: "INVALID_VOICE_PARAMS",
                    message: format!("Invalid voice parameter: {name}"),
                });
            }
        }

        Ok(())
    }
}

#[derive(Debug, Serialize)]
pub struct TtsSuccessResponse {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    #[serde(rename = "type")]
    pub message_type: &'static str,
    pub ok: bool,
    #[serde(rename = "requestId")]
    pub request_id: String,
    #[serde(rename = "chunkId")]
    pub chunk_id: String,
    pub format: &'static str,
    #[serde(rename = "contentType")]
    pub content_type: &'static str,
    pub audio: String,
    #[serde(rename = "audioByteLength")]
    pub audio_byte_length: usize,
}

#[derive(Debug, Serialize)]
pub struct TtsErrorResponse {
    #[serde(rename = "schemaVersion")]
    pub schema_version: u32,
    #[serde(rename = "type")]
    pub message_type: &'static str,
    pub ok: bool,
    #[serde(rename = "requestId", skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(rename = "chunkId", skip_serializing_if = "Option::is_none")]
    pub chunk_id: Option<String>,
    pub code: &'static str,
    pub message: &'static str,
    pub retriable: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn valid_request() -> TtsRequest {
        serde_json::from_value(json!({
            "schemaVersion": 1,
            "type": "tts.synthesize",
            "requestId": "req-001",
            "chunkId": "req-001_chunk_0",
            "text": "こんにちは。",
            "voiceParams": {
                "speaker_id": 8,
                "speedScale": 0.95,
                "pitchScale": 0.0,
                "intonationScale": 0.9,
                "volumeScale": 1.0
            }
        }))
        .expect("valid request should deserialize")
    }

    #[test]
    fn deserializes_local_voice_parameter_names() {
        let request = valid_request();

        assert_eq!(request.voice_params.speaker_id, 8);
        assert_eq!(request.voice_params.speed_scale, 0.95);
        assert_eq!(request.voice_params.intonation_scale, 0.9);
    }

    #[test]
    fn accepts_speaker_id_alias() {
        let request: TtsRequest = serde_json::from_value(json!({
            "schemaVersion": 1,
            "type": "tts.synthesize",
            "requestId": "req-001",
            "chunkId": "chunk-0",
            "text": "こんにちは",
            "voiceParams": {"speakerId": 8}
        }))
        .expect("speakerId alias should work");

        assert_eq!(request.voice_params.speaker_id, 8);
        assert_eq!(request.voice_params.speed_scale, DEFAULT_SPEED_SCALE);
    }

    #[test]
    fn applies_defaults_to_omitted_parameters() {
        let request: TtsRequest = serde_json::from_value(json!({
            "schemaVersion": 1,
            "type": "tts.synthesize",
            "requestId": "req-001",
            "chunkId": "chunk-0",
            "text": "こんにちは",
            "voiceParams": {"speaker_id": 8}
        }))
        .expect("defaults should deserialize");

        assert_eq!(request.voice_params.speed_scale, 1.0);
        assert_eq!(request.voice_params.pitch_scale, 0.0);
        assert_eq!(request.voice_params.intonation_scale, 1.0);
        assert_eq!(request.voice_params.volume_scale, 1.0);
    }

    #[test]
    fn rejects_invalid_schema_and_type() {
        let mut request = valid_request();
        request.schema_version = 2;
        assert_eq!(request.validate(200).unwrap_err().code, "UNSUPPORTED_SCHEMA_VERSION");

        let mut request = valid_request();
        request.message_type = "tts.other".to_string();
        assert_eq!(request.validate(200).unwrap_err().code, "UNSUPPORTED_MESSAGE_TYPE");
    }

    #[test]
    fn rejects_invalid_text_and_voice_parameters() {
        let mut request = valid_request();
        request.text = "   ".to_string();
        assert_eq!(request.validate(200).unwrap_err().code, "INVALID_TEXT");

        let mut request = valid_request();
        request.voice_params.speed_scale = 2.1;
        assert_eq!(request.validate(200).unwrap_err().code, "INVALID_VOICE_PARAMS");
    }
}
