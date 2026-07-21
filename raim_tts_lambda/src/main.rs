use base64::{engine::general_purpose, Engine as _};
use lambda_runtime::{service_fn, Error, LambdaEvent};
use lazy_static::lazy_static;
use serde_json::{json, to_value, Value};
use std::env;
use std::sync::Mutex;
use std::time::Instant;

mod types;
mod voicevox_wrapper;

use types::{
    TtsErrorResponse, TtsRequest, TtsSuccessResponse, DEFAULT_MAX_TEXT_CHARS, ERROR_TYPE,
    SCHEMA_VERSION, SUCCESS_TYPE,
};
use voicevox_wrapper::SimpleVoiceVox;

const DEFAULT_MAX_WAV_BYTES: usize = 4 * 1024 * 1024;
const MAX_LAMBDA_RESPONSE_BYTES: usize = 6 * 1024 * 1024;

lazy_static! {
    static ref VOICE_VOX: Result<Mutex<SimpleVoiceVox>, String> =
        SimpleVoiceVox::new().map(Mutex::new);
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    lambda_runtime::run(service_fn(function_handler)).await?;
    Ok(())
}

async fn function_handler(event: LambdaEvent<Value>) -> Result<Value, Error> {
    let payload = event.payload;
    let request = match serde_json::from_value::<TtsRequest>(payload) {
        Ok(request) => request,
        Err(_) => {
            return Ok(error_response(
                None,
                None,
                "INVALID_REQUEST",
                false,
            ));
        }
    };

    if let Err(error) = request.validate(max_text_chars()) {
        return Ok(error_response(
            Some(&request.request_id),
            Some(&request.chunk_id),
            error.code,
            false,
        ));
    }

    let started = Instant::now();
    log_request(&request);

    let voicevox = match &*VOICE_VOX {
        Ok(voicevox) => voicevox,
        Err(_) => {
            return Ok(error_response(
                Some(&request.request_id),
                Some(&request.chunk_id),
                "INITIALIZATION_FAILED",
                true,
            ));
        }
    };

    let wav = {
        let guard = match voicevox.lock() {
            Ok(guard) => guard,
            Err(_) => {
                return Ok(error_response(
                    Some(&request.request_id),
                    Some(&request.chunk_id),
                    "INTERNAL_ERROR",
                    true,
                ));
            }
        };

        match guard.synthesize(&request.text, &request.voice_params) {
            Ok(wav) => wav,
            Err(error) => {
                let code = synthesis_error_code(&error);
                return Ok(error_response(
                    Some(&request.request_id),
                    Some(&request.chunk_id),
                    code,
                    is_retriable(code),
                ));
            }
        }
    };

    if wav.len() > max_wav_bytes() {
        return Ok(error_response(
            Some(&request.request_id),
            Some(&request.chunk_id),
            "AUDIO_TOO_LARGE",
            false,
        ));
    }

    let audio = general_purpose::STANDARD.encode(&wav);
    let response = TtsSuccessResponse {
        schema_version: SCHEMA_VERSION,
        message_type: SUCCESS_TYPE,
        ok: true,
        request_id: request.request_id.clone(),
        chunk_id: request.chunk_id.clone(),
        format: "wav",
        content_type: "audio/wav",
        audio,
        audio_byte_length: wav.len(),
    };

    let response = match to_value(response) {
        Ok(response) => response,
        Err(_) => {
            return Ok(error_response(
                Some(&request.request_id),
                Some(&request.chunk_id),
                "INTERNAL_ERROR",
                true,
            ));
        }
    };

    if serde_json::to_vec(&response)
        .map(|body| body.len() > MAX_LAMBDA_RESPONSE_BYTES)
        .unwrap_or(true)
    {
        return Ok(error_response(
            Some(&request.request_id),
            Some(&request.chunk_id),
            "AUDIO_TOO_LARGE",
            false,
        ));
    }

    eprintln!(
        "{}",
        json!({
            "event": "tts.synthesized",
            "requestId": request.request_id,
            "chunkId": request.chunk_id,
            "wavBytes": wav.len(),
            "synthesisMs": started.elapsed().as_millis()
        })
    );

    Ok(response)
}

fn max_text_chars() -> usize {
    env::var("MAX_TEXT_CHARS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MAX_TEXT_CHARS)
}

fn max_wav_bytes() -> usize {
    env::var("MAX_WAV_BYTES")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_MAX_WAV_BYTES)
}

fn log_request(request: &TtsRequest) {
    eprintln!(
        "{}",
        json!({
            "event": "tts.request",
            "requestId": request.request_id,
            "chunkId": request.chunk_id,
            "speakerId": request.voice_params.speaker_id,
            "textChars": request.text.chars().count()
        })
    );
}

fn synthesis_error_code(error: &str) -> &'static str {
    match error.split(':').next().unwrap_or_default() {
        "MODEL_LOAD_FAILED" => "MODEL_LOAD_FAILED",
        "AUDIO_QUERY_FAILED" => "AUDIO_QUERY_FAILED",
        "SYNTHESIS_FAILED" => "SYNTHESIS_FAILED",
        "INITIALIZATION_FAILED" => "INITIALIZATION_FAILED",
        _ => "INTERNAL_ERROR",
    }
}

fn is_retriable(code: &str) -> bool {
    matches!(
        code,
        "INITIALIZATION_FAILED"
            | "MODEL_LOAD_FAILED"
            | "AUDIO_QUERY_FAILED"
            | "SYNTHESIS_FAILED"
            | "INTERNAL_ERROR"
    )
}

fn error_response(
    request_id: Option<&str>,
    chunk_id: Option<&str>,
    code: &'static str,
    retriable: bool,
) -> Value {
    let message = match code {
        "INVALID_REQUEST" => "Invalid TTS request",
        "UNSUPPORTED_SCHEMA_VERSION" => "Unsupported schema version",
        "UNSUPPORTED_MESSAGE_TYPE" => "Unsupported message type",
        "INVALID_TEXT" => "Invalid text",
        "INVALID_VOICE_PARAMS" => "Invalid voice parameters",
        "INITIALIZATION_FAILED" => "VOICEVOX initialization failed",
        "MODEL_LOAD_FAILED" => "VOICEVOX model loading failed",
        "AUDIO_QUERY_FAILED" => "AudioQuery generation failed",
        "SYNTHESIS_FAILED" => "WAV synthesis failed",
        "AUDIO_TOO_LARGE" => "Generated WAV is too large",
        _ => "Internal error",
    };

    to_value(TtsErrorResponse {
        schema_version: SCHEMA_VERSION,
        message_type: ERROR_TYPE,
        ok: false,
        request_id: request_id.map(ToOwned::to_owned),
        chunk_id: chunk_id.map(ToOwned::to_owned),
        code,
        message,
        retriable,
    })
    .unwrap_or_else(|_| json!({"schemaVersion": 1, "type": ERROR_TYPE, "ok": false}))
}
