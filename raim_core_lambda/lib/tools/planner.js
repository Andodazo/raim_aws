'use strict';

// ==============================================================================
// 予定の手帳のツール（サーバーで保存して、アプリに知らせる）
// ==============================================================================
//
// 「金曜10時に面接、入れといて」と頼まれたら、ライムが add_schedule を呼ぶ。
// 「3分計って」なら set_timer（タイマーも同じ手帳に入れて、全部の端末で鳴らす）。
// 「メモして」「買うものに牛乳足して」なら add_memo / add_to_list（メモ帳も同じ手帳）。
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
const {
  findItemByShortId,
  activeTimers,
  jstClock,
  memosOf,
  listsOf,
  shortIdOf,
} = require('../planner/planner-context');
const {
  MAX_MEMO_LENGTH,
  MAX_LIST_TITLE_LENGTH,
  MAX_ENTRY_LENGTH,
  MAX_ENTRIES_PER_LIST,
  MAX_LISTS_PER_USER,
  looksSecret,
  findListByName,
  matchEntries,
  keyOf,
  newEntryId,
} = require('../planner/planner-memo');
const { sameThing } = require('../planner/follow-up');
const {
  MAX_ITEMS_PER_USER,
  MAX_TITLE_LENGTH,
  MAX_TIMER_SECONDS,
  MAX_ACTIVE_TIMERS,
} = require('../planner/planner-store');

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
  {
    type: 'function',
    name: 'set_timer',
    description: 'タイマーを始めます。時間が来たら、ユーザーの全部の端末で鳴ります。「3分計って」「30分たったら教えて」のように、はっきり頼まれたときだけ使ってください。24時間までです。',
    parameters: {
      type: 'object',
      properties: {
        hours: { type: 'integer', description: '時間（なければ 0）' },
        minutes: { type: 'integer', description: '分（なければ 0）。「1時間半」なら hours=1, minutes=30' },
        seconds: { type: 'integer', description: '秒（なければ 0）' },
        label: { type: 'string', description: '何のタイマーか（例: カップ麺、洗濯）。言われなければ空' },
      },
    },
  },
  {
    type: 'function',
    name: 'cancel_timer',
    description: '動いているタイマーを止めます。「タイマーやめて」「もういいよ」と頼まれたときに使ってください。聞き返さずに止めてかまいません。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '「動いているタイマー」の id。1つしか無ければ空でよい' },
      },
    },
  },
  {
    type: 'function',
    name: 'add_memo',
    description: 'ユーザーのメモを1つ残します（例: 駐輪場は3階）。「メモして」「控えといて」とはっきり頼まれたときだけ使ってください。買うものなど、チェックしたい項目の並びは add_to_list を使ってください。パスワードや暗証番号はメモしないでください。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'メモする内容。短く' },
      },
      required: ['text'],
    },
  },
  {
    type: 'function',
    name: 'add_to_list',
    description: 'チェックできるリスト（買うもの・持ち物など）に項目を足します。リストが無ければ作ります。「買うものに牛乳足して」のように頼まれたときに使ってください。',
    parameters: {
      type: 'object',
      properties: {
        list: { type: 'string', description: 'リストの名前（例: 買うもの、持ち物）。「リスト」の id でもよい' },
        entries: {
          type: 'array',
          items: { type: 'string' },
          description: '足す項目（例: ["牛乳", "卵"]）',
        },
      },
      required: ['list', 'entries'],
    },
  },
  {
    type: 'function',
    name: 'check_list_entries',
    description: 'リストの項目にチェックを付けます。「牛乳買った」「レポート終わった」のように済んだと言われたら、聞き返さずに使ってください。チェックした項目は次の日に消えます。',
    parameters: {
      type: 'object',
      properties: {
        list: { type: 'string', description: 'リストの名前か id。分からなければ空' },
        entries: {
          type: 'array',
          items: { type: 'string' },
          description: 'チェックする項目（例: ["牛乳"]）',
        },
      },
      required: ['entries'],
    },
  },
  {
    type: 'function',
    name: 'remove_list_entries',
    description: 'リストから項目を消します（「卵はもういらない」のように頼まれたとき）。',
    parameters: {
      type: 'object',
      properties: {
        list: { type: 'string', description: 'リストの名前か id。分からなければ空' },
        entries: {
          type: 'array',
          items: { type: 'string' },
          description: '消す項目',
        },
      },
      required: ['entries'],
    },
  },
  {
    type: 'function',
    name: 'show_memos',
    description: 'メモやリストをカードで見せます。「メモ何あったっけ？」なら id を空に、「買うもの何だっけ？」ならそのリストの id を入れてください。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '見せるメモかリストの id。メモ全部なら空' },
      },
    },
  },
  {
    type: 'function',
    name: 'delete_memo',
    description: 'メモかリストを丸ごと消します。「〇〇、消していい？」と聞いて、ユーザーが「うん」などと答えたあとにだけ使ってください。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '「メモ」か「リスト」の id' },
      },
      required: ['id'],
    },
  },
]);

