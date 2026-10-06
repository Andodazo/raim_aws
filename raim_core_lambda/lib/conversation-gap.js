'use strict';

// ==============================================================================
// 前回の発話からの経過時間
// ==============================================================================
//
// 【なぜ必要か】
// モデルには「今の時刻」は渡しているが、「前に話したのがいつか」は渡していなかった。
// そのため、3日ぶりに同じスレッドを開いても「さっきも言ったけど」と返したり、
// 新しいスレッドの1ターン目で、スレッドを跨ぐ記憶を見て「また挨拶してくれた」と
// 返したりしていた（2026-10 の会話サンプルで確認）。
//
// 経過時間をざっくりした言葉にして渡し、「久しぶり」「おかえり」のような
// 人間らしい反応ができるようにする。
//
// 【どの時刻を使うか】
// - 既存のスレッド: スレッドに保存された最後のメッセージの createdAt
//   ConversationThread の updatedAt は、要約やタイトル更新（Summary Lambda）でも
//   書き換わるため「最後に話した時刻」としては使えない。
//   メッセージが無ければ lastResponseCreatedAt、それも無ければ updatedAt を使う。
// - 新しいスレッド: UserSession の lastResponseCreatedAt
//   往復ごとにユーザー単位で更新されるので「どのスレッドかに関係なく最後に話した時刻」になる。

/**
 * 最後に話した時刻（ISO文字列）を決める。分からなければ空文字。
 *
 * @param {Object} params
 * @param {Object} [params.thread]  今回のスレッド
 * @param {boolean} [params.isNew]  今回新しく作ったスレッドか
 * @param {Object} [params.session] UserSession
 * @returns {{ lastTalkedAt: string, sameThread: boolean }}
 */
function findLastTalkedAt({ thread = null, isNew = false, session = null } = {}) {
  if (thread && !isNew) {
    const messages = Array.isArray(thread.messages) ? thread.messages : [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const createdAt = messages[i] && messages[i].createdAt;
      if (isValidTime(createdAt)) {
        return { lastTalkedAt: createdAt, sameThread: true };
      }
    }
    if (isValidTime(thread.lastResponseCreatedAt)) {
      return { lastTalkedAt: thread.lastResponseCreatedAt, sameThread: true };
    }
    if (isValidTime(thread.updatedAt)) {
      return { lastTalkedAt: thread.updatedAt, sameThread: true };
    }
  }

  if (session && isValidTime(session.lastResponseCreatedAt)) {
    return { lastTalkedAt: session.lastResponseCreatedAt, sameThread: false };
  }

  return { lastTalkedAt: '', sameThread: false };
}

function isValidTime(value) {
  return typeof value === 'string' && value !== '' && Number.isFinite(Date.parse(value));
}

/**
 * 経過時間をざっくりした言葉にする。
 *
 * 細かい数字より「3日前」「1か月以上前」のような言い方の方が、
 * そのまま会話に使いやすい。
 */
function describeElapsed(minutes) {
  if (minutes < 10) return 'ついさっき（数分前）';
  if (minutes < 60) return `${Math.round(minutes / 10) * 10}分くらい前`;

  const hours = minutes / 60;
  if (hours < 24) return `${Math.max(1, Math.round(hours))}時間くらい前`;

  const days = hours / 24;
  if (days < 7) return `${Math.max(1, Math.floor(days))}日前`;
  if (days < 30) return `${Math.max(1, Math.floor(days / 7))}週間くらい前`;
  return '1か月以上前';
}

/**
 * モデルへ渡す「前回の発話」の説明文を作る。分からなければ空文字。
 *
 * @param {Object} params
 * @param {string} params.lastTalkedAt
 * @param {boolean} params.sameThread
 * @param {Date} [params.now]
 */
function buildConversationGapContext({ lastTalkedAt, sameThread, now = new Date() } = {}) {
  if (!isValidTime(lastTalkedAt)) {
    return '';
  }

  // 時計のずれで未来になった場合は 0 分として扱う
  const minutes = Math.max(0, (now.getTime() - Date.parse(lastTalkedAt)) / 60000);
  const label = describeElapsed(minutes);

  const lines = ['【前回の発話】'];

  if (sameThread) {
    lines.push(`この会話で前に話したのは${label}。`);
  } else {
    lines.push(`別の会話で最後に話したのは${label}。この会話は今始まったところ。`);
  }

  if (minutes >= 60 * 24) {
    lines.push('久しぶりなので、最初の一言で「久しぶり」「おかえり」と軽く触れてもいい。毎回触れなくていい。');
    lines.push('「さっき」とは言わない。');
  } else if (minutes >= 30) {
    lines.push('少し時間が空いている。「さっき」とは言わない。');
  }

  return lines.join('\n');
}

module.exports = {
  findLastTalkedAt,
  describeElapsed,
  buildConversationGapContext,
};
