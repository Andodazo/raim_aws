# Core が送る感情の混ぜ方（voiceParams.emotionMix / emotionIntensity）から、
# 声のスタイルの混ぜ方と話し方（length / sdp_ratio / noise）を決める。
#
# VOICEVOX（つむぎ）は感情ごとの声色が無いので、一番大きい感情1つを数字で調整していた。
# 自作の声は5つのスタイル（neutral/happy/surprise/sad/angry）を持つので、
# emotion_map.json の「感情 → スタイルの混ぜ方」を、Core が出した重みで足し合わせる。
# 例：{"happy": 0.6, "embarrassed": 0.3} なら happy と embarrassed の設定を 2:1 で混ぜる。
#
# 強さ（emotionIntensity）は、neutral からどれだけ離れるかに使う。
# 安藤さんが試聴して決めたサンプルは強さ 1.0 で作ったので、強さが低くても
# MIN_STRENGTH までは感情を残す（0 にすると VOICEVOX と同じく neutral まで戻る）。
import json
import os

STYLE_NAMES = ("neutral", "happy", "surprise", "sad", "angry")
DEFAULT_MIN_STRENGTH = 0.5


def load_emotion_map(path=None):
    path = path or os.path.join(os.path.dirname(os.path.abspath(__file__)), "emotion_map.json")
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    emotions = data["emotions"]
    if "neutral" not in emotions:
        raise ValueError("emotion_map.json に neutral がありません")
    for name, entry in emotions.items():
        for style in entry["mix"]:
            if style not in STYLE_NAMES:
                raise ValueError(f"emotion_map.json の {name} に知らないスタイル {style} があります")
    return emotions


def _clamp01(value, fallback):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if number != number:  # NaN
        return fallback
    return max(0.0, min(1.0, number))


def normalize_mix(emotion_map, emotion_mix):
    """知っている感情だけ残して、合計 1 にする。何も無ければ neutral。"""
    weights = {}
    if isinstance(emotion_mix, dict):
        for name, value in emotion_mix.items():
            weight = _clamp01(value, 0.0)
            if weight <= 0:
                continue
            key = name if name in emotion_map else "neutral"
            weights[key] = weights.get(key, 0.0) + weight
    total = sum(weights.values())
    if total <= 0:
        return {"neutral": 1.0}
    return {name: weight / total for name, weight in weights.items()}


def resolve_voice(emotion_map, emotion_mix=None, intensity=None, min_strength=DEFAULT_MIN_STRENGTH):
    """スタイルの重み（{スタイル名: 重み}）と length / sdp_ratio / noise を返す。"""
    mix = normalize_mix(emotion_map, emotion_mix)
    min_strength = _clamp01(min_strength, DEFAULT_MIN_STRENGTH)
    strength = min_strength + (1.0 - min_strength) * _clamp01(intensity, 1.0)

    style_weights = {}
    for name, weight in mix.items():
        entry = emotion_map[name]
        for style, style_mix in entry["mix"].items():
            style_weights[style] = style_weights.get(style, 0.0) + (
                weight * float(entry.get("style_weight", 1.0)) * float(style_mix) * strength
            )

    neutral = emotion_map["neutral"]

    def blend(key, default):
        base = float(neutral.get(key, default))
        target = sum(float(emotion_map[name].get(key, base)) * weight for name, weight in mix.items())
        return round(base + (target - base) * strength, 3)

    return {
        "mix": {name: round(weight, 3) for name, weight in mix.items()},
        "strength": round(strength, 3),
        "style_weights": {style: round(w, 4) for style, w in style_weights.items()},
        "length": blend("length", 1.0),
        "sdp_ratio": blend("sdp_ratio", 0.2),
        "noise": blend("noise", 0.6),
    }


def build_style_vector(style_vectors, style2id, style_weights, mean_key="Neutral"):
    """mean + Σ 重み × (スタイル − mean)。

    style_vectors[0]（style2id の "Neutral"、大文字）は全体の平均。
    小文字の "neutral" は学習した感情の1つで、別物。
    """
    import numpy as np

    vectors = np.asarray(style_vectors)
    mean_index = style2id.get(mean_key, 0)
    mean = vectors[mean_index]
    vector = mean.copy()
    for style, weight in style_weights.items():
        if style not in style2id:
            continue
        vector = vector + (vectors[style2id[style]] - mean) * float(weight)
    return vector
