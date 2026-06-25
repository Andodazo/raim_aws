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
// 最終的なJSONの妥当性検証はresponse-validator.jsが行うため、ここでは
// ストリーミング表示に必要な最小限の文字列抽出だけを担当する。
// ==============================================================================

const TEXT_FIELD_PATTERN = /"text"\s*:\s*"/;
const MAX_SEEK_BUFFER_LENGTH = 256;

class StreamingChatJsonExtractor {
  constructor({ onText } = {}) {
    this.onText = onText;
    this.state = 'seeking-text-field';
    this.seekBuffer = '';
    this.escapePending = false;
    this.unicodeDigits = null;
  }

  /**
   * Mantleから届いたraw JSON断片を追加する。
   *
   * @returns {string} 今回の断片から新しく抽出できた表示用テキスト。
   */
  async push(chunk) {
    if (this.state === 'done') {
      return '';
    }

    let input = String(chunk || '');

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

    return extracted;
  }
}

module.exports = {
  StreamingChatJsonExtractor,
  TEXT_FIELD_PATTERN,
};
