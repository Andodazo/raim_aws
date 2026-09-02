'use strict';

// ============================================================================
// TTS Lambda client
// ============================================================================
//
// Core Lambdaから、VOICEVOX Coreを実行するTTS Lambdaを同期Invokeする。
// 呼び出し先が未設定のローカル実行ではnullを返し、既存のテキスト専用動作を
// 維持できるようにする。

const {
  LambdaClient,
  InvokeCommand,
} = require('@aws-sdk/client-lambda');

function createTtsClient({ client, env = process.env } = {}) {
  const functionName = String(env.TTS_FUNCTION_NAME || '').trim();

  if (!functionName) {
    return null;
  }

  const lambdaClient = client || new LambdaClient({
    region: env.AWS_REGION || 'ap-northeast-1',
  });

  async function synthesize({ requestId, chunkId, text, voiceParams }) {
    const command = new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'RequestResponse',
      LogType: 'None',
      Payload: Buffer.from(JSON.stringify({
        schemaVersion: 1,
        type: 'tts.synthesize',
        requestId: String(requestId),
        chunkId: String(chunkId),
        text: String(text),
        voiceParams,
      })),
    });

    const result = await lambdaClient.send(command);

    if (result.FunctionError) {
      const error = new Error(`TTS Lambda invocation failed: ${result.FunctionError}`);
      error.code = 'TTS_LAMBDA_ERROR';
      error.retriable = true;
      throw error;
    }

    const payloadText = Buffer.from(result.Payload || []).toString('utf8');
    let response;

    try {
      response = JSON.parse(payloadText);
    } catch (cause) {
      const error = new Error('TTS Lambda returned invalid JSON');
      error.code = 'TTS_INVALID_RESPONSE';
      error.retriable = true;
      error.cause = cause;
      throw error;
    }

    if (response?.ok !== true || typeof response.audio !== 'string' || !response.audio) {
      const error = new Error(
        String(response?.message || 'TTS Lambda returned an unsuccessful response')
      );
      error.code = String(response?.code || 'TTS_ERROR');
      error.retriable = Boolean(response?.retriable);
      throw error;
    }

    return response;
  }

  return {
    functionName,
    synthesize,
  };
}

module.exports = {
  createTtsClient,
};
