'use strict';

// ==============================================================================
// Response Queue Stream Publisher
// ==============================================================================
//
// Mantleから受信した回答を、Edge LambdaがWebSocketへ中継できる小さなイベントへ
// 変換し、Response Queueへ送信する。
//
// Response QueueはFIFOを前提とする。sequenceを付けるだけでなく、SQS側でも
// MessageGroupId=requestIdとして順序を保証する。Edge LambdaはrequestIdとsequenceを
// 使って重複排除・欠落検知を行える。
//
// 送信イベント:
// - stream.start     : Mantle処理開始
// - stream.action    : アプリに頼む操作（駅アラームを始める など）
// - stream.delta     : ユーザーに表示する回答本文の文・チャンク
// - stream.audio     : 文・チャンクに対応するBase64 WAV音声
// - stream.completed : 最終text/emotion/intensity
// - stream.error     : 入力不正または処理失敗
// ==============================================================================

const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
const crypto = require('crypto');

const RESPONSE_SCHEMA_VERSION = 1;

function requiredEnvironmentValue(env, name) {
  const value = String(env[name] || '').trim();

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function createResponseQueuePublisher({
  requestId,
  connectionId,
  sub,
  source,
  attempt = 1,
}, {
  client,
  env = process.env,
  ttsClient = null,
  getVoiceParams = () => null,
  // 前置き・待ちのひとことなど、サーバーが決めたセリフの声。
  // 渡されないときは本文と同じ getVoiceParams を使う（以前の動き）。
  getFixedLineVoiceParams = null,
  // 今の人格（'bright' | 'downer'）。クライアントへ知らせる。
  // 駅アラームの声など、アプリ側で鳴らすセリフを人格に合わせるため。
  persona = '',
  // 声を待つ締め切り（epoch ms）。0 なら締め切りなし。
  // Lambda が打ち切られる前に、残りの声をあきらめて stream.completed を送るため。
  audioDeadlineAt = 0,
  now = () => Date.now(),
} = {}) {
  const queueUrl = requiredEnvironmentValue(env, 'RESPONSE_QUEUE_URL');
  const sqsClient = client || new SQSClient({
    region: env.AWS_REGION || 'ap-northeast-1',
  });
  // 文字と声を送るかたまりの区切り方。
  //
  // 以前は「12文字たまったら区切り文字を待たずに切る」「、でも切る」作りで、
  // LLM の文字が2〜3文字ずつ届くと「歯医者の予 / 定」「11月2 / 2日」のように
  // 言葉の途中で切れ、TTS がかたまりごとに別の文として読むため読みが崩れていた。
  //
  // 今は次のように切る。
  // - 基本は文の終わり（。！？!? と改行）だけで切る
  // - 返事の最初のかたまりだけは、早く話し始めるために「、」でも切る
  //   （STREAM_FIRST_CHUNK_MIN_CHARACTERS 文字以上たまってから）
  // - 文の終わりが STREAM_SENTENCE_MAX_CHARACTERS 文字来なければ、
  //   その範囲の最後の「、」で切る（無ければその文字数で切る）
  //
  // 旧 STREAM_CHUNK_MIN_CHARACTERS / STREAM_CHUNK_MAX_CHARACTERS は使わない。
  // 古い値（12 / 30）が環境変数に残っていても新しい区切り方になるよう、名前を変えた。
  const firstChunkMinimumCharacters = Math.max(
    1,
    Number(env.STREAM_FIRST_CHUNK_MIN_CHARACTERS || 6)
  );
  const sentenceMaximumCharacters = Math.max(
    firstChunkMinimumCharacters,
    Number(env.STREAM_SENTENCE_MAX_CHARACTERS || 60)
  );
  // 2つ目以降のかたまりも、文がこの文字数以上になるなら「、」で分ける。0 で分けない。
  //
  // TTS を順番に呼ぶようにしたので、短いかたまりの次に長い文が来ると、
  // 長い文の合成が終わるまで声が途切れる（実測で約3秒）。長い文を分けて、
  // 1回の合成を短くする。
  const commaSplitMinimumCharacters = Math.max(
    0,
    Number(env.STREAM_COMMA_SPLIT_MIN_CHARACTERS ?? 30)
  );
  // TTS の再試行回数。0 にすると再試行しない。
  const audioRetryCount = Math.max(0, Number(env.TTS_RETRY_COUNT ?? 1));

  // Base64 を文字数で切るため、4の倍数でないと各パートが単独でデコードできない。
  // クライアントはパートごとに base64Decode するので、端数があると
  // FormatException になり音声が無言で消える。ここで必ず丸める。
  const audioFragmentBase64Characters = Math.max(
    4,
    Math.floor(Number(env.TTS_AUDIO_FRAGMENT_BASE64_CHARACTERS || 24000) / 4) * 4
  );
  let sequence = 0;
  let textChunkIndex = 0;
  // この要求で何番目の client_action か（actionId に使う）
  let clientActionIndex = 0;
  let textBuffer = '';
  // 次に出すかたまりが、返事（または前置きの後の本文）の最初かどうか。
  // 最初のかたまりだけ「、」でも切って、早く声を出す。
  let firstChunkPending = true;
  let audioDeliveryChain = Promise.resolve();
  // 締め切りで声をあきらめたら true。あとから合成が終わっても送らない
  // （Lambda の環境は次の要求で使い回されるので、古い声が別の返事に混ざらないように）。
  let audioAbandoned = false;
  // 合成も順番に1つずつにする（前の合成が終わってから次を始める）。
  let audioSynthesisChain = Promise.resolve();
  // v14: tool intro を送ったら true。本文の最初のdeltaで bubble_break を発火して false に戻す。
  let bubbleBreakPending = false;
  const messageGroupId = requestId.length <= 128
    ? requestId
    : crypto.createHash('sha256').update(requestId).digest('hex');

  /**
   * 共通envelopeを作り、FIFO Response Queueへ1イベント送信する。
   */
  // stream.emotion は1ターンに1回だけ送る
  let emotionSent = false;

  async function send(type, payload = {}) {
    const currentSequence = sequence;
    sequence += 1;
    const message = {
      schemaVersion: RESPONSE_SCHEMA_VERSION,
      type,
      requestId,
      connectionId,
      sub,
      source,
      sequence: currentSequence,
      attempt,
      createdAt: new Date().toISOString(),
      ...payload,
    };

    const deduplicationId = crypto
      .createHash('sha256')
      .update(`${requestId}:${attempt}:${currentSequence}:${type}`)
      .digest('hex');

    await sqsClient.send(new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
      MessageGroupId: messageGroupId,
      MessageDeduplicationId: deduplicationId,
    }));

    return message;
  }

  function nextChunkId() {
    const chunkId = `${requestId}_chunk_${textChunkIndex}`;
    textChunkIndex += 1;
    return chunkId;
  }

  // 文の終わり
  const SENTENCE_END = /[。！？!?\n]/;
  // 文の終わりのすぐ後に続いたら、前の文に含める文字。
  // 「！？」「…。」「」」などを分けると「？」だけのかたまりができ、
  // 読めない・余計な声が入る原因になる。
  const SENTENCE_TAIL = /[。！？!?\n…‥」』）)】〕”’\s]/;
  // 読点（最初のかたまりと、長すぎる文で使う）
  const COMMA = /[、，,]/;

  function lastCommaIndex(value) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      if (COMMA.test(value[index])) {
        return index;
      }
    }
    return -1;
  }

  function cutTextBuffer(length) {
    const chunk = textBuffer.slice(0, length);
    textBuffer = textBuffer.slice(length);
    return chunk;
  }

  /**
   * バッファから次のかたまりを1つ取り出す。まだ切れないなら null。
   * force は返事の終わりなど、残りを全部出してよいとき。
   */
  function takeNextTextChunk(force = false) {
    if (!textBuffer) {
      return null;
    }

    const sentenceEnd = textBuffer.search(SENTENCE_END);

    // 最初のかたまりだけは、文の終わりより先にある「、」でも切る。
    if (firstChunkPending) {
      const limit = sentenceEnd >= 0 ? sentenceEnd : textBuffer.length;
      for (let index = firstChunkMinimumCharacters - 1; index < limit; index += 1) {
        if (COMMA.test(textBuffer[index])) {
          return cutTextBuffer(index + 1);
        }
      }
    }

    // 2つ目以降でも、文が長くなるなら「、」で分ける。
    // 分けた前半が短すぎないよう、firstChunkMinimumCharacters 文字以上の位置の「、」だけ使う。
    if (!firstChunkPending && commaSplitMinimumCharacters > 0) {
      const sentenceLength = sentenceEnd >= 0 ? sentenceEnd + 1 : textBuffer.length;
      if (sentenceLength > commaSplitMinimumCharacters) {
        const comma = lastCommaIndex(textBuffer.slice(0, commaSplitMinimumCharacters));
        if (comma + 1 >= firstChunkMinimumCharacters) {
          return cutTextBuffer(comma + 1);
        }
      }
    }

    if (sentenceEnd >= 0 && sentenceEnd < sentenceMaximumCharacters) {
      let end = sentenceEnd + 1;
      while (end < textBuffer.length && SENTENCE_TAIL.test(textBuffer[end])) {
        end += 1;
      }
      // 文の終わりがバッファの最後にあるときは、「！？」や「」」が続くかもしれない。
      // 次の文字が届くまで待つ（返事の終わりなら待たない）。
      if (end < textBuffer.length || force) {
        return cutTextBuffer(end);
      }
      return null;
    }

    // 文の終わりが来ないまま長くなったら、その範囲の最後の「、」で切る。
    if (textBuffer.length >= sentenceMaximumCharacters) {
      const head = textBuffer.slice(0, sentenceMaximumCharacters);
      const comma = lastCommaIndex(head);
      return cutTextBuffer(comma >= 0 ? comma + 1 : sentenceMaximumCharacters);
    }

    if (force) {
      return cutTextBuffer(textBuffer.length);
    }

    return null;
  }

  /**
   * TTS を1回呼ぶ。
   */
  function synthesizeOnce(chunkId, text, fixedLine = false) {
    return Promise.resolve()
      .then(() => ttsClient.synthesize({
        requestId,
        chunkId,
        text,
        voiceParams: (fixedLine && getFixedLineVoiceParams ? getFixedLineVoiceParams() : getVoiceParams()) || undefined,
      }))
      .catch((error) => ({ error }));
  }

  /**
   * 失敗が再試行可能なら、もう1度だけ合成し直す。
   *
   * TTS Lambda は is_retriable() で AUDIO_QUERY_FAILED / SYNTHESIS_FAILED /
   * MODEL_LOAD_FAILED を retriable として返し、tts-client も
   * error.retriable に載せて渡している。にもかかわらず呼び出し側が
   * 見ずに捨てていたため、1文まるごと無音になることがあった。
   */
  async function synthesizeWithRetry(chunkId, text, fixedLine = false) {
    const first = await synthesizeOnce(chunkId, text, fixedLine);

    if (!isTtsFailure(first)) {
      return first;
    }

    const error = first.error || {};

    if (!error.retriable || audioRetryCount <= 0) {
      return first;
    }

    console.warn('TTS failed; retrying once:', {
      requestId,
      chunkId,
      code: error.code,
    });

    const second = await synthesizeOnce(chunkId, text, fixedLine);

    if (!isTtsFailure(second)) {
      console.log(`[TTS] retry succeeded: chunkId=${chunkId}`);
    }

    return second;
  }

  /**
   * 読み上げる文字（文字・数字）があるか。
   *
   * 文の区切りで「？」や「…」だけのかたまりができることがあり、
   * VOICEVOX はそれを読めずに失敗していた（AUDIO_QUERY_FAILED）。
   * 失敗すると1回やり直すので、その間ほかの文の音声も待たされていた。
   */
  function hasSpeakableText(value) {
    return /[\p{L}\p{N}]/u.test(String(value || ''));
  }

  function isTtsFailure(result) {
    return Boolean(result?.error) || result?.ok === false;
  }

  function enqueueAudio({ chunkId, text, fixedLine = false }) {
    if (!ttsClient || !hasSpeakableText(text)) {
      return;
    }

    // 合成は1つずつ順番に行い、送信もenqueue順に直列化する。
    //
    // 以前はenqueueした時点で全部のかたまりの合成を同時に始めていた。
    // TTS Lambda は同時に呼ぶと呼んだ数だけ環境が要るので、2つ目以降が
    // 冷えた環境に当たり、返事の途中で十数秒途切れていた
    // （自作の声で実測：途中の途切れ 13.6秒 → 順番なら 0.7秒）。
    // 前の合成が終われば次を始めるので、再生中に次の合成が進む。
    const ttsPromise = audioSynthesisChain.then(() => synthesizeWithRetry(chunkId, text, fixedLine));
    audioSynthesisChain = ttsPromise.then(() => undefined, () => undefined);

    audioDeliveryChain = audioDeliveryChain.then(async () => {
      const result = await ttsPromise;

      if (audioAbandoned) {
        return;
      }

      if (isTtsFailure(result)) {
        const error = result.error || new Error(result.message || 'TTS failed');
        console.warn('TTS failed; continuing text stream:', {
          requestId,
          chunkId,
          code: error.code,
          message: error.message,
          // 何を喋らせようとして失敗したかを追えるようにする。
          // 本文そのものは残さず、長さと先頭1文字だけにする。
          textLength: text.length,
          textHead: text.slice(0, 1),
        });
        return;
      }

      const audio = String(result.audio || '');

      if (!audio) {
        return;
      }

      const parts = [];
      for (let offset = 0; offset < audio.length; offset += audioFragmentBase64Characters) {
        parts.push(audio.slice(offset, offset + audioFragmentBase64Characters));
      }

      for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
        if (audioAbandoned) {
          return;
        }
        await send('stream.audio', {
          chunkId,
          format: result.format || 'wav',
          contentType: result.contentType || 'audio/wav',
          audio: parts[partIndex],
          audioByteLength: result.audioByteLength,
          partIndex,
          partCount: parts.length,
          isLast: partIndex === parts.length - 1,
        });
      }
    }).catch((error) => {
      // 音声送信エラーでCore全体を再実行しない。テキストは既に送信済み。
      console.warn('TTS audio event publish failed; continuing text stream:', {
        requestId,
        message: error.message,
      });
    });
  }

  /**
   * 送り待ちの声を、締め切りまで待つ。
   *
   * 以前は締め切りなしで待っており、声の合成が長引くと Lambda が先に打ち切られ、
   * stream.completed が届かずアプリの吹き出しが止まったままになり得た。
   */
  async function waitForAudio() {
    if (!(audioDeadlineAt > 0)) {
      await audioDeliveryChain;
      return;
    }
    const waitMs = audioDeadlineAt - now();
    if (waitMs <= 0) {
      audioAbandoned = true;
      return;
    }
    let timer = null;
    const timedOut = await Promise.race([
      audioDeliveryChain.then(() => false),
      new Promise((resolve) => { timer = setTimeout(() => resolve(true), waitMs); }),
    ]);
    clearTimeout(timer);
    if (timedOut) {
      audioAbandoned = true;
      console.warn('[TTS] audio not finished before the deadline; sending completed without it:', {
        requestId,
      });
    }
  }

  async function publishTextChunk(text) {
    const chunkId = nextChunkId();
    await send('stream.delta', { textDelta: text, chunkId });
    enqueueAudio({ chunkId, text });
  }

  async function flushText(force = true) {
    let lastMessage = null;
    let chunk;

    while ((chunk = takeNextTextChunk(force)) !== null) {
      // ツールの前置きセリフと本文を別吹き出しにする。
      await maybeSendBubbleBreak();
      firstChunkPending = false;
      lastMessage = await publishTextChunk(chunk);
    }

    return lastMessage;
  }

  // v14: tool intro 送信後にtrueになり、本文開始時にfalseへ戻る。
  async function maybeSendBubbleBreak() {
    if (!bubbleBreakPending) {
      return null;
    }
    bubbleBreakPending = false;
    return send('stream.bubble_break');
  }

  return {
    start() {
      // threadId はこの時点では未確定（resolveThread は handleCoreChat の中で走る）。
      // クライアントへは stream.completed で返す。
      return send('stream.start', persona ? { persona } : {});
    },

    /**
     * token単位でSQS SendMessageを呼ぶとメッセージ数が増えすぎるため、
     * 一定文字数までまとめてからdeltaとして送る。
     */
    async appendText(text) {
      textBuffer += String(text || '');
      return flushText(false);
    },

    flushText: () => flushText(true),

    async drainAudio() {
      await waitForAudio();
    },

    /**
     * 本文より先に分かった感情を送る。立ち絵の表情を早く変えるため。
     * Edge が metadata（クライアントが表情を反映するメッセージ）に変換する。
     * 最終的な感情は従来どおり stream.completed でも送る。
     */
    async emotion(result) {
      if (emotionSent) {
        return null;
      }
      emotionSent = true;
      return send('stream.emotion', {
        emotions: result.emotions,
        overall_intensity: result.overall_intensity,
        emotion: result.emotion,
        intensity: result.intensity,
      });
    },

    async completed(result) {
      await flushText(true);
      // 本文がdeltaで一度も流れなかった場合でも、introの後に区切りを入れる。
      await maybeSendBubbleBreak();
      await waitForAudio();
      return send('stream.completed', {
        text: result.text,
        // 会話スレッドの識別子。クライアントはこれを保持し、次回の送信で送り返す。
        // 新規作成された場合も採番結果がここで分かる。
        threadId: result.threadId || '',
        // v13: Unity BlendShape 用の比率Mapと全体強度。
        // 重み = emotions[key] × overall_intensity
        emotions: result.emotions,
        overall_intensity: result.overall_intensity,
        // 後方互換: 旧Flutter/Unity実装はこの2つだけ見ていても動く。
        emotion: result.emotion,
        intensity: result.intensity,
        ...(persona ? { persona } : {}),
      });
    },

    // ─────────────────────────────────────────────
    // ツール呼出の通知
    // ─────────────────────────────────────────────
    //
    // Gemmaはツール呼出時に本文を返せないため、
    // 「調べるね」に相当する発話はサーバー側の固定セリフを送る。
    //
    //   1. stream.delta   前置きセリフ（ライムの発話としてUIに出す）
    //   2. stream.tool    ツール実行中であることの通知（UIのローディング表示用）
    //
    // 前置きセリフを通常のtextとして流すことで、
    // クライアントは特別な処理をしなくても発話として表示できる。
    // 返事の前に出すひとこと（Mantle の返事が遅いとき。waiting-lines.js）。
    // ツールの前置きと同じく、本文より先に声つきで出し、本文の前で吹き出しを分ける。
    async filler(text) {
      const line = String(text || '').trim();
      if (!line) return;
      await flushText();
      const chunkId = nextChunkId();
      await send('stream.delta', {
        textDelta: line,
        chunkId,
        isFiller: true,
      });
      // 決まったセリフは、本文の感情がわかる前に話すので落ち着いた声で固定する
      enqueueAudio({ chunkId, text: line, fixedLine: true });
      bubbleBreakPending = true;
      // 前置きの後の本文も、最初のかたまりは短く切って早く声を出す。
      firstChunkPending = true;
    },

    async toolCall({ toolName, description, introText }) {
      if (introText) {
        // バッファを経由せず即時に送る。ツール実行の待ち時間より先に届かせたい。
        await flushText();

        // 前置きも本文と同じように chunkId を採番して TTS に回す。
        // 以前は send するだけで enqueueAudio を呼んでおらず、
        // 「調べるね」に相当するセリフだけ音声が鳴らなかった。
        // 待ち時間を埋めるための発話なので、ここが無音だと役割を果たさない。
        const chunkId = nextChunkId();

        await send('stream.delta', {
          textDelta: introText,
          chunkId,
          isFiller: true,
        });
        // 本文の感情がわかる前に話すので、場面の感情（強さ最大）ではなく落ち着いた声で固定する。
        // 以前は場面の既定の感情で話していたため、「それ気になる！」だけ声が高く、
        // 検索のあとの本文（本当の感情）と声の高さがずれていた。
        enqueueAudio({ chunkId, text: introText, fixedLine: true });

        // v14: introを送ったので、本文開始時にbubble_breakを挟む。
        bubbleBreakPending = true;
        // 前置きの後の本文も、最初のかたまりは短く切って早く声を出す。
        firstChunkPending = true;
      }

      return send('stream.tool', {
        tool: toolName,
        description,
      });
    },

    // ─────────────────────────────────────────────
    // アプリに頼む操作
    // ─────────────────────────────────────────────
    //
    // 駅アラームのように、実際の動作をアプリが行うツールで使う。
    // Edge で client_action に変換されてアプリへ届く。
    //
    // actionId は「この要求の何番目の操作か」で決める。SQS の再試行で同じ要求を
    // やり直すと、以前は同じ操作がもう一度届き、駅アラームが二重に始まり得た（R-05）。
    // 試行回数（attempt）を含めないので、やり直しても同じ ID になる。
    // アプリは同じ actionId を1回だけ実行する。
    async clientAction({ action, params = {} }) {
      // 前置きなどの本文が残っていれば先に出し切り、順番を保つ
      await flushText();
      const actionId = `${requestId}_action_${clientActionIndex}`;
      clientActionIndex += 1;
      return send('stream.action', {
        action,
        actionId,
        params,
      });
    },

    async error(result) {
      await flushText();
      return send('stream.error', {
        code: result.code || 'INTERNAL_ERROR',
        message: result.message || 'Internal server error',
        retriable: Boolean(result.retriable),
      });
    },
  };
}

module.exports = {
  RESPONSE_SCHEMA_VERSION,
  createResponseQueuePublisher,
};
