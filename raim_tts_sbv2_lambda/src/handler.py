# 自作の声（ライム、SBV2 JP-Extra raim_D1v4）の TTS Lambda（x86_64 / Python 3.12 / ONNX）。
#
# VOICEVOX の TTS Lambda（raim_tts_lambda）と同じ受け答えの形にしてあるので、
# Core は TTS_FUNCTION_NAME をこの関数名に変えるだけで切り替えられる。
#
# 受け取る:
#   {"schemaVersion": 1, "type": "tts.synthesize", "requestId", "chunkId", "text",
#    "voiceParams": {"emotionMix": {"happy": 0.6, ...}, "emotionIntensity": 0.8, ...VOICEVOX 用の値}}
#   {"schemaVersion": 1, "type": "tts.warmup"}  … モデルを読み込むだけ（アプリの起動時・再接続時）
# 返す:
#   成功 {"schemaVersion": 1, "type": "tts.synthesized", "ok": true, "requestId", "chunkId",
#         "format": "wav", "contentType": "audio/wav", "audio": <base64>, "audioByteLength"}
#   失敗 {"schemaVersion": 1, "type": "tts.error", "ok": false, "requestId", "chunkId",
#         "code", "message", "retriable"}
#
# モデル一式は S3 の raim_models.tar（MODEL_S3_BUCKET / MODEL_S3_PREFIX）。
# 落とした .onnx は /tmp に置かずメモリから InferenceSession に渡す（SnapStart の /tmp 512MB 制限のため）。
#
# 読み込みのタイミング（PRELOAD）
#   0（既定）… 最初の呼び出しで読む。ふつうの Lambda は初期化が10秒までなので、本番はこれ。
#   1        … 初期化の中で読む。SnapStart を使うとき（発表の日など）だけ。
#
# ログには文の中身を残さない（長さと時間だけ）。
import base64
import io
import os
import tarfile
import time
import wave
from concurrent.futures import ThreadPoolExecutor

from raim_preprocess import has_speakable_text, raim_preprocess
from voice_style import build_style_vector, load_emotion_map, resolve_voice

SCHEMA_VERSION = 1
REQUEST_TYPE = "tts.synthesize"
WARMUP_TYPE = "tts.warmup"
SUCCESS_TYPE = "tts.synthesized"
WARMED_TYPE = "tts.warmed"
ERROR_TYPE = "tts.error"

MODEL_ROOT = os.environ.get("MODEL_ROOT", "/tmp/raim_models")
TAR_NAME = "raim_models.tar"
SRC_DIR = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("OPEN_JTALK_DICT_DIR", os.path.join(MODEL_ROOT, "open_jtalk_dic"))
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
os.environ.setdefault("HF_HOME", "/tmp/hf")


def _env_int(name, default):
    try:
        value = int(os.environ.get(name, ""))
        return value if value > 0 else default
    except ValueError:
        return default


def _env_float(name, default):
    try:
        return float(os.environ.get(name, ""))
    except ValueError:
        return default


MAX_TEXT_CHARS = _env_int("MAX_TEXT_CHARS", 200)
# S3 から tar を何本に分けて同時に落とすか（1 なら1本で順に読む）
DOWNLOAD_PARALLEL = _env_int("MODEL_DOWNLOAD_PARALLEL", 1)  # Lambda で測ると 1本 9.3秒 / 8本 11.4秒（2026-11-23）
DOWNLOAD_PART_BYTES = _env_int("MODEL_DOWNLOAD_PART_MB", 64) * 1024 * 1024
# 感情の強さが低くても、この割合までは感情を残す（voice_style.py）
EMOTION_MIN_STRENGTH = _env_float("EMOTION_MIN_STRENGTH", 0.5)

_STATE = {
    "model": None,
    "lang": None,
    "emotion_map": None,
    "download_sec": None,
    "load_sec": None,
    "init_error": None,
}


# ----------------------------------------------------------------------------
# モデルの取得と読み込み
# ----------------------------------------------------------------------------

def _s3_location():
    bucket = os.environ["MODEL_S3_BUCKET"]
    prefix = os.environ.get("MODEL_S3_PREFIX", "").strip("/")
    key = f"{prefix}/{TAR_NAME}" if prefix else TAR_NAME
    return bucket, key


