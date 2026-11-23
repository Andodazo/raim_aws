'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createResponseQueuePublisher,
} = require('../lib/response-queue-publisher');

test('publishes ordered FIFO stream events and buffers small deltas', async () => {
  const commands = [];
  const client = {
    send: async (command) => commands.push(command.input),
  };
  const publisher = createResponseQueuePublisher({
    requestId: 'req-1',
    connectionId: 'connection-1',
    sub: 'user-1',
    source: 'websocket',
  }, {
    client,
    env: {
      RESPONSE_QUEUE_URL: 'https://sqs.example/response.fifo',
      STREAM_CHUNK_MIN_CHARACTERS: '5',
    },
  });

  await publisher.start();
  await publisher.appendText('こん');
  await publisher.appendText('にちは');
  await publisher.completed({
    text: 'こんにちは',
    emotion: 'happy',
    intensity: 0.6,
  });

  const messages = commands.map((command) => JSON.parse(command.MessageBody));
  assert.deepEqual(messages.map((message) => message.type), [
    'stream.start',
    'stream.delta',
    'stream.completed',
  ]);
  assert.deepEqual(messages.map((message) => message.sequence), [0, 1, 2]);
  assert.equal(messages[1].textDelta, 'こんにちは');
  assert.equal(commands.every((command) => command.MessageGroupId === 'req-1'), true);
});

test('starts TTS per sentence and publishes audio in chunk order', async () => {
  const commands = [];
  const ttsCalls = [];
  const client = {
    send: async (command) => commands.push(command.input),
  };
  const publisher = createResponseQueuePublisher({
    requestId: 'req-tts',
    connectionId: 'connection-1',
    sub: 'user-1',
    source: 'websocket',
  }, {
    client,
    env: {
      RESPONSE_QUEUE_URL: 'https://sqs.example/response.fifo',
      STREAM_CHUNK_MIN_CHARACTERS: '1',
      STREAM_CHUNK_MAX_CHARACTERS: '30',
      TTS_AUDIO_FRAGMENT_BASE64_CHARACTERS: '8',
    },
    ttsClient: {
      synthesize: async (request) => {
        ttsCalls.push(request);
        return {
          ok: true,
          format: 'wav',
          contentType: 'audio/wav',
          audio: request.chunkId === 'req-tts_chunk_0' ? 'AAAAAAAAAA' : 'BBBB',
          audioByteLength: 8,
        };
      },
    },
    getVoiceParams: () => ({ speaker_id: 8 }),
  });

  await publisher.start();
  await publisher.appendText('こんにちは。');
  await publisher.appendText('元気です！');
  await publisher.completed({ text: 'こんにちは。元気です！' });

  const messages = commands.map((command) => JSON.parse(command.MessageBody));
  const textMessages = messages.filter((message) => message.type === 'stream.delta');
  const audioMessages = messages.filter((message) => message.type === 'stream.audio');

  assert.deepEqual(textMessages.map((message) => [message.textDelta, message.chunkId]), [
    ['こんにちは。', 'req-tts_chunk_0'],
    ['元気です！', 'req-tts_chunk_1'],
  ]);
  assert.deepEqual(ttsCalls.map((call) => call.chunkId), [
    'req-tts_chunk_0',
    'req-tts_chunk_1',
  ]);
  assert.deepEqual(audioMessages.map((message) => [
    message.chunkId,
    message.partIndex,
    message.partCount,
    message.isLast,
  ]), [
    ['req-tts_chunk_0', 0, 2, false],
    ['req-tts_chunk_0', 1, 2, true],
    ['req-tts_chunk_1', 0, 1, true],
  ]);
  assert.equal(messages.at(-1).type, 'stream.completed');
});

// ─────────────────────────────────────────────
// v14: bubble_break
// ─────────────────────────────────────────────

