'use strict';

// ==============================================================================
// ツールレジストリ：Mantleへ渡すツール定義 + 実行関数の管理
// ==============================================================================
//
// 【ローカル版との違い】
//
// 1. ツール定義のスキーマ形式
//    ローカル（Ollama / Chat Completions）は、functionをネストする形式:
//      { type: 'function', function: { name, description, parameters } }
//
//    Mantle（Responses API）は、フラット形式:
//      { type: 'function', name, description, parameters }
//
//    このファイルではResponses API形式で定義し、
//    必要ならtoChatCompletionsFormat()で旧形式へ変換できるようにしている。
//
// 2. APIキーの扱い
//    Lambdaでは外部APIキーを環境変数へ平文で置かない。
//    Secrets Managerから取得したキーをexecuteTool()へ渡す。
//
// 3. 並列ツール呼出
//    Gemma 4は1ターンに複数のツール呼出をサポートしない（モデルカード記載）。
//    そのため呼出側は1件ずつ処理する。
//
// 【拡張方法】
// 1. lib/tools/<tool-name>.js を作成
// 2. TOOL_DEFINITIONS / TOOL_FUNCTIONS / TOOL_INTROS / TOOL_DESCRIPTIONS に登録
//
// 【アプリに頼むツール】
// 駅アラームのように、実際の動作をアプリが行うツールもある（station-alarm.js）。
// アプリが features で申告したときだけ getToolDefinitions() が含める。
// 呼ばれたら getClientAction() がアプリへ送る操作を返す。
//
// ==============================================================================

const { searchWeb } = require('./web-search');
const { getWeather, isCurrentLocation } = require('./get-weather');
const {
  STATION_ALARM_FEATURE,
  STATION_ALARM_TOOL_DEFINITIONS,
  STATION_ALARM_TOOL_NAMES,
  toStationAlarmAction,
  runStationAlarmTool,
} = require('./station-alarm');

// ─────────────────────────────────────────────
// ツール定義（Responses API 形式）
// ─────────────────────────────────────────────

const TOOL_DEFINITIONS = [
  {
    type: 'function',
    name: 'web_search',
    description: 'Web 検索を実行して最新情報を取得します。最新ニュース、雑学、知らないトピック、調べ物に使ってください。天気や時刻はこのツールを使わず、専用ツールを使ってください。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '検索クエリ（日本語または英語、できるだけ具体的に）',
        },
        max_results: {
          type: 'integer',
          description: '結果の最大件数（デフォルト3）',
        },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'get_weather',
    description: '都市の現在の天気情報を取得します。Web検索より構造化された天気データを返します。ユーザーが地名を言ったら、必ずその地名を英語（ローマ字）で city に入れてください（例: 八王子→Hachioji、東京→Tokyo）。地名を言っていないときだけ、city に "現在地" と入れてください。アプリが分かれば今いるあたりの天気を返します。都市を勝手に決めないでください。',
    parameters: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: '都市名（英語・ローマ字。例: Tokyo、Hachioji、Osaka）。ユーザーが地名を言っていないときだけ "現在地"',
        },
        country_code: {
          type: 'string',
          description: 'ISO 3166 国コード（例：JP）。省略可、日本の都市は不要',
        },
      },
      // 必須にしておく。任意にしたら、地名を言われていても省略されることがあった
      required: ['city'],
    },
  },
];

/**
 * 今回の会話でライムに見せるツール定義。
 *
 * features はアプリが使える機能（例: ['station_alarm']）。
 * 機能を持つアプリにだけ、その機能を使うツールを見せる。
 *
 * @param {{ features?: string[] }} options
 */
function getToolDefinitions({ features = [] } = {}) {
  const list = [...TOOL_DEFINITIONS];

  if (Array.isArray(features) && features.includes(STATION_ALARM_FEATURE)) {
    list.push(...STATION_ALARM_TOOL_DEFINITIONS);
  }

  return list;
}

/**
 * Chat Completions形式（functionをネストする形）へ変換する。
 *
 * Mantleが将来Chat Completions経由のツール呼出しか受け付けなくなった場合や、
 * ローカルOllamaと同じコードで検証したい場合に使う。
 */
