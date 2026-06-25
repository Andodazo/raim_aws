'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  StreamingChatJsonExtractor,
} = require('../lib/streaming-chat-json-extractor');

test('extracts only the text value across arbitrary JSON chunks', async () => {
  const outputs = [];
  const extractor = new StreamingChatJsonExtractor({
    onText: async (text) => outputs.push(text),
  });

  await extractor.push('```json\n{"te');
  await extractor.push('xt":"こん');
  await extractor.push('にちは\\n次');
  await extractor.push('です","emotion":"happy"}');

  assert.equal(outputs.join(''), 'こんにちは\n次です');
});

test('decodes JSON unicode escapes split across chunks', async () => {
  const outputs = [];
  const extractor = new StreamingChatJsonExtractor({
    onText: async (text) => outputs.push(text),
  });

  await extractor.push('{"text":"\\u30');
  await extractor.push('e9\\u30');
  await extractor.push('a4\\u30e0"}');

  assert.equal(outputs.join(''), 'ライム');
});