function makeCapturingPublisher() {
  const commands = [];
  const client = { send: async (command) => commands.push(command.input) };
  const publisher = createResponseQueuePublisher({
    requestId: 'req-1',
    connectionId: 'connection-1',
    sub: 'user-1',
    source: 'websocket',
  }, {
    client,
    env: {
      RESPONSE_QUEUE_URL: 'https://sqs.example/response.fifo',
      STREAM_CHUNK_MIN_CHARACTERS: '1',
    },
  });
  const types = () => commands.map((c) => JSON.parse(c.MessageBody).type);
  const bodies = () => commands.map((c) => JSON.parse(c.MessageBody));
  return { publisher, types, bodies };
}

test('v14: tool intro の後、本文deltaの直前に bubble_break が入る', async () => {
  const { publisher, types, bodies } = makeCapturingPublisher();

  await publisher.start();
  await publisher.toolCall({
    toolName: 'get_weather',
    description: '東京の天気を調べています',
    introText: '天気見てくる、ちょっと待って',
  });
  await publisher.appendText('東京は晴れだよ');
  await publisher.completed({
    text: '東京は晴れだよ',
    emotions: { happy: 1 },
    overall_intensity: 0.6,
    emotion: 'happy',
    intensity: 0.6,
  });

  assert.deepEqual(types(), [
    'stream.start',
    'stream.delta',        // intro
    'stream.tool',
    'stream.bubble_break',
    'stream.delta',        // 本文
    'stream.completed',
  ]);

  // introのdeltaには isFiller が付く
  const introDelta = bodies()[1];
  assert.equal(introDelta.isFiller, true);
});

test('v14: ツールを使わない通常会話では bubble_break を送らない', async () => {
  const { publisher, types } = makeCapturingPublisher();

  await publisher.start();
  await publisher.appendText('こんにちは！');
  await publisher.completed({
    text: 'こんにちは！',
    emotions: { happy: 1 },
    overall_intensity: 0.5,
    emotion: 'happy',
    intensity: 0.5,
  });

  assert.ok(!types().includes('stream.bubble_break'));
});

test('v14: bubble_break は1ターンにつき1回だけ', async () => {
  const { publisher, types } = makeCapturingPublisher();

  await publisher.start();
  await publisher.toolCall({
    toolName: 'web_search',
    description: '検索中',
    introText: 'ちょっと調べてみるね',
  });
  await publisher.appendText('調べた');
  await publisher.appendText('結果はこう');
  await publisher.completed({
    text: '調べた結果はこう',
    emotions: { curious: 1 },
    overall_intensity: 0.7,
    emotion: 'curious',
    intensity: 0.7,
  });

  const count = types().filter((t) => t === 'stream.bubble_break').length;
  assert.equal(count, 1);
});

// ツールの前置きセリフは「待ち時間を埋める発話」なので、
// ここが無音だと役割を果たさない。本文と同じく TTS に回す。
test('tool intro is synthesized like normal text', async () => {
  const commands = [];
  const ttsCalls = [];

  const publisher = createResponseQueuePublisher({
    requestId: 'req-intro',
    connectionId: 'connection-1',
    sub: 'user-1',
    source: 'websocket',
  }, {
    client: { send: async (command) => commands.push(command.input) },
    env: {
      RESPONSE_QUEUE_URL: 'https://sqs.example/response.fifo',
      TTS_AUDIO_FRAGMENT_BASE64_CHARACTERS: '8',
    },
    ttsClient: {
      synthesize: async (request) => {
        ttsCalls.push(request);
        return {
          ok: true,
          format: 'wav',
          contentType: 'audio/wav',
          audio: 'AAAA',
          audioByteLength: 3,
        };
      },
    },
  });

  await publisher.start();
  await publisher.toolCall({
    toolName: 'web_search',
    description: '検索中',
    introText: 'えっと、それ気になる。少し待って？',
  });
  await publisher.completed({ text: '調べたよ' });

  const messages = commands.map((command) => JSON.parse(command.MessageBody));
  const intro = messages.find((message) => message.isFiller);

  assert.ok(intro, 'filler の stream.delta が送られること');
  assert.equal(intro.chunkId, 'req-intro_chunk_0', 'filler にも chunkId が振られること');

  const introTts = ttsCalls.find((call) => call.chunkId === 'req-intro_chunk_0');
  assert.ok(introTts, '前置きも TTS に回ること');
  assert.equal(introTts.text, 'えっと、それ気になる。少し待って？');
});