const TIMER_TOOL_NAMES = Object.freeze(['set_timer', 'cancel_timer']);
const MEMO_TOOL_NAMES = Object.freeze([
  'add_memo', 'add_to_list', 'check_list_entries', 'remove_list_entries', 'show_memos', 'delete_memo',
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

/** 「1時間30分」「3分」「45秒」 */
function formatDuration(totalSec) {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const sec = totalSec % 60;
  return [h ? `${h}時間` : '', m ? `${m}分` : '', sec ? `${sec}秒` : ''].join('') || '0秒';
}

function describeTimerForRaim(item) {
  return {
    id: item.itemId.replace(/^[a-z]+_/, '').slice(0, 6),
    label: item.title,
    length: formatDuration(Number(item.durationSec) || 0),
    ringsAt: jstClock(item.endsAt),
  };
}

/** 引数の数を整数に（文字の「3」も受ける）。負の数・おかしな値は 0 */
function toCount(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function runTimerTool(toolName, args, { sub, store, items, now }) {
  if (toolName === 'set_timer') {
    const total = toCount(args.hours) * 3600 + toCount(args.minutes) * 60 + toCount(args.seconds);
    if (total < 1) {
      return failure(toolName, '何分か分からなかったので始めていない。何分か聞く');
    }
    if (total > MAX_TIMER_SECONDS) {
      return failure(toolName, '24時間より長いのでタイマーにしていない。予定に入れるか聞く');
    }
    if (activeTimers(items, now).length >= MAX_ACTIVE_TIMERS) {
      return failure(toolName, 'タイマーが多すぎて始められなかった。いらないタイマーを止めてもらう');
    }
    const label = String(args.label || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_LENGTH);
    const item = await store.addTimer(sub, { title: label || 'タイマー', durationSec: total, source: 'raim' });
    console.log(`[Planner] timer started: seconds=${total}`);
    return {
      result: {
        ok: true,
        started: describeTimerForRaim(item),
        note: '時間になったら全部の端末で鳴る。何分のタイマーか短く言う',
      },
      change: { type: 'added', item },
    };
  }

  // cancel_timer
  const timers = activeTimers(items, now);
  if (timers.length === 0) {
    return failure(toolName, '動いているタイマーは無かった。そう伝える');
  }
  let target = null;
  if (args.id && String(args.id).trim()) {
    target = findItemByShortId(timers, args.id);
  } else if (timers.length === 1) {
    [target] = timers;
  }
  if (!target) {
    return failure(toolName, 'どのタイマーか分からなかったので止めていない。どれを止めるか聞く');
  }
  const item = await store.deleteItem(sub, target.itemId);
  if (!item) return failure(toolName, 'そのタイマーはもう無かった');
  console.log('[Planner] timer cancelled');
  return {
    result: { ok: true, cancelled: describeTimerForRaim(item) },
    change: { type: 'deleted', item },
  };
}

/** 声で言うのは新しい順に3件まで（安藤さんと決めた） */
const SPOKEN_MEMOS = 3;

function describeListForRaim(item) {
  const entries = item.entries || [];
  return {
    id: shortIdOf(item.itemId),
    list: item.title,
    notYet: entries.filter((e) => !e.checked).map((e) => e.text),
    checked: entries.filter((e) => e.checked).map((e) => e.text),
  };
}

/** 引数の項目を、文字の並びにそろえる（"牛乳、卵" のような1つの文字も分ける） */
function toEntryTexts(value) {
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .flatMap((v) => String(v ?? '').split(/[、,，]/))
    .map((v) => v.replace(/\s+/g, ' ').trim().slice(0, MAX_ENTRY_LENGTH))
    .filter(Boolean);
}

/** リストを id か名前で探す。指定が無ければ、リストが1つだけのときそれ */
function pickList(lists, ref) {
  const key = String(ref || '').trim();
  if (!key) return lists.length === 1 ? lists[0] : null;
  return findItemByShortId(lists, key) || findListByName(lists, key);
}

async function runMemoTool(toolName, args, { sub, store, items, userText, now }) {
  const lists = listsOf(items);

  if (toolName === 'add_memo') {
    const text = String(args.text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_MEMO_LENGTH);
    if (!text) return failure(toolName, '何をメモするか分からなかった。聞く');
    if (looksSecret(text) || looksSecret(userText)) {
      return failure(toolName, 'パスワードや暗証番号のようなものなのでメモしていない。「それは自分で控えてね」と伝える');
    }
    if (items.length >= MAX_ITEMS_PER_USER) {
      return failure(toolName, 'メモ帳がいっぱいで入れられなかった。古いメモを消してもらう');
    }
    const item = await store.addMemo(sub, { text, source: 'raim' });
    console.log('[Planner] memo added');
    return {
      result: { ok: true, memo: { id: shortIdOf(item.itemId), text: item.text }, note: '何をメモしたか短く言う' },
      change: { type: 'added', item },
    };
  }

  if (toolName === 'add_to_list') {
    const texts = toEntryTexts(args.entries);
    if (texts.length === 0) return failure(toolName, '何を足すか分からなかった。聞く');
    if (texts.some(looksSecret) || looksSecret(userText)) {
      return failure(toolName, 'パスワードや暗証番号のようなものなので入れていない。「それは自分で控えてね」と伝える');
    }
    const name = String(args.list || '').replace(/\s+/g, ' ').trim().slice(0, MAX_LIST_TITLE_LENGTH);
    const existing = pickList(lists, name);
    if (!existing) {
      if (!name) return failure(toolName, 'どのリストか分からなかった。何のリストか聞く');
      if (lists.length >= MAX_LISTS_PER_USER || items.length >= MAX_ITEMS_PER_USER) {
        return failure(toolName, 'リストが多すぎて作れなかった。いらないリストを消してもらう');
      }
      const item = await store.addList(sub, { title: name, entries: texts, source: 'raim' });
      console.log(`[Planner] list created: entries=${item.entries.length}`);
      return {
        result: { ok: true, created: describeListForRaim(item), note: '何をどのリストに入れたか短く言う' },
        change: { type: 'added', item, params: { addedEntryIds: item.entries.map((e) => e.id) } },
      };
    }

    // 同じ項目がまだ残っていれば足さない。チェック済みなら、チェックを外して戻す
    const entries = (existing.entries || []).map((e) => ({ ...e }));
    const touched = [];
    for (const text of texts) {
      const same = entries.find((e) => keyOf(e.text) === keyOf(text));
      if (same) {
        if (same.checked) {
          same.checked = false;
          delete same.checkedAt;
          touched.push(same.id);
        }
        continue;
      }
      if (entries.length >= MAX_ENTRIES_PER_LIST) break;
      const entry = { id: newEntryId(), text, checked: false };
      entries.push(entry);
      touched.push(entry.id);
    }
    if (touched.length === 0) {
      return { result: { ok: true, alreadyThere: describeListForRaim(existing), note: 'もう入っていたと短く言う' }, change: null };
    }
    const item = await store.updateItem(sub, existing.itemId, { entries });
    if (!item) return failure(toolName, 'そのリストはもう無かった');
    console.log(`[Planner] list entries added: count=${touched.length}`);
    return {
      result: { ok: true, updated: describeListForRaim(item), note: '何を足したか短く言う' },
      change: { type: 'updated', item, params: { addedEntryIds: touched } },
    };
  }

  if (toolName === 'check_list_entries' || toolName === 'remove_list_entries') {
    const texts = toEntryTexts(args.entries);
    if (texts.length === 0) return failure(toolName, 'どの項目か分からなかった。聞く');
    // リストの指定が無ければ、項目が当たるリストを探す（1つに決まるときだけ）
    let target = pickList(lists, args.list);
    if (!target && !String(args.list || '').trim()) {
      const hits = lists.filter((list) => matchEntries(list.entries || [], texts).length > 0);
      if (hits.length === 1) [target] = hits;
    }
    if (!target) return failure(toolName, 'どのリストか分からなかった。どのリストか聞く');
    const hits = new Set(matchEntries(
      (target.entries || []).filter((e) => toolName === 'remove_list_entries' || !e.checked),
      texts,
    ).map((e) => e.id));
    if (hits.size === 0) {
      return failure(toolName, `「${target.title}」にその項目は無かった。そう伝える`);
    }
    const at = now.toISOString();
    const entries = toolName === 'check_list_entries'
      ? (target.entries || []).map((e) => (hits.has(e.id) ? { ...e, checked: true, checkedAt: at } : e))
      : (target.entries || []).filter((e) => !hits.has(e.id));
    const item = await store.updateItem(sub, target.itemId, { entries });
    if (!item) return failure(toolName, 'そのリストはもう無かった');
    console.log(`[Planner] list entries ${toolName === 'check_list_entries' ? 'checked' : 'removed'}: count=${hits.size}`);
    return {
      result: {
        ok: true,
        list: describeListForRaim(item),
        note: toolName === 'check_list_entries' ? 'チェックしたと短く言う' : '消したと短く言う',
      },
      change: { type: 'updated', item },
    };
  }

  if (toolName === 'show_memos') {
    const memos = memosOf(items);
    const ref = String(args.id || '').trim();
    if (ref) {
      const target = findItemByShortId([...memos, ...lists], ref) || findListByName(lists, ref);
      if (!target) return failure(toolName, 'その id のメモは無かった');
      return {
        result: target.kind === 'list'
          ? { ok: true, ...describeListForRaim(target), note: 'カードで見せている。まだの項目を短く言う' }
          : { ok: true, memo: target.text, note: 'カードで見せている。短く言う' },
        change: { type: 'show', items: [target] },
      };
    }
    if (memos.length === 0 && lists.length === 0) {
      return failure(toolName, 'メモはまだ1つも無い。そう伝える');
    }
    const spoken = memos.slice(0, SPOKEN_MEMOS).map((m) => m.text);
    return {
      result: {
        ok: true,
        newestMemos: spoken,
        moreMemos: Math.max(0, memos.length - spoken.length),
        lists: lists.map((l) => l.title),
        note: 'カードで全部見せている。声で言うのは newestMemos だけ。moreMemos があれば「あと〇件あるよ」と言う',
      },
      change: { type: 'show', items: memos.length > 0 ? memos : lists },
    };
  }

  // delete_memo
  const target = findItemByShortId([...memosOf(items), ...lists], args.id);
  if (!target) return failure(toolName, 'その id のメモは無かった。どれか聞く');
  if (!DELETE_CONFIRM_WORDS.some((word) => String(userText || '').includes(word))) {
    return failure(toolName, 'まだ消していない。先に「消していい？」と聞いて、ユーザーの答えを待つ');
  }
  const item = await store.deleteItem(sub, target.itemId);
  if (!item) return failure(toolName, 'そのメモはもう無かった');
  console.log(`[Planner] ${item.kind} deleted`);
  return {
    result: { ok: true, deleted: item.kind === 'list' ? `リスト「${item.title}」` : `メモ「${item.text}」` },
    change: { type: 'deleted', item },
  };
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
  if (TIMER_TOOL_NAMES.includes(toolName)) {
    return runTimerTool(toolName, args || {}, { sub, store, items, now });
  }
  if (MEMO_TOOL_NAMES.includes(toolName)) {
    return runMemoTool(toolName, args || {}, { sub, store, items, userText, now });
  }
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
    // 「予定に入れる？」で持っていた同じこと（あとで聞くこと）は、予定のほうで聞くので消す
    const removedIds = [];
    for (const followUp of items.filter((other) => other?.kind === 'followup' && sameThing(other, item))) {
      try {
        await store.deleteItem(sub, followUp.itemId);
        removedIds.push(followUp.itemId);
      } catch (error) {
        console.warn(`[FollowUp] remove failed (non-fatal): ${error.message}`);
      }
    }
    return {
      result: {
        ok: true,
        added: describeForRaim(item),
        note: 'アプリが前の日の夜と1時間前（時間が無ければ当日の朝）に知らせる。何をいつ入れたか短く言う',
      },
      change: { type: 'added', item, ...(removedIds.length > 0 ? { params: { removedIds } } : {}) },
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
