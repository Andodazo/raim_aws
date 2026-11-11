'use strict';

// ==============================================================================
// 予定の手帳のツール（サーバーで保存して、アプリに知らせる）
// ==============================================================================
//
// 「金曜10時に面接、入れといて」と頼まれたら、ライムが add_schedule を呼ぶ。
//
// 【駅アラームとの違い】
// 駅アラームはアプリが動かすので、サーバーは「アプリにやって」と伝えるだけだった。
// 予定はサーバー（RAiM-Planner-dev）に保存して、Windows とスマホで共有する
// （安藤さんと決めた）。保存できたら、アプリへ planner.added などを送る。
// アプリは予定のカードを出し、知らせる通知を予約し直す。
//
//   1. ライムが add_schedule を呼ぶ
//   2. Core が日付を確かめて DynamoDB に保存する
//   3. アプリへ planner.added（予定の中身）を送る → カードと通知の予約
//   4. 並行して、知らせる文と大事さを LLM に作らせ、できたら planner.updated を送る
//   5. ライムには「入れた」という結果を返し、ライムが返事をする
//
// 【見せる条件】
// アプリが features に planner を入れて送ってきて、発言に日付や予定の言葉が
// あるとき（planner-context.js の関門）だけ、このツールを見せる。
// ==============================================================================

const {
  isAcceptableEventDate,
  normalizeTime,
  formatDateLabel,
} = require('../planner/planner-dates');
const { findItemByShortId } = require('../planner/planner-context');
const { MAX_ITEMS_PER_USER, MAX_TITLE_LENGTH } = require('../planner/planner-store');

const PLANNER_TOOL_DEFINITIONS = Object.freeze([
  {
    type: 'function',
    name: 'add_schedule',
    description: 'ユーザーの予定を手帳に入れます。前の日の夜や1時間前にアプリが知らせます。ユーザーが「予定入れて」「覚えといて」「その日に教えて」のように、はっきり頼んだときだけ使ってください。話に出ただけのときは使わないでください。',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: '予定の短い名前（例: 面接、歯医者、ゼミの発表）',
        },
        date: {
          type: 'string',
          description: '日付 YYYY-MM-DD。プロンプトの「日付の表」から選ぶ',
        },
        time: {
          type: 'string',
          description: '時刻 HH:mm（24時間）。分からなければ空',
        },
        note: {
          type: 'string',
          description: 'ひとことメモ。ユーザーが言ったときだけ（例: スーツを持っていく）',
        },
      },
      required: ['title', 'date'],
    },
  },
  {
    type: 'function',
    name: 'update_schedule',
    description: '手帳の予定を直します。「面接11時になった」「歯医者、来週の火曜にずれた」のように頼まれたときに使ってください。直すところだけ入れてください。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '「今入っている予定」の id' },
        title: { type: 'string', description: '新しい名前（変えるときだけ）' },
        date: { type: 'string', description: '新しい日付 YYYY-MM-DD（変えるときだけ）' },
        time: { type: 'string', description: '新しい時刻 HH:mm（変えるときだけ。時刻を消すなら "なし"）' },
        note: { type: 'string', description: '新しいメモ（変えるときだけ）' },
      },
      required: ['id'],
    },
  },
  {
    type: 'function',
    name: 'delete_schedule',
    description: '手帳の予定を消します。「〇〇、消していい？」と聞いて、ユーザーが「うん」などと答えたあとにだけ使ってください。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '「今入っている予定」の id' },
      },
      required: ['id'],
    },
  },
]);

const PLANNER_TOOL_NAMES = Object.freeze(PLANNER_TOOL_DEFINITIONS.map((tool) => tool.name));

// 消すのを許す言葉。ライムが聞かずに消すのを防ぐ（ユーザーの返事にこれが無ければ消さない）
const DELETE_CONFIRM_WORDS = Object.freeze([
  'うん', 'はい', 'いいよ', 'いいよー', 'お願い', 'おねがい', 'オッケー', 'おっけー', 'OK', 'ok',
  '大丈夫', 'だいじょうぶ', 'そう', '消して', 'けして', '削除', '消していい', 'なくなった',
  '無くなった', '中止', 'キャンセル', 'きゃんせる', 'いらない', 'ええ', 'よろしく',
]);

function isPlannerTool(toolName) {
  return PLANNER_TOOL_NAMES.includes(toolName);
}

function failure(toolName, message) {
  return { result: { error: true, message, tool: toolName }, change: null };
}