test('clientAction sends stream.action without an intro or bubble_break', async () => {
  const { publisher, types, bodies } = makeCapturingPublisher();

  await publisher.start();
  // 駅アラームは前置きセリフ無し（introText が空）
  await publisher.toolCall({
    toolName: 'start_station_alarm',
    description: '駅アラームを準備しています',
    introText: '',
  });
  await publisher.clientAction({
    action: 'station_alarm.start',
    params: { station: '新宿' },
  });
  await publisher.appendText('新宿ね、了解');
  await publisher.completed({
    text: '新宿ね、了解',
    emotions: { caring: 1 },
    overall_intensity: 0.5,
    emotion: 'caring',
    intensity: 0.5,
  });

  // 本文の delta は文の区切りで複数に分かれることがあるので、まとめて見る
  const collapsed = types().filter((type, i, all) => type !== all[i - 1]);
  assert.deepEqual(collapsed, [
    'stream.start',
    'stream.tool',
    'stream.action',
    'stream.delta',
    'stream.completed',
  ]);

  const action = bodies()[2];
  assert.equal(action.action, 'station_alarm.start');
  assert.deepEqual(action.params, { station: '新宿' });
});

test('clientAction の actionId は要求ごとの通し番号で、やり直しても変わらない', async () => {
  async function actionIds(attempt) {
    const commands = [];
    const publisher = createResponseQueuePublisher({
      requestId: 'req-action',
      connectionId: 'connection-1',
      sub: 'user-1',
      attempt,
    }, {
      client: { send: async (command) => { commands.push(command.input); } },
      env: { RESPONSE_QUEUE_URL: 'https://sqs.example/response.fifo' },
    });
    await publisher.clientAction({ action: 'station_alarm.start', params: {} });
    await publisher.clientAction({ action: 'station_alarm.stop', params: {} });
    return commands.map((command) => JSON.parse(command.MessageBody).actionId);
  }

  const first = await actionIds(1);
  assert.deepEqual(first, ['req-action_action_0', 'req-action_action_1']);
  // SQS の再試行（attempt 2）でも同じ ID になる
  assert.deepEqual(await actionIds(2), first);
});

test('記号だけのかたまりは読み上げない（文字は送る）', async () => {
  const commands = [];
  const ttsCalls = [];
  const publisher = createResponseQueuePublisher({
    requestId: 'req-punct',
    connectionId: 'connection-1',
    sub: 'user-1',
    source: 'websocket',
  }, {
    client: { send: async (command) => commands.push(command.input) },
    env: {
      RESPONSE_QUEUE_URL: 'https://sqs.example/response.fifo',
      STREAM_CHUNK_MIN_CHARACTERS: '1',
      STREAM_CHUNK_MAX_CHARACTERS: '30',
    },
    ttsClient: {
      synthesize: async (request) => {
        ttsCalls.push(request);
        return { ok: true, format: 'wav', contentType: 'audio/wav', audio: 'AAAA', audioByteLength: 3 };
      },
    },
    getVoiceParams: () => ({ speaker_id: 8 }),
  });

  await publisher.start();
  await publisher.appendText('そうなの。');
  await publisher.appendText('？');
  await publisher.completed({ text: 'そうなの。？' });

  const messages = commands.map((command) => JSON.parse(command.MessageBody));
  const deltas = messages.filter((m) => m.type === 'stream.delta').map((m) => m.textDelta).join('');

  assert.equal(deltas, 'そうなの。？');
  assert.equal(ttsCalls.length, 1);
});

// ─────────────────────────────────────────────
// 文の区切り方（言葉の途中で切らない）
// ─────────────────────────────────────────────