def _download_tar_bytes(s3, bucket, key, parallel=DOWNLOAD_PARALLEL, part_bytes=DOWNLOAD_PART_BYTES):
    """tar を範囲指定で分けて同時に落とし、1つの bytes にする。

    1本で落とすと約9秒かかっていた（794MB）。冷えた状態の最初の声を早くするため、分けて同時に落とす。
    """
    size = int(s3.head_object(Bucket=bucket, Key=key)["ContentLength"])
    ranges = [(start, min(start + part_bytes, size) - 1) for start in range(0, size, part_bytes)]
    buffer = bytearray(size)

    def fetch(byte_range):
        start, end = byte_range
        body = s3.get_object(Bucket=bucket, Key=key, Range=f"bytes={start}-{end}")["Body"]
        data = body.read()
        if len(data) != end - start + 1:
            raise IOError(f"short read: {start}-{end} got {len(data)} bytes")
        buffer[start:end + 1] = data

    with ThreadPoolExecutor(max_workers=max(1, parallel)) as pool:
        list(pool.map(fetch, ranges))
    return bytes(buffer)


def _open_tar_stream():
    local = os.environ.get("MODEL_LOCAL_TAR")
    if local:
        return open(local, "rb")
    import boto3

    bucket, key = _s3_location()
    # このクライアントは読み込みの中だけで使い、捨てる（スナップショットに接続を持ち越さない）
    s3 = boto3.client("s3")
    if DOWNLOAD_PARALLEL > 1:
        return io.BytesIO(_download_tar_bytes(s3, bucket, key))
    body = s3.get_object(Bucket=bucket, Key=key)["Body"]
    return body._raw_stream if hasattr(body, "_raw_stream") else body


def _extract_models(stream, root=MODEL_ROOT):
    """tar を読みながら、.onnx はメモリ（bytes）へ、それ以外は root へ。{実際のパス: bytes} を返す。"""
    os.makedirs(root, exist_ok=True)
    real_root = os.path.realpath(root)
    in_memory = {}
    with tarfile.open(fileobj=stream, mode="r|") as archive:
        for member in archive:
            dest = os.path.realpath(os.path.join(root, member.name))
            if not dest.startswith(real_root + os.sep):
                continue  # tar の外へ書くような名前は無視
            if member.isdir():
                os.makedirs(dest, exist_ok=True)
                continue
            if not member.isfile():
                continue
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            source = archive.extractfile(member)
            if member.name.endswith(".onnx"):
                in_memory[dest] = source.read()
                open(dest, "wb").close()  # 名前で探す処理のために、中身なしの目印だけ置く
            else:
                with open(dest, "wb") as out:
                    while True:
                        chunk = source.read(1 << 20)
                        if not chunk:
                            break
                        out.write(chunk)
    return in_memory


def _user_dict_csv_path():
    """ライム用の読み辞書。USER_DICT_S3_KEY があれば S3 の最新版を使う（zip を作り直さずに足せる）。"""
    key = os.environ.get("USER_DICT_S3_KEY", "").strip()
    if key:
        try:
            import boto3

            path = "/tmp/raim_user_dict.csv"
            boto3.client("s3").download_file(os.environ["MODEL_S3_BUCKET"], key, path)
            return path
        except Exception as error:  # 読めなければ zip に入れた版を使う
            print(f"[TTS] user dict download failed, using bundled: {type(error).__name__}", flush=True)
    return os.path.join(SRC_DIR, "raim_user_dict.csv")


class _quiet_native_output:
    """C のライブラリが直接書く標準出力・標準エラーを、ブロックの間だけ捨てる。"""

    def __enter__(self):
        import sys

        sys.stdout.flush()
        sys.stderr.flush()
        self.saved = [os.dup(1), os.dup(2)]
        self.null = os.open(os.devnull, os.O_WRONLY)
        os.dup2(self.null, 1)
        os.dup2(self.null, 2)
        return self

    def __exit__(self, *exc):
        os.dup2(self.saved[0], 1)
        os.dup2(self.saved[1], 2)
        for fd in (*self.saved, self.null):
            os.close(fd)
        return False


