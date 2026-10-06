'use strict';

// ==============================================================================
// Streaming Chat JSON Text Extractor
// ==============================================================================
//
// Mantleには最終的に次のJSONを返すよう指示している。
//
// {
//   "text": "ユーザーへ表示する回答",
//   "emotion": "happy",
//   "intensity": 0.6
// }
//
// ただし、SSEのresponse.output_text.deltaはJSON全体を小さな断片で返す。
// その断片をそのままWebSocketへ送ると、ユーザー画面に `{"text":"` などの
// JSON構文まで表示されてしまう。
//
// このクラスは、届いた断片からtext文字列の中身だけを逐次取り出す。
//
// emotions も途中で取り出す（onEmotions）。
// 以前は感情が stream.completed（本文と音声を全部送り終えた後）でしか届かず、
// 立ち絵の表情が変わるのが喋り終わる頃になっていた。
// プロンプトで emotions を text より先に出させ、ここで見つけた時点で通知する。
// 最終的なJSONの妥当性検証はresponse-validator.jsが行うため、ここでは
// ストリーミング表示に必要な最小限の文字列抽出だけを担当する。
// ==============================================================================

const TEXT_FIELD_PATTERN = /"text"\s*:\s*"/;
const MAX_SEEK_BUFFER_LENGTH = 256;

// emotions は入れ子の無いオブジェクトなので、閉じ括弧までを1つで取れる
const EMOTIONS_PATTERN = /"emotions"\s*:\s*(\{[^{}]*\})/;
const OVERALL_PATTERN = /"overall_intensity"\s*:\s*([0-9.]+)/;
// emotions を探す間だけ生の断片を溜める。異常に長い出力でも増え続けないよう上限を置く
const MAX_EMOTION_BUFFER_LENGTH = 8000;

class StreamingChatJsonExtractor {
  constructor({ onText, onEmotions } = {}) {
    this.onText = onText;
    this.onEmotions = onEmotions;
    this.state = 'seeking-text-field';
    this.seekBuffer = '';
    this.escapePending = false;
    this.unicodeDigits = null;
    this.emotionBuffer = '';
    this.emotionsEmitted = false;
  }

  /**
   * emotions が見つかっていれば一度だけ通知する。
   *
   * force=false のときは、overall_intensity が来るかもしれないので、
   * text が始まる（＝emotions 側が書き終わった）まで待つ。
   */
  async maybeEmitEmotions({ force = false } = {}) {
    if (this.emotionsEmitted || typeof this.onEmotions !== 'function') {
      return;
    }

    const match = EMOTIONS_PATTERN.exec(this.emotionBuffer);
    if (!match) {
      return;
    }

    const overallMatch = OVERALL_PATTERN.exec(this.emotionBuffer);
    if (!force && this.state === 'seeking-text-field' && !overallMatch) {
      return;
    }

    let emotions;
    try {
      emotions = JSON.parse(match[1]);
    } catch {
      return;
    }

    this.emotionsEmitted = true;
    this.emotionBuffer = '';

    const overall = overallMatch ? Number(overallMatch[1]) : undefined;
    await this.onEmotions({
      emotions,
      overall_intensity: Number.isFinite(overall) ? overall : undefined,
    });
  }

  /**
   * Mantleから届いたraw JSON断片を追加する。
   *
   * @returns {string} 今回の断片から新しく抽出できた表示用テキスト。
   */
  async push(chunk) {
    let input = String(chunk || '');

    if (!this.emotionsEmitted && typeof this.onEmotions === 'function') {
      this.emotionBuffer = (this.emotionBuffer + input).slice(-MAX_EMOTION_BUFFER_LENGTH);
    }

    if (this.state === 'done') {
      // text の後に emotions が来る（古い順番の）出力にも対応する
      await this.maybeEmitEmotions({ force: true });
      return '';
    }

    // text fieldの開始位置はchunkをまたぐ可能性があるため、見つかるまでbufferする。
    if (this.state === 'seeking-text-field') {
      this.seekBuffer += input;
      const match = TEXT_FIELD_PATTERN.exec(this.seekBuffer);

      if (!match) {
        // 異常な前置きが非常に長くてもメモリを増やし続けない。
        this.seekBuffer = this.seekBuffer.slice(-MAX_SEEK_BUFFER_LENGTH);
        return '';
      }

      input = this.seekBuffer.slice(match.index + match[0].length);
      this.seekBuffer = '';
      this.state = 'reading-text-value';

      // text が始まった＝先に書かれた emotions はもう揃っている。本文より先に通知する
      await this.maybeEmitEmotions({ force: true });
    }

    let extracted = '';

    for (const character of input) {
      if (this.unicodeDigits !== null) {
        this.unicodeDigits += character;

        if (this.unicodeDigits.length === 4) {
          const codePoint = Number.parseInt(this.unicodeDigits, 16);

          if (Number.isNaN(codePoint)) {
            throw new Error('Invalid Unicode escape in streamed Mantle JSON');
          }

          extracted += String.fromCharCode(codePoint);
          this.unicodeDigits = null;
        }

        continue;
      }

      if (this.escapePending) {
        this.escapePending = false;

        if (character === 'u') {
          this.unicodeDigits = '';
          continue;
        }

        const escapeMap = {
          '"': '"',
          '\\': '\\',
          '/': '/',
          b: '\b',
          f: '\f',
          n: '\n',
          r: '\r',
          t: '\t',
        };
        extracted += escapeMap[character] ?? character;
        continue;
      }

      if (character === '\\') {
        this.escapePending = true;
        continue;
      }

      if (character === '"') {
        this.state = 'done';
        break;
      }

      extracted += character;
    }

    if (extracted && typeof this.onText === 'function') {
      await this.onText(extracted);
    }

    // text の途中・後に emotions が届いた場合
    if (this.state !== 'seeking-text-field') {
      await this.maybeEmitEmotions({ force: true });
    }

    return extracted;
  }
}

module.exports = {
  StreamingChatJsonExtractor,
  TEXT_FIELD_PATTERN,
};