function makeChunkPublisher(env = {}) {
  const commands = [];
  const publisher = createResponseQueuePublisher({
    requestId: 'req-chunk',
    connectionId: 'connection-1',
    sub: 'user-1',
    source: 'websocket',
  }, {
    client: { send: async (command) => commands.push(command.input) },
    env: { RESPONSE_QUEUE_URL: 'https://sqs.example/response.fifo', ...env },
  });
  const deltas = () => commands
    .map((command) => JSON.parse(command.MessageBody))
    .filter((message) => message.type === 'stream.delta' && !message.isFiller)
    .map((message) => message.textDelta);
  return { publisher, deltas };
}

// LLM の文字は2〜3文字ずつ届く
async function streamText(publisher, text, size = 2) {
  for (let index = 0; index < text.length; index += size) {
    await publisher.appendText(text.slice(index, index + size));
  }
}

test('文字が少しずつ届いても、言葉の途中では切らず文の終わりで切る', async () => {
  const { publisher, deltas } = makeChunkPublisher();
  const text = '明日は歯医者の予定があるよ。11月22日の午後だね。';

  await publisher.start();
  await streamText(publisher, text, 3);
  await publisher.completed({ text });

  assert.deepEqual(deltas(), ['明日は歯医者の予定があるよ。', '11月22日の午後だね。']);
});

test('最初のかたまりだけ、6文字以上たまった「、」でも切る', async () => {
  const { publisher, deltas } = makeChunkPublisher();
  const text = 'そうだなあ、今日は晴れで、明日は雨だよ。';

  await publisher.start();
  await streamText(publisher, text);
  await publisher.completed({ text });

  assert.deepEqual(deltas(), ['そうだなあ、', '今日は晴れで、明日は雨だよ。']);
});

test('最初の「、」が6文字未満なら切らない', async () => {
  const { publisher, deltas } = makeChunkPublisher();
  const text = 'うん、そうだよ。';

  await publisher.start();
  await streamText(publisher, text);
  await publisher.completed({ text });

  assert.deepEqual(deltas(), ['うん、そうだよ。']);
});

test('「！？」や「」」は前の文に含める', async () => {
  const { publisher, deltas } = makeChunkPublisher();
  const text = 'ほんとに！？「うそでしょ。」って思った。';

  await publisher.start();
  await streamText(publisher, text, 1);
  await publisher.completed({ text });

  assert.deepEqual(deltas(), ['ほんとに！？', '「うそでしょ。」', 'って思った。']);
});

test('文の終わりが60文字来なければ、最後の「、」で切る（無ければ60文字で切る）', async () => {
  const { publisher, deltas } = makeChunkPublisher();
  const longWithComma = `${'あ'.repeat(30)}、${'い'.repeat(40)}。`;
  const longWithoutComma = `${'う'.repeat(70)}。`;
  const text = `はい。${longWithComma}${longWithoutComma}`;

  await publisher.start();
  await streamText(publisher, text, 3);
  await publisher.completed({ text });

  assert.deepEqual(deltas(), [
    'はい。',
    `${'あ'.repeat(30)}、`,
    `${'い'.repeat(40)}。`,
    'う'.repeat(60),
    `${'う'.repeat(10)}。`,
  ]);
  assert.equal(deltas().join(''), text);
});

test('ツールの前置きの後の本文も、最初のかたまりは「、」で切る', async () => {
  const { publisher, deltas } = makeChunkPublisher();
  const text = '調べてみたら、東京は晴れだったよ。傘はいらないね。';

  await publisher.start();
  await streamText(publisher, 'うん、わかった。');
  await publisher.toolCall({
    toolName: 'get_weather',
    description: '東京の天気を調べています',
    introText: '天気見てくる',
  });
  await streamText(publisher, text);
  await publisher.completed({ text });

  assert.deepEqual(deltas(), [
    'うん、わかった。',
    '調べてみたら、',
    '東京は晴れだったよ。',
    '傘はいらないね。',
  ]);
});

