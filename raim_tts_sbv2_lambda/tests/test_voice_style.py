import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

import numpy as np  # noqa: E402

from voice_style import build_style_vector, load_emotion_map, normalize_mix, resolve_voice  # noqa: E402

EMOTION_MAP = load_emotion_map()
CORE_EMOTIONS = [
    "neutral", "thoughtful", "caring", "happy", "excited", "amused",
    "playful", "curious", "surprised", "sad", "angry", "embarrassed",
]


class EmotionMapTest(unittest.TestCase):
    def test_core_の12感情が全部ある(self):
        for name in CORE_EMOTIONS:
            self.assertIn(name, EMOTION_MAP)

    def test_話し方の値が安全な範囲(self):
        for name, entry in EMOTION_MAP.items():
            self.assertTrue(0.8 <= entry["length"] <= 1.3, name)
            self.assertTrue(0.0 <= entry["sdp_ratio"] <= 1.0, name)
            self.assertTrue(0.3 <= entry["noise"] <= 1.0, name)


class ResolveVoiceTest(unittest.TestCase):
    def test_感情が無ければ_neutral(self):
        voice = resolve_voice(EMOTION_MAP, None, None)
        self.assertEqual(voice["mix"], {"neutral": 1.0})
        self.assertEqual(voice["length"], 1.0)
        self.assertEqual(voice["style_weights"], {"neutral": 1.0})

    def test_強さ1なら表の値そのまま(self):
        voice = resolve_voice(EMOTION_MAP, {"sad": 1.0}, 1.0)
        self.assertEqual(voice["length"], EMOTION_MAP["sad"]["length"])
        self.assertEqual(voice["noise"], EMOTION_MAP["sad"]["noise"])
        self.assertEqual(voice["style_weights"], {"sad": 1.0})

    def test_混ぜた感情は重みで平均する(self):
        voice = resolve_voice(EMOTION_MAP, {"happy": 0.6, "embarrassed": 0.3}, 1.0)
        self.assertAlmostEqual(voice["mix"]["happy"], 0.667, places=3)
        expected_length = EMOTION_MAP["happy"]["length"] * 2 / 3 + EMOTION_MAP["embarrassed"]["length"] / 3
        self.assertAlmostEqual(voice["length"], expected_length, places=3)
        # happy は happy の分と embarrassed の中の happy の分
        expected_happy = 2 / 3 * 1.0 * 1.0 + 1 / 3 * 0.9 * 0.5
        self.assertAlmostEqual(voice["style_weights"]["happy"], expected_happy, places=3)
        self.assertIn("sad", voice["style_weights"])

    def test_強さが低いと_neutral_に近づくが_最低限は残す(self):
        full = resolve_voice(EMOTION_MAP, {"sad": 1.0}, 1.0)
        low = resolve_voice(EMOTION_MAP, {"sad": 1.0}, 0.0, min_strength=0.5)
        self.assertEqual(low["strength"], 0.5)
        self.assertAlmostEqual(low["style_weights"]["sad"], 0.5)
        self.assertLess(low["length"], full["length"])
        self.assertGreater(low["length"], EMOTION_MAP["neutral"]["length"])

    def test_知らない感情や変な値は捨てるか_neutral_にする(self):
        mix = normalize_mix(EMOTION_MAP, {"confused": 0.5, "happy": "x", "sad": -1})
        self.assertEqual(mix, {"neutral": 1.0})
        self.assertEqual(normalize_mix(EMOTION_MAP, "happy"), {"neutral": 1.0})

    def test_core_の名前_surprised_はスタイル_surprise_になる(self):
        voice = resolve_voice(EMOTION_MAP, {"surprised": 1.0}, 1.0)
        self.assertEqual(voice["style_weights"], {"surprise": 1.0})


class BuildStyleVectorTest(unittest.TestCase):
    def test_mean_からの差を重みで足す(self):
        vectors = np.array([[1.0, 1.0], [2.0, 1.0], [1.0, 3.0]])
        style2id = {"Neutral": 0, "happy": 1, "sad": 2}
        vector = build_style_vector(vectors, style2id, {"happy": 0.5, "sad": 1.0, "unknown": 9})
        np.testing.assert_allclose(vector, [1.5, 3.0])
        # 元の配列は変えない
        np.testing.assert_allclose(vectors[0], [1.0, 1.0])


if __name__ == "__main__":
    unittest.main()
