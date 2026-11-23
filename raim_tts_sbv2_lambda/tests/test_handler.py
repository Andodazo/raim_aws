import base64
import io
import os
import sys
import tarfile
import unittest
import wave

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

import numpy as np  # noqa: E402

import handler  # noqa: E402
from voice_style import load_emotion_map  # noqa: E402


class FakeModel:
    """TTSModel の代わり。infer に渡された値と、そのときのスタイルベクトルを覚える。"""

    def __init__(self):
        self.style_vectors = np.array([[0.0, 0.0], [1.0, 0.0], [0.0, 1.0], [1.0, 1.0], [2.0, 0.0], [0.0, 2.0]])
        self.style2id = {"Neutral": 0, "neutral": 1, "happy": 2, "surprise": 3, "sad": 4, "angry": 5}
        self.calls = []

    def get_style_vector(self, style_id, weight=1.0):
        return self.style_vectors[style_id]

    def infer(self, text, language, style, length, sdp_ratio, noise):
        vector = self.get_style_vector(self.style2id[style], 1.0)
        self.calls.append(dict(text=text, length=length, sdp_ratio=sdp_ratio, noise=noise, vector=vector))
        return 44100, np.zeros(4410, dtype=np.float32)


def request(**overrides):
    body = {
        "schemaVersion": 1,
        "type": "tts.synthesize",
        "requestId": "req-1",
        "chunkId": "req-1_chunk_0",
        "text": "今日は25℃だって。",
        "voiceParams": {"speaker_id": 8, "emotionMix": {"sad": 1.0}, "emotionIntensity": 1.0},
    }
    body.update(overrides)
    return body


class HandlerTest(unittest.TestCase):
    def setUp(self):
        self.model = FakeModel()
        self.saved = dict(handler._STATE)
        handler._STATE.update(model=self.model, lang="JP", emotion_map=load_emotion_map())

    def tearDown(self):
        handler._STATE.clear()
        handler._STATE.update(self.saved)

    def test_core_と同じ形で_wav_を返す(self):
        response = handler.handler(request())
        self.assertTrue(response["ok"])
        self.assertEqual(response["type"], "tts.synthesized")
        self.assertEqual(response["requestId"], "req-1")
        self.assertEqual(response["chunkId"], "req-1_chunk_0")
        self.assertEqual(response["format"], "wav")
        self.assertEqual(response["contentType"], "audio/wav")
        audio = base64.b64decode(response["audio"])
        self.assertEqual(len(audio), response["audioByteLength"])
        with wave.open(io.BytesIO(audio)) as wav:
            self.assertEqual(wav.getframerate(), 44100)
            self.assertEqual(wav.getnframes(), 4410)

    def test_前処理してから読み_感情でスタイルと速さが変わる(self):
        handler.handler(request())
        call = self.model.calls[0]
        self.assertEqual(call["text"], "今日は25度だって。")
        np.testing.assert_allclose(call["vector"], [2.0, 0.0])  # sad そのもの
        self.assertEqual(call["length"], 1.12)
        # 差し替えたスタイルは元に戻す
        np.testing.assert_allclose(self.model.get_style_vector(2), [0.0, 1.0])

    def test_感情が無い_voicevox_用の値だけでも読める(self):
        response = handler.handler(request(voiceParams={"speaker_id": 8, "speedScale": 1.0}))
        self.assertTrue(response["ok"])
        np.testing.assert_allclose(self.model.calls[0]["vector"], [1.0, 0.0])  # neutral

    def test_入力が変ならエラー(self):
        cases = [
            (request(schemaVersion=2), "UNSUPPORTED_SCHEMA_VERSION"),
            (request(type="tts.other"), "UNSUPPORTED_MESSAGE_TYPE"),
            (request(chunkId=""), "INVALID_REQUEST"),
            (request(text=""), "INVALID_TEXT"),
            (request(text="あ" * 201), "INVALID_TEXT"),
            (request(text="www"), "NOTHING_TO_SPEAK"),
        ]
        for body, code in cases:
            with self.subTest(code=code):
                response = handler.handler(body)
                self.assertFalse(response["ok"])
                self.assertEqual(response["type"], "tts.error")
                self.assertEqual(response["code"], code)
                self.assertFalse(response["retriable"])
        self.assertEqual(self.model.calls, [])

    def test_合成に失敗したら再試行できるエラー(self):
        def broken(**kwargs):
            raise RuntimeError("boom")

        self.model.infer = broken
        response = handler.handler(request())
        self.assertEqual(response["code"], "SYNTHESIS_FAILED")
        self.assertTrue(response["retriable"])

    def test_温めはモデルを読むだけ(self):
        handler._STATE["model"] = None
        loaded = []
        original = handler._load
        handler._load = lambda: (loaded.append(True), handler._STATE.update(model=self.model))
        try:
            first = handler.handler({"schemaVersion": 1, "type": "tts.warmup"})
            second = handler.handler({"schemaVersion": 1, "type": "tts.warmup"})
        finally:
            handler._load = original
        self.assertTrue(first["ok"])
        self.assertEqual(first["type"], "tts.warmed")
        self.assertTrue(first["cold"])
        self.assertFalse(second["cold"])
        self.assertEqual(len(loaded), 1)
        self.assertEqual(self.model.calls, [])

    def test_読み込みに失敗したら再試行できるエラー(self):
        handler._STATE["model"] = None
        original = handler._load

        def fail():
            raise OSError("s3 down")

        handler._load = fail
        try:
            response = handler.handler(request())
        finally:
            handler._load = original
        self.assertEqual(response["code"], "MODEL_LOAD_FAILED")
        self.assertTrue(response["retriable"])