test('区切りの環境変数で、最初のかたまりと文の長さを変えられる', async () => {
  const { publisher, deltas } = makeChunkPublisher({
    STREAM_FIRST_CHUNK_MIN_CHARACTERS: '2',
    STREAM_SENTENCE_MAX_CHARACTERS: '10',
  });
  const text = 'うん、それはとても大事なことだと思う。';

  await publisher.start();
  await streamText(publisher, text);
  await publisher.completed({ text });

  assert.deepEqual(deltas(), ['うん、', 'それはとても大事なこ', 'とだと思う。']);
});

test('2つ目以降も、30文字を超える文は「、」で分ける', async () => {
  const { publisher, deltas } = makeChunkPublisher();
  const text = 'はい。今日は駅前のカフェに行ってみて、新しいケーキを食べてみたんだけど、すごくおいしかったよ。';

  await publisher.start();
  await streamText(publisher, text, 3);
  await publisher.completed({ text });

  assert.deepEqual(deltas(), [
    'はい。',
    '今日は駅前のカフェに行ってみて、',
    // 残りは30文字以下なので、もう分けない
    '新しいケーキを食べてみたんだけど、すごくおいしかったよ。',
  ]);
  assert.equal(deltas().join(''), text);
});

test('30文字以下の文は「、」で分けない', async () => {
  const { publisher, deltas } = makeChunkPublisher();
  const text = 'はい。それなら、明日やってみようか。';

  await publisher.start();
  await streamText(publisher, text, 3);
  await publisher.completed({ text });

  assert.deepEqual(deltas(), ['はい。', 'それなら、明日やってみようか。']);
});

test('STREAM_COMMA_SPLIT_MIN_CHARACTERS=0 なら2つ目以降は「、」で分けない', async () => {
  const { publisher, deltas } = makeChunkPublisher({ STREAM_COMMA_SPLIT_MIN_CHARACTERS: '0' });
  const text = 'はい。今日は駅前のカフェに行ってみて、新しいケーキを食べてみたんだけど、すごくおいしかったよ。';

  await publisher.start();
  await streamText(publisher, text, 3);
  await publisher.completed({ text });

  assert.deepEqual(deltas(), [
    'はい。',
    '今日は駅前のカフェに行ってみて、新しいケーキを食べてみたんだけど、すごくおいしかったよ。',
  ]);
});

test('TTS は同時に呼ばず、前の合成が終わってから次を呼ぶ', async () => {
  const commands = [];
  const events = [];
  const pending = [];
  let active = 0;
  let maxActive = 0;

  const publisher = createResponseQueuePublisher({
    requestId: 'req-serial',
    connectionId: 'connection-1',
    sub: 'user-1',
    source: 'websocket',
  }, {
    client: { send: async (command) => commands.push(command.input) },
    env: { RESPONSE_QUEUE_URL: 'https://sqs.example/response.fifo' },
    ttsClient: {
      synthesize: (request) => new Promise((resolve) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        events.push(`start:${request.text}`);
        pending.push(() => {
          active -= 1;
          events.push(`end:${request.text}`);
          resolve({ ok: true, format: 'wav', contentType: 'audio/wav', audio: 'AAAA', audioByteLength: 3 });
        });
      }),
    },
  });

  await publisher.start();
  await streamText(publisher, 'ひとつめ。ふたつめ。みっつめ。', 5);

  const finished = publisher.completed({ text: 'ひとつめ。ふたつめ。みっつめ。' });

  // 合成を1つずつ終わらせる。終わらせるまで次は始まらない。
  for (let round = 0; round < 3; round += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pending.length, round + 1, `${round + 1}個目だけが始まっていること`);
    pending[round]();
  }
  await finished;

  assert.equal(maxActive, 1);
  assert.deepEqual(events, [
    'start:ひとつめ。', 'end:ひとつめ。',
    'start:ふたつめ。', 'end:ふたつめ。',
    'start:みっつめ。', 'end:みっつめ。',
  ]);
  const audioChunks = commands
    .map((command) => JSON.parse(command.MessageBody))
    .filter((message) => message.type === 'stream.audio')
    .map((message) => message.chunkId);
  assert.deepEqual([...new Set(audioChunks)], ['req-serial_chunk_0', 'req-serial_chunk_1', 'req-serial_chunk_2']);
});