function describeForRaim(item) {
  return {
    id: item.itemId.replace(/^[a-z]+_/, '').slice(0, 6),
    title: item.title,
    date: item.date,
    day: formatDateLabel(item.date),
    time: item.time || 'なし',
  };
}

/**
 * 予定のツールを実行する。
 *
 * @param {string} toolName
 * @param {object} args  ライムが渡した引数
 * @param {{ sub, store, items, userText, now }} context
 *   items は今回プロンプトに見せた、その人の項目（短い id を探すのに使う）
 * @returns {Promise<{ result: object, change: null | { type: 'added'|'updated'|'deleted', item: object } }>}
 *   result はライムに返す結果、change はアプリに知らせる変更
 */
async function runPlannerTool(toolName, args = {}, { sub, store, items = [], userText = '', now = new Date() } = {}) {
  if (toolName === 'add_schedule') {
    const title = String(args.title || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH);
    const date = String(args.date || '').trim();
    const time = normalizeTime(args.time);

    if (!title) {
      return failure(toolName, '予定の名前が分からなかったので入れていない。何の予定か聞く');
    }
    if (!isAcceptableEventDate(date, now)) {
      return failure(toolName, '日付が正しくなかったので入れていない。何日か聞く');
    }
    if (items.filter((item) => item.kind === 'event').length >= MAX_ITEMS_PER_USER) {
      return failure(toolName, '手帳がいっぱいで入れられなかった。古い予定を消してもらう');
    }

    const item = await store.addEvent(sub, {
      title,
      date,
      time,
      note: String(args.note || ''),
      source: 'raim',
    });
    console.log(`[Planner] added: hasTime=${Boolean(time)}`);
    return {
      result: {
        ok: true,
        added: describeForRaim(item),
        note: 'アプリが前の日の夜と1時間前（時間が無ければ当日の朝）に知らせる。何をいつ入れたか短く言う',
      },
      change: { type: 'added', item },
    };
  }

  const target = findItemByShortId(items.filter((item) => item.kind === 'event'), args.id);
  if (!target) {
    return failure(toolName, 'その id の予定が手帳に無かった。どの予定か聞く');
  }

  if (toolName === 'update_schedule') {
    const changes = {};
    if (args.title !== undefined && String(args.title).trim()) {
      changes.title = String(args.title).trim().slice(0, MAX_TITLE_LENGTH);
    }
    if (args.date !== undefined && String(args.date).trim()) {
      const date = String(args.date).trim();
      if (!isAcceptableEventDate(date, now)) {
        return failure(toolName, '新しい日付が正しくなかったので直していない。何日か聞く');
      }
      changes.date = date;
    }
    if (args.time !== undefined) {
      const raw = String(args.time).trim();
      if (raw === 'なし' || raw === '') {
        if (raw === 'なし') changes.time = '';
      } else {
        const time = normalizeTime(raw);
        if (!time) return failure(toolName, '新しい時刻が正しくなかったので直していない。何時か聞く');
        changes.time = time;
      }
    }
    if (args.note !== undefined && String(args.note).trim()) {
      changes.note = String(args.note).trim();
    }
    if (Object.keys(changes).length === 0) {
      return failure(toolName, '直すところが分からなかった。何を変えるか聞く');
    }

    const item = await store.updateItem(sub, target.itemId, changes);
    if (!item) return failure(toolName, 'その予定はもう無かった');
    console.log(`[Planner] updated: fields=${Object.keys(changes).join(',')}`);
    return {
      result: { ok: true, updated: describeForRaim(item) },
      change: { type: 'updated', item, changedFields: Object.keys(changes) },
    };
  }

  if (toolName === 'delete_schedule') {
    const text = String(userText || '');
    if (!DELETE_CONFIRM_WORDS.some((word) => text.includes(word))) {
      return failure(toolName, 'まだ消していない。先に「消していい？」と聞いて、ユーザーの答えを待つ');
    }
    const item = await store.deleteItem(sub, target.itemId);
    if (!item) return failure(toolName, 'その予定はもう無かった');
    console.log('[Planner] deleted');
    return {
      result: { ok: true, deleted: describeForRaim(item) },
      change: { type: 'deleted', item },
    };
  }

  return failure(toolName, `Unknown tool: ${toolName}`);
}

module.exports = {
  PLANNER_TOOL_DEFINITIONS,
  PLANNER_TOOL_NAMES,
  DELETE_CONFIRM_WORDS,
  isPlannerTool,
  runPlannerTool,
};