class FakeBody:
    def __init__(self, data):
        self.data = data

    def read(self):
        return self.data


class FakeS3:
    def __init__(self, data):
        self.data = data
        self.ranges = []

    def head_object(self, Bucket, Key):
        return {"ContentLength": len(self.data)}

    def get_object(self, Bucket, Key, Range):
        start, end = (int(x) for x in Range.replace("bytes=", "").split("-"))
        self.ranges.append((start, end))
        return {"Body": FakeBody(self.data[start:end + 1])}


class DownloadTest(unittest.TestCase):
    def test_分けて同時に落としても元と同じになる(self):
        data = bytes(range(256)) * 1000 + b"tail"
        s3 = FakeS3(data)
        result = handler._download_tar_bytes(s3, "bucket", "key", parallel=4, part_bytes=10000)
        self.assertEqual(result, data)
        self.assertEqual(len(s3.ranges), 26)

    def test_tar_の_onnx_はメモリへ_ほかはファイルへ(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w") as archive:
            for name, content in (("raim_D1v4/model.onnx", b"onnx"), ("raim_D1v4/config.json", b"{}"), ("../evil", b"x")):
                info = tarfile.TarInfo(name)
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
        buffer.seek(0)
        import tempfile

        with tempfile.TemporaryDirectory() as root:
            in_memory = handler._extract_models(buffer, root)
            onnx_path = os.path.realpath(os.path.join(root, "raim_D1v4", "model.onnx"))
            self.assertEqual(in_memory, {onnx_path: b"onnx"})
            self.assertEqual(os.path.getsize(onnx_path), 0)
            with open(os.path.join(root, "raim_D1v4", "config.json"), "rb") as f:
                self.assertEqual(f.read(), b"{}")
            self.assertFalse(os.path.exists(os.path.join(os.path.dirname(root), "evil")))


if __name__ == "__main__":
    unittest.main()


class BuildZipTest(unittest.TestCase):
    def test_1ファイルのモジュールもパッケージ名で判定する(self):
        sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build"))
        from build_zip import DROP, package_name

        for entry, expected in (
            ("snapshot_restore_py.py", "snapshot_restore_py"),
            ("runtime_client.cpython-312-x86_64-linux-gnu.so", "runtime_client"),
            ("numba-0.60.0.dist-info", "numba"),
            ("onnxruntime", "onnxruntime"),
            ("six.py", "six"),
        ):
            self.assertEqual(package_name(entry), expected)
        self.assertIn(package_name("snapshot_restore_py.py"), DROP)
        self.assertIn(package_name("runtime_client.cpython-312-x86_64-linux-gnu.so"), DROP)


class QuietOutputTest(unittest.TestCase):
    def test_ブロックのあとは出力が戻る(self):
        with handler._quiet_native_output():
            os.write(1, b"hidden\n")
        self.assertTrue(os.fstat(1))
