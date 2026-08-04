'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createWebSocketHandler } = require('../lib/websocket-handler');
const { createWebSocketPostback } = require('../lib/websocket-postback');

const ENV = {
  REQUEST_QUEUE_URL: 'https://sqs.example/q.fifo',
  RESPONSE_QUEUE_URL: 'https://sqs.example/r.fifo',
  CONNECTION_TABLE_NAME: 'RAiM-WebSocketConnection-dev',
  WEBSOCKET_API_ENDPOINT: 'https://example.com/dev',
  AWS_REGION: 'ap-northeast-1',
};

/// 本物の postback を使う（SDK クライアントだけ差し替える）
///
/// モックの postback で代用すると、公開APIの形が実装とズレていても
/// テストが通ってしまう。実際に postJson の呼び出し方を間違えて
/// `postToConnection is not a function` を本番で踏んだため、
/// ここでは本物を通す。
function setup({ listThreads, getThreadHistory, deleteThread } = {}) {
  const sent = [];
  const sqsSent = [];

  const postback = createWebSocketPostback({
    client: {
      send: async (command) => {
        sent.push(JSON.parse(Buffer.from(command.input.Data).toString('utf8')));
      },
    },
    env: ENV,
  });

  const handler = createWebSocketHandler({
    connectionStore: { getConnection: async () => ({ sub: 'user-1' }) },
    postback,
    threadStore: {
      listThreads: listThreads || (async () => []),
      getThreadHistory: getThreadHistory || (async () => null),
      deleteThread: deleteThread || (async () => true),
    },
    sqsClient: {
      send: async (command) => {
        sqsSent.push(JSON.parse(command.input.MessageBody));
      },
    },
    memoryQueueUrl: 'https://sqs.example/summary.fifo',
  });

  return { handler, sent, sqsSent };
}

function event(body) {
  return {
    requestContext: {
      routeKey: '$default',
      connectionId: 'conn-1',
      domainName: 'example.com',
      stage: 'dev',
      authorizer: { claims: { sub: 'user-1' } },
    },
    body: JSON.stringify(body),
  };
}

test('thread.list posts the thread list back to the connection', async () => {
  const { handler, sent } = setup({
    listThreads: async (sub) => {
      assert.equal(sub, 'user-1');
      return [
        {
          threadId: 't1',
          title: 'テスト',
          updatedAt: '2026-08-03T00:00:00.000Z',
          turnCount: 3,
        },
      ];
    },
  });

  const response = await handler(event({ type: 'thread.list' }));

  assert.equal(response.statusCode, 202);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'thread_list');
  assert.equal(sent[0].threads[0].threadId, 't1');
});

test('thread.history posts the history back to the connection', async () => {
  const { handler, sent } = setup({
    getThreadHistory: async (sub, threadId) => {
      assert.equal(threadId, 't1');
      return {
        threadId: 't1',
        title: 'テスト',
        messages: [{ role: 'user', text: 'やあ', createdAt: 'x' }],
        hasMore: false,
        totalMessages: 1,
      };
    },
  });

  const response = await handler(event({ type: 'thread.history', threadId: 't1' }));

  assert.equal(response.statusCode, 202);
  assert.equal(sent[0].type, 'thread_history');
  assert.equal(sent[0].messages.length, 1);
});

test('thread.history without threadId is rejected', async () => {
  const { handler, sent } = setup();
  const response = await handler(event({ type: 'thread.history' }));

  assert.equal(response.statusCode, 400);
  assert.equal(sent.length, 0);
});

test('a message without type is still treated as a chat request', async () => {
  // 既存クライアントは type を送らない。互換性を壊していないことを確認する。
  //
  // チャット経路は SQS publisher を作りに行くので、
  // 「publisher の生成が試みられた」ことをもってチャット扱いと判断する。
  const { handler, sent } = setup();

  let wentToChat = false;
  try {
    await handler(event({ text: 'こんにちは' }));
  } catch (error) {
    wentToChat = String(error.message).includes('REQUEST_QUEUE_URL');
  }

  assert.ok(wentToChat, 'type なしのメッセージがチャット経路へ流れていない');
  // thread 系の応答は送られていない
  assert.equal(sent.length, 0);
});

// ── thread.delete ───────────────────────────

test('thread.delete removes the thread and asks for a memory refresh', async () => {
  const deleted = [];
  const { handler, sent, sqsSent } = setup({
    deleteThread: async (sub, threadId) => {
      deleted.push({ sub, threadId });
      return true;
    },
  });

  const response = await handler(event({ type: 'thread.delete', threadId: 't1' }));

  assert.equal(response.statusCode, 202);
  assert.deepEqual(deleted, [{ sub: 'user-1', threadId: 't1' }]);

  assert.equal(sent[0].type, 'thread_deleted');
  assert.equal(sent[0].threadId, 't1');
  assert.equal(sent[0].memoryRefreshRequested, true);

  // userMemory には削除したスレッドの内容が残るため、作り直しを依頼する
  assert.equal(sqsSent.length, 1);
  assert.equal(sqsSent[0].type, 'memory.refresh');
  assert.equal(sqsSent[0].sub, 'user-1');
});

test('thread.delete without threadId is rejected', async () => {
  const { handler, sent } = setup();
  const response = await handler(event({ type: 'thread.delete' }));

  assert.equal(response.statusCode, 400);
  assert.equal(sent.length, 0);
});

test('thread.delete succeeds even if the memory refresh request fails', async () => {
  const sent = [];
  const postback = createWebSocketPostback({
    client: {
      send: async (command) => {
        sent.push(JSON.parse(Buffer.from(command.input.Data).toString('utf8')));
      },
    },
    env: ENV,
  });

  const handler = createWebSocketHandler({
    connectionStore: { getConnection: async () => ({ sub: 'user-1' }) },
    postback,
    threadStore: { deleteThread: async () => true },
    // SQS が落ちても削除自体は成立させる（週次バッチで回収される）
    sqsClient: { send: async () => { throw new Error('SQS down'); } },
    memoryQueueUrl: 'https://sqs.example/summary.fifo',
  });

  const response = await handler(event({ type: 'thread.delete', threadId: 't1' }));

  assert.equal(response.statusCode, 202);
  assert.equal(sent[0].type, 'thread_deleted');
  assert.equal(sent[0].memoryRefreshRequested, false);
});

test('thread.history passes beforeIndex through to the store', async () => {
  let captured;
  const { handler, sent } = setup({
    getThreadHistory: async (sub, threadId, options) => {
      captured = options;
      return {
        threadId: 't1',
        title: 'テスト',
        messages: [{ role: 'user', text: '古い発話', createdAt: 'x' }],
        startIndex: 0,
        hasMore: false,
        totalMessages: 100,
      };
    },
  });

  const response = await handler(
    event({ type: 'thread.history', threadId: 't1', beforeIndex: 50 })
  );

  assert.equal(response.statusCode, 202);
  assert.equal(captured.beforeIndex, 50);

  // カーソルはクライアントへ返る
  assert.equal(sent[0].type, 'thread_history');
  assert.equal(sent[0].startIndex, 0);
  assert.equal(sent[0].hasMore, false);
});

test('thread.history without beforeIndex asks for the latest window', async () => {
  let captured;
  const { handler } = setup({
    getThreadHistory: async (sub, threadId, options) => {
      captured = options;
      return {
        threadId: 't1', title: '', messages: [],
        startIndex: 0, hasMore: false, totalMessages: 0,
      };
    },
  });

  await handler(event({ type: 'thread.history', threadId: 't1' }));

  // 未指定なら store の既定（最新側）に任せる
  assert.deepEqual(captured, {});
});
