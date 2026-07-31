'use strict';

// ==============================================================================
// 要約依頼のディスパッチ（SQS）
// ==============================================================================
//
// トリガー判定が「要約すべき」と判断したとき、Summary Request Queue へ
// 依頼を投げる。実際の要約は Summary Lambda が別プロセスで行う。
//
//   Core Lambda（会話応答を返す）
//        ↓ 応答を返した後に依頼だけ投げる
//   Summary Request Queue（FIFO）
//        ↓
//   Summary Lambda（要約生成 → DynamoDB 保存 → セッションリセット）
//
// 【なぜ非同期にするか】
//
// 要約を会話の途中で同期実行すると、その往復だけ Mantle 呼び出しが2回になり
// レイテンシが倍近くなる。コンパニオンとしてテンポが崩れるため、
// 応答を返してから投げる。
//
// 【FIFO の重複排除を使う理由】
//
// トリガーは閾値を超えると true になり、要約が完了して累積がリセットされる
// まで true のままになる。その間に会話が続くと往復のたびに依頼が積まれる。
//
//   5往復目: 閾値超え → 依頼を送信
//   6往復目: まだリセット前 → また送信  ← 重複
//   7往復目: まだリセット前 → また送信  ← 重複
//
// MessageDeduplicationId に `sub:threadId` を渡すことで、
// 5分の重複排除ウィンドウ内の重複が自動的に潰れる。
//
// MessageGroupId は sub にする。ユーザー単位で順序が保証されつつ、
// 別ユーザー同士は並列に処理される（全部同じグループだと直列化して遅くなる）。

const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');

const SUMMARIZE_REQUEST_TYPE = 'summarize.request';

let cachedClient = null;

function getSqsClient(env) {
  if (!cachedClient) {
    cachedClient = new SQSClient({
      region: env.AWS_REGION || 'ap-northeast-1',
    });
  }
  return cachedClient;
}

function queueUrl(env) {
  return String(env.SUMMARY_REQUEST_QUEUE_URL || '').trim();
}

/**
 * 要約依頼を Summary Request Queue へ送る。
 *
 * 会話応答を返した「後」に呼ぶこと。
 * 失敗しても会話体験を壊さないよう、例外は投げず false を返す。
 * 送信できなくてもトリガー条件は満たされたままなので、次の往復で再度試行される。
 *
 * @param {Object} params
 * @param {string} params.sub
 * @param {string} params.threadId
 * @param {string} params.reason トリガー理由（ログ・デバッグ用）
 * @param {Object} [deps] テスト用の差し替え
 * @returns {Promise<boolean>} 送信できたら true
 */
async function dispatchSummarization({ sub, threadId, reason }, deps = {}) {
  const env = deps.env || process.env;

  if (!sub || !threadId) {
    return false;
  }

  const url = queueUrl(env);

  if (!url) {
    // キュー未設定でも会話は動かす。設定漏れに気づけるようログだけ残す。
    console.warn('[Summary] SUMMARY_REQUEST_QUEUE_URL is not set; skipping dispatch');
    return false;
  }

  const body = {
    type: SUMMARIZE_REQUEST_TYPE,
    sub,
    threadId,
    reason: reason || null,
    requestedAt: new Date().toISOString(),
  };

  try {
    const client = deps.sqsClient || getSqsClient(env);

    await client.send(
      new SendMessageCommand({
        QueueUrl: url,
        MessageBody: JSON.stringify(body),
        // ユーザー単位で順序保証。別ユーザーは並列処理される。
        MessageGroupId: sub,
        // 同一スレッドの重複依頼を5分ウィンドウで潰す。
        MessageDeduplicationId: `${sub}:${threadId}`,
      })
    );

    console.log(`[Summary] dispatched: sub=${sub} threadId=${threadId} reason=${reason}`);
    return true;
  } catch (error) {
    // 権限不足や一時障害でも会話は壊さない。
    console.error(`[Summary] dispatch failed (non-fatal): ${error.message}`);
    return false;
  }
}

module.exports = {
  SUMMARIZE_REQUEST_TYPE,
  dispatchSummarization,
  queueUrl,
};
