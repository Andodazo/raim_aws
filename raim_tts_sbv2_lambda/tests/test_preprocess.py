import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from raim_preprocess import has_speakable_text, raim_preprocess  # noqa: E402


class PreprocessTest(unittest.TestCase):
    def test_記号と数字を言葉にする(self):
        cases = {
            "それな www": "それな",
            "ｗｗｗ": "",
            "草w。": "草。",
            "今日は25℃だって": "今日は25度だって",
            "明日は-2度": "明日はマイナス2度",
            "降水確率90%": "降水確率90パーセント",
            "1/3くらい": "3ぶんの1くらい",
            "3〜4人": "3から4人",
            "2024/11/23に行く": "2024年11月23日に行く",
            "11/23は休み": "11月23日は休み",
            "15:30に集合": "15時30分に集合",
            "10:00から": "10時から",
        }
        for source, expected in cases.items():
            with self.subTest(source=source):
                self.assertEqual(raim_preprocess(source), expected)

    def test_英単語の_w_は消さない(self):
        for text in ("Wi-Fiとwebを見た", "I want it", "wwwの話"):
            self.assertEqual(raim_preprocess(text), text)

    def test_誘いのくり返しは区切る(self):
        cases = {
            "行こっか。飲も飲も。": "行こっか。飲も！飲も！",
            "遊ぼ遊ぼ！": "遊ぼ！遊ぼ！",
            "食べよ食べよ、ね": "食べよ！食べよ！ね",
            "帰ろ帰ろ？": "帰ろ！帰ろ？",
        }
        for source, expected in cases.items():
            with self.subTest(source=source):
                self.assertEqual(raim_preprocess(source), expected)

    def test_かなだけのくり返しは変えない(self):
        for text in ("そろそろ寝よ", "まあまあだね", "ねえねえ", "行こう行こう"):
            self.assertEqual(raim_preprocess(text), text)

    def test_読むものがあるか(self):
        self.assertTrue(has_speakable_text("はい"))
        self.assertTrue(has_speakable_text("3"))
        self.assertFalse(has_speakable_text("！？…"))
        self.assertFalse(has_speakable_text(raim_preprocess("www")))


if __name__ == "__main__":
    unittest.main()
