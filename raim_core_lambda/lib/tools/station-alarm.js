'use strict';

// ==============================================================================
// 駅アラーム（アプリに頼むツール）
// ==============================================================================
//
// 「新宿で起こして」と言われたら、アプリの駅アラーム（乗車モード）を始める。
//
// 【他のツールとの違い】
// web_search / get_weather はサーバーが外部APIを呼んで結果をライムに返す。
// 駅アラームは、実際に動くのはアプリ（マイクで車内アナウンスを聞き、GPSで
// 駅への近さを見る）なので、サーバーは「アプリにこれをやって」と伝えるだけ。
//
//   1. ライムが start_station_alarm を呼ぶ
//   2. Core が stream.action をアプリへ送る（Edge で client_action に変換）
//   3. アプリが駅を探して乗車モードを始める
//   4. ライムには「頼んだ」という結果を返し、ライムが返事をする（「新宿で起こすね」）
//
// 駅データ（全国約9000駅）はアプリにしか無い。駅が見つからないときは
// アプリが自分で知らせる。サーバーは駅名の形だけ確かめる。
//
// 【見せる条件】
// アプリが features に station_alarm を入れて送ってきたときだけ、
// ライムにこのツールを見せる。駅アラームの無い Windows 版で
// 「起こすね」と言って何も起きない、を防ぐため。
// ==============================================================================

const STATION_ALARM_FEATURE = 'station_alarm';

// 駅名の上限。全国で一番長い駅名でも30文字に届かない
const MAX_STATION_NAME_LENGTH = 40;
const MAX_LINE_NAME_LENGTH = 40;
const MAX_KANA_LENGTH = 40;

/**
 * よみがなを検証する。ひらがな・カタカナ（長音符を含む）以外が混ざっていれば捨てる。
 * カタカナはひらがなに揃える（アプリの駅データのよみはひらがな）。
 */
function cleanKana(value) {
  const text = String(value ?? '').replace(/\s+/g, '').replace(/えき$/, '');

  if (!text || text.length > MAX_KANA_LENGTH) {
    return '';
  }

  if (!/^[\u3041-\u3096\u30A1-\u30FCー]+$/.test(text)) {
    return '';
  }

  return text.replace(/[\u30A1-\u30F6]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0x60)
  );
}

const STATION_ALARM_TOOL_DEFINITIONS = Object.freeze([
  {
    type: 'function',
    name: 'start_station_alarm',
    description: 'アプリの「駅アラーム」を始めます。電車で降りる駅が近づいたら、アプリが車内アナウンスとGPSを使ってユーザーに知らせます。ユーザーが「◯◯で起こして」「◯◯に着いたら教えて」「◯◯で降りるから寝過ごさないようにして」のように、降りる駅で知らせてほしいと頼んだときに使ってください。降りる駅が分からないときは使わず、どの駅か聞いてください。',
    parameters: {
      type: 'object',
      properties: {
        station: {
          type: 'string',
          description: '降りる駅の名前。「駅」は付けない（例: 新宿、神田、御茶ノ水）',
        },
        kana: {
          type: 'string',
          description: '駅名のよみがな（ひらがな）。表記ゆれ（お茶の水／御茶ノ水、四谷／四ツ谷）でも駅を見つけられるよう、できるだけ入れる（例: おちゃのみず）',
        },
        line: {
          type: 'string',
          description: '乗っている路線名。ユーザーが言ったときだけ入れる（例: 中央線、山手線）',
        },
      },
      required: ['station'],
    },
  },
  {
    type: 'function',
    name: 'stop_station_alarm',
    description: 'アプリの「駅アラーム」を止めます。「もう降りた」「アラーム止めて」「起こさなくていい」と言われたときに使ってください。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
]);

const STATION_ALARM_TOOL_NAMES = Object.freeze(
  STATION_ALARM_TOOL_DEFINITIONS.map((tool) => tool.name)
);

function cleanName(value, maxLength) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    // 「新宿駅」と言われても「新宿」で探せるようにする。
    // 路面電車には「広島駅」のような停留所もあるが、「広島」で探しても
    // アプリの検索（前方一致）で候補に出るので落としてよい
    .replace(/駅$/, '')
    .trim();

  if (!text || text.length > maxLength) {
    return '';
  }

  return text;
}

/**
 * ツール呼出を、アプリへ送る操作に変換する。
 * 引数が足りないなど送れないときは null。
 *
 * @returns {{ action: string, params: object } | null}
 */
function toStationAlarmAction(toolName, args = {}) {
  if (toolName === 'start_station_alarm') {
    const station = cleanName(args.station, MAX_STATION_NAME_LENGTH);

    if (!station) {
      return null;
    }

    const line = cleanName(args.line, MAX_LINE_NAME_LENGTH);
    const kana = cleanKana(args.kana);

    return {
      action: 'station_alarm.start',
      params: {
        station,
        ...(kana ? { kana } : {}),
        ...(line ? { line } : {}),
      },
    };
  }

  if (toolName === 'stop_station_alarm') {
    return {
      action: 'station_alarm.stop',
      params: {},
    };
  }

  return null;
}

/**
 * ライムへ返すツール結果。
 *
 * アプリが駅を見つけられたかはこの時点では分からない（アプリの中で探すため）。
 * 「頼んだ」ことだけを返し、見つからなかった場合はアプリが画面で知らせる。
 */
async function runStationAlarmTool(toolName, args = {}) {
  const request = toStationAlarmAction(toolName, args);

  if (!request) {
    return {
      error: true,
      message: '降りる駅の名前が分かりませんでした。どの駅で知らせればいいか、ユーザーに聞いてください。',
      tool: toolName,
    };
  }

  if (request.action === 'station_alarm.start') {
    return {
      ok: true,
      requested: 'アプリに駅アラームを頼みました',
      station: request.params.station,
      ...(request.params.line ? { line: request.params.line } : {}),
      note: '降りる駅が近づくと、アプリが車内アナウンスとGPSで知らせます。駅が見つからなかったときは、アプリが画面で知らせます。',
    };
  }

  return {
    ok: true,
    requested: 'アプリに駅アラームを止めるよう頼みました',
  };
}

module.exports = {
  STATION_ALARM_FEATURE,
  STATION_ALARM_TOOL_DEFINITIONS,
  STATION_ALARM_TOOL_NAMES,
  toStationAlarmAction,
  runStationAlarmTool,
};