def _install_user_dict():
    from style_bert_vits2.nlp.japanese import pyopenjtalk_worker as jtalk

    csv_path = _user_dict_csv_path()
    compiled = "/tmp/raim_user.dic"
    # .dic は pyopenjtalk のバージョンに依存するので、csv から現地で作る。
    # 作るときに「emitting double-array …」の進み具合がたくさん出てログが埋まるので、その間だけ出力を捨てる
    with _quiet_native_output():
        jtalk.mecab_dict_index(csv_path, compiled)
    jtalk.update_global_jtalk_with_user_dict(compiled)


def _load():
    started = time.perf_counter()
    stream = _open_tar_stream()
    try:
        in_memory = _extract_models(stream)
    finally:
        stream.close()
    _STATE["download_sec"] = time.perf_counter() - started

    loading = time.perf_counter()
    from pathlib import Path

    import onnxruntime
    from style_bert_vits2.constants import Languages
    from style_bert_vits2.nlp import onnx_bert_models
    from style_bert_vits2.tts_model import TTSModel

    # style_bert_vits2 は InferenceSession にパスを渡すので、メモリにあるモデルのパスなら bytes に差し替える
    original_session = onnxruntime.InferenceSession

    def session_from_memory(path_or_bytes, *args, **kwargs):
        if isinstance(path_or_bytes, (str, os.PathLike)):
            key = os.path.realpath(str(path_or_bytes))
            if key in in_memory:
                path_or_bytes = in_memory[key]
        return original_session(path_or_bytes, *args, **kwargs)

    model_dir = os.path.join(MODEL_ROOT, "raim_D1v4")
    bert_dir = os.path.join(MODEL_ROOT, "bert_int8")
    providers = [("CPUExecutionProvider", {"arena_extend_strategy": "kSameAsRequested"})]
    onnxruntime.InferenceSession = session_from_memory
    try:
        onnx_bert_models.load_model(Languages.JP, bert_dir, onnx_providers=providers)
        onnx_bert_models.load_tokenizer(Languages.JP, bert_dir)
        onnx_name = [name for name in os.listdir(model_dir) if name.endswith(".onnx")][0]
        model = TTSModel(
            model_path=Path(model_dir, onnx_name),
            config_path=Path(model_dir, "config.json"),
            style_vec_path=Path(model_dir, "style_vectors.npy"),
            device="cpu",
            onnx_providers=providers,
        )
        model.load()
    finally:
        onnxruntime.InferenceSession = original_session
    in_memory.clear()  # セッションが自分の分を持ったので、読んだ bytes は捨てる

    _install_user_dict()
    _STATE["emotion_map"] = load_emotion_map()
    # 準備運転（辞書の読み込みもここで済む）
    model.infer(text="テストです。", language=Languages.JP, style="neutral")
    _STATE["model"] = model
    _STATE["lang"] = Languages.JP
    _STATE["load_sec"] = time.perf_counter() - loading
    import gc

    gc.collect()
    print(
        f"[TTS] model loaded: download={_STATE['download_sec']:.2f}s load={_STATE['load_sec']:.2f}s",
        flush=True,
    )


def _ensure_loaded():
    """読み込み済みなら False、今読んだら True。"""
    if _STATE["model"] is not None:
        return False
    _load()
    return True


def _after_restore():
    # SnapStart のスナップショットから再開したとき、乱数を毎回同じにしないよう種をまき直す
    try:
        import numpy as np

        np.random.seed(int.from_bytes(os.urandom(4), "little"))
    except Exception:
        pass


try:
    from snapshot_restore_py import register_after_restore  # Lambda の Python ランタイムにある

    register_after_restore(_after_restore)
except Exception:
    pass

if os.environ.get("PRELOAD", "0") == "1":
    try:
        _load()
    except Exception as error:  # 初期化で失敗しても、呼び出し時にもう一度試す
        _STATE["init_error"] = type(error).__name__
        print(f"[TTS] init failed: {_STATE['init_error']}", flush=True)


# ----------------------------------------------------------------------------
# 合成
# ----------------------------------------------------------------------------

def _wav_bytes(sample_rate, audio):
    import numpy as np

    samples = np.asarray(audio)
    if samples.dtype != np.int16:
        if samples.size and np.abs(samples).max() <= 1.0:
            samples = np.clip(samples, -1, 1) * 32767
        samples = samples.astype(np.int16)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(int(sample_rate))
        out.writeframes(samples.tobytes())
    return buffer.getvalue()


