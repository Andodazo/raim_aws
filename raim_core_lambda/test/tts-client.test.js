'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { InvokeCommand } = require('@aws-sdk/client-lambda');
const { createTtsClient } = require('../lib/tts-client');

test('invokes TTS Lambda with the shared request contract', async () => {
  let command;
  const client = {
    send: async (value) => {
      command = value;
      return {
        Payload: Buffer.from(JSON.stringify({
          ok: true,
          type: 'tts.synthesized',
          requestId: 'req-1',
          chunkId: 'req-1_chunk_0',
          format: 'wav',
          contentType: 'audio/wav',
          audio: 'AAAA',
          audioByteLength: 3,
        })),
      };
    },
  };
  const tts = createTtsClient({
    client,
    env: {
      AWS_REGION: 'ap-northeast-1',
      TTS_FUNCTION_NAME: 'RAiM-TTS-Lambda-dev',
    },
  });

  const response = await tts.synthesize({
    requestId: 'req-1',
    chunkId: 'req-1_chunk_0',
    text: 'こんにちは。',
    voiceParams: { speaker_id: 8 },
  });

  assert.ok(command instanceof InvokeCommand);
  assert.equal(command.input.FunctionName, 'RAiM-TTS-Lambda-dev');
  assert.equal(command.input.InvocationType, 'RequestResponse');
  assert.deepEqual(JSON.parse(Buffer.from(command.input.Payload).toString()), {
    schemaVersion: 1,
    type: 'tts.synthesize',
    requestId: 'req-1',
    chunkId: 'req-1_chunk_0',
    text: 'こんにちは。',
    voiceParams: { speaker_id: 8 },
  });
  assert.equal(response.audio, 'AAAA');
});

test('returns null when TTS Lambda is not configured', () => {
  assert.equal(createTtsClient({ env: {} }), null);
});