function toChatCompletionsFormat(definitions = TOOL_DEFINITIONS) {
  return definitions.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

// ─────────────────────────────────────────────
// ツール実行関数のマッピング
// ─────────────────────────────────────────────
//
// secrets:
//   { tavilyApiKey, openWeatherMapApiKey }
//   Secrets Managerから取得した外部APIキー。

const TOOL_FUNCTIONS = {
  web_search: async (args, secrets = {}) => {
    return searchWeb(args.query, args.max_results, secrets.tavilyApiKey);
  },

  get_weather: async (args, secrets = {}, context = {}) => {
    return getWeather(args.city, args.country_code, secrets.openWeatherMapApiKey, {
      location: context.location,
    });
  },

  // アプリに頼むツール。外部APIは呼ばない
  start_station_alarm: async (args) => runStationAlarmTool('start_station_alarm', args),
  stop_station_alarm: async (args) => runStationAlarmTool('stop_station_alarm', args),
};

/**
 * アプリに頼むツールなら、アプリへ送る操作を返す。
 * 普通のツール、または引数が足りず送れないときは null。
 *
 * @returns {{ action: string, params: object } | null}
 */
function getClientAction(toolName, args = {}) {
  if (STATION_ALARM_TOOL_NAMES.includes(toolName)) {
    return toStationAlarmAction(toolName, args);
  }

  return null;
}

// ─────────────────────────────────────────────
// ツール呼出時の前置きセリフ
// ─────────────────────────────────────────────
//
// Gemmaはtool_callsを返すとき本文が空になるため、
// 「調べるね」に相当する発話をLLMに作らせることができない。
// そのためサーバー側で固定セリフを持ち、ライムの発話として先に送る。
//
// ローカル実装からそのまま移植。

const TOOL_INTROS = {
  web_search: {
    first: [
      'んー、ちょっと調べてみるね',
      'えっと、それ気になる。少し待って？',
      'あ、それ調べた方がいいな。ちょっと待って',
      'うーん、調べてみるよ',
    ],
    second: [
      'もう少し詳しく調べてみる',
      'ふむふむ、もうちょっと深掘りするね',
      'んー、別の角度からも見てみる',
    ],
    third: [
      '念のため、もうちょっと確認する',
      'えっと、最後に確認させて',
    ],
  },
  get_weather: {
    first: [
      '天気見てくる、ちょっと待って',
      'んー、天気ね。今チェックする',
      'あ、空のこと？調べるよ',
    ],
    second: [
      '他の地域の天気も確認するね',
      '別の天気情報も見てみる',
    ],
    third: [
      '念のため、もう一回見てみる',
    ],
  },
};

/**
 * ツール呼出の前置きセリフを取得する。
 *
 * @param {string} toolName
 * @param {number} turn 何回目のツール呼出か（1〜3）
 * @param {Function} random テスト時に固定できるよう注入可能
 */
function pickToolIntro(toolName, turn, random = Math.random) {
  // アプリに頼むツールは待ち時間が無いので、前置きは言わない。
  // 「ちょっと待って」の直後に「新宿で起こすね」が来ると不自然なため。
  if (STATION_ALARM_TOOL_NAMES.includes(toolName)) {
    return '';
  }

  const intros = TOOL_INTROS[toolName];

  if (!intros) {
    return 'えっと、ちょっと待って';
  }

  const key = turn === 1 ? 'first' : turn === 2 ? 'second' : 'third';
  const pool = intros[key] || intros.first;

  return pool[Math.floor(random() * pool.length)];
}

// ─────────────────────────────────────────────
// ツール説明文（クライアントのUI表示用）
// ─────────────────────────────────────────────

const TOOL_DESCRIPTIONS = {
  web_search: (args) => `「${args.query}」を検索しています`,
  get_weather: (args) => (isCurrentLocation(args.city)
    ? '今いるあたりの天気を調べています'
    : `${args.city}の天気を調べています`),
  start_station_alarm: () => '駅アラームを準備しています',
  stop_station_alarm: () => '駅アラームを止めています',
};

function getToolDescription(toolName, args = {}) {
  const fn = TOOL_DESCRIPTIONS[toolName];
  return fn ? fn(args) : `${toolName} を実行しています`;
}

// ─────────────────────────────────────────────
// ツール引数の正規化
// ─────────────────────────────────────────────
//
// Responses APIのfunction_callは arguments をJSON文字列で返す。
// ローカルのOllamaはobjectで返していたため、両方を受け付ける。

function parseToolArguments(rawArguments) {
  if (!rawArguments) return {};

  if (typeof rawArguments === 'object') {
    return rawArguments;
  }

  if (typeof rawArguments === 'string') {
    try {
      const parsed = JSON.parse(rawArguments);
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch {
      return {};
    }
  }

  return {};
}

/**
 * 重複ツール呼出の検知に使うキーを作る。
 *
 * 同じツールを同じ引数で呼ぶループを防ぐため、
 * 引数のキー順に依存しない安定した文字列を作る。
 */
function makeToolCallKey(toolName, args = {}) {
  const sorted = Object.keys(args)
    .sort()
    .map((key) => `${key}=${JSON.stringify(args[key])}`)
    .join('&');

  return `${toolName}(${sorted})`;
}

// ─────────────────────────────────────────────
// ツール実行
// ─────────────────────────────────────────────

/**
 * ツールを実行して結果を返す。
 *
 * ツールが失敗しても throw しない。
 * エラー内容をLLMへ返し、LLM側でフォールバック応答を作らせる。
 *
 * @param {string} toolName
 * @param {Object} args
 * @param {Object} secrets { tavilyApiKey, openWeatherMapApiKey }
 */
/**
 * 実在するツール名かどうかを返す。
 *
 * Gemma 4 が "tool_result" 等の存在しないツール名を捏造することがあるため、
 * intro を発話する前にこれで弾く。
 */
function isKnownTool(toolName) {
  return Object.prototype.hasOwnProperty.call(TOOL_FUNCTIONS, toolName);
}

async function executeTool(toolName, args, secrets = {}, context = {}) {
  const fn = TOOL_FUNCTIONS[toolName];

  if (!fn) {
    return {
      error: true,
      message: `Unknown tool: ${toolName}`,
      tool: toolName,
    };
  }

  const startedAt = Date.now();

  try {
    const result = await fn(args, secrets, context);
    console.log(`[Tool] ${toolName} completed in ${Date.now() - startedAt}ms`);
    return result;
  } catch (error) {
    console.error(`[Tool] ${toolName} failed: ${error.message}`);

    return {
      error: true,
      message: error.message,
      tool: toolName,
    };
  }
}

module.exports = {
  TOOL_DEFINITIONS,
  getToolDefinitions,
  getClientAction,
  toChatCompletionsFormat,
  executeTool,
  pickToolIntro,
  getToolDescription,
  parseToolArguments,
  makeToolCallKey,
  isKnownTool,
};