def synthesize(model, language, emotion_map, text, voice_params):
    """文を音声（wav の bytes）にする。voice は決めた話し方（ログ用）。"""
    voice_params = voice_params if isinstance(voice_params, dict) else {}
    voice = resolve_voice(
        emotion_map,
        voice_params.get("emotionMix"),
        voice_params.get("emotionIntensity"),
        EMOTION_MIN_STRENGTH,
    )
    vector = build_style_vector(model.style_vectors, model.style2id, voice["style_weights"])

    # TTSModel.infer はスタイル名からベクトルを作るので、混ぜたベクトルを返すよう一時的に差し替える
    original = model.get_style_vector
    model.get_style_vector = lambda *args, **kwargs: vector
    try:
        sample_rate, audio = model.infer(
            text=text,
            language=language,
            style="neutral",
            length=voice["length"],
            sdp_ratio=voice["sdp_ratio"],
            noise=voice["noise"],
        )
    finally:
        model.get_style_vector = original
    return _wav_bytes(sample_rate, audio), voice


def _error(request_id, chunk_id, code, message, retriable):
    response = {
        "schemaVersion": SCHEMA_VERSION,
        "type": ERROR_TYPE,
        "ok": False,
        "code": code,
        "message": message,
        "retriable": retriable,
    }
    if request_id:
        response["requestId"] = request_id
    if chunk_id:
        response["chunkId"] = chunk_id
    return response


def handler(event, context=None):
    event = event if isinstance(event, dict) else {}
    message_type = event.get("type")

    if message_type == WARMUP_TYPE:
        try:
            cold = _ensure_loaded()
        except Exception as error:
            print(f"[TTS] warmup load failed: {type(error).__name__}", flush=True)
            return _error(None, None, "MODEL_LOAD_FAILED", "Failed to load the voice model", True)
        return {
            "schemaVersion": SCHEMA_VERSION,
            "type": WARMED_TYPE,
            "ok": True,
            "cold": cold,
            "downloadSec": round(_STATE["download_sec"] or 0, 2),
            "loadSec": round(_STATE["load_sec"] or 0, 2),
        }

    request_id = str(event.get("requestId") or "").strip()
    chunk_id = str(event.get("chunkId") or "").strip()

    if event.get("schemaVersion") != SCHEMA_VERSION:
        return _error(request_id, chunk_id, "UNSUPPORTED_SCHEMA_VERSION", "Unsupported schema version", False)
    if message_type != REQUEST_TYPE:
        return _error(request_id, chunk_id, "UNSUPPORTED_MESSAGE_TYPE", "Unsupported message type", False)
    if not request_id or not chunk_id:
        return _error(request_id, chunk_id, "INVALID_REQUEST", "requestId and chunkId are required", False)

    text = event.get("text")
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_TEXT_CHARS:
        return _error(request_id, chunk_id, "INVALID_TEXT", "Invalid text", False)

    spoken = raim_preprocess(text)
    if not has_speakable_text(spoken):
        # 「www」だけ などで読むものが無い。やり直しても同じなので retriable にしない
        return _error(request_id, chunk_id, "NOTHING_TO_SPEAK", "No speakable text", False)

    try:
        cold = _ensure_loaded()
    except Exception as error:
        print(f"[TTS] load failed: {type(error).__name__}", flush=True)
        return _error(request_id, chunk_id, "MODEL_LOAD_FAILED", "Failed to load the voice model", True)

    started = time.perf_counter()
    try:
        audio, voice = synthesize(
            _STATE["model"], _STATE["lang"], _STATE["emotion_map"], spoken, event.get("voiceParams")
        )
    except Exception as error:
        print(f"[TTS] synthesis failed: {type(error).__name__} chars={len(spoken)}", flush=True)
        return _error(request_id, chunk_id, "SYNTHESIS_FAILED", "Failed to synthesize", True)

    print(
        f"[TTS] chunk={chunk_id} chars={len(spoken)} cold={cold} sec={time.perf_counter() - started:.2f} "
        f"mix={voice['mix']} strength={voice['strength']} bytes={len(audio)}",
        flush=True,
    )
    return {
        "schemaVersion": SCHEMA_VERSION,
        "type": SUCCESS_TYPE,
        "ok": True,
        "requestId": request_id,
        "chunkId": chunk_id,
        "format": "wav",
        "contentType": "audio/wav",
        "audio": base64.b64encode(audio).decode("ascii"),
        "audioByteLength": len(audio),
    }
