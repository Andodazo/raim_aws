'use strict';

// ==============================================================================
// 朝のまとめ（その日はじめて開いたときの話しかけ）
// ==============================================================================
//
// 【決めたこと】（安藤さんと決めた）
//   - その日はじめて開いたとき、今日これからの予定があれば、時間帯に関係なく
//     話しかけをまとめにする（いつもの「3時間空いたら必ず・それ以外は30%」より優先）
//   - 予定は時間順。声で言うのは2件まで、3件以上は「ほかに2つあるよ」。
//     返事の下に、今日の予定を全部カードで出す（planner.show）
//   - 天気は当てはまる日だけひとこと。雨か雪の予報、最高気温30℃以上、最低気温5℃以下、
//     昨日との差5℃以上。判定はここのコードで行い、当たった日だけ LLM に天気を渡す
//   - 昨日の気温は、調べたときにサーバー（予定のテーブル）に残しておく
//   - 天気は「天気に現在地を使う」が ON のとき（アプリが現在地を送ってきたとき）だけ
//   - 2〜3文で短く。口調はいつもの人格のまま
//
// 「その日はじめて」かはアプリが決めて、話しかけに brief: true を付けて送る
// （アプリは端末に残した予定で当たりをつける。ここで予定を読み直して、無ければ普段の話しかけ）。
//
// 人格のプロンプト（prompts/）には触れず、状況のルールとしてここに置く。
// ==============================================================================

const { todayJst, addDays } = require('./planner-dates');
const { jstClock } = require('./planner-context');

const OWM_FORECAST_URL = 'https://api.openweathermap.org/data/2.5/forecast';
const WEATHER_TIMEOUT_MS = Number(process.env.BRIEF_WEATHER_TIMEOUT_MS || 3000);

// 声で言う予定の数
const SPOKEN_EVENTS = 2;

// 天気をひとこと言う条件
const HOT_MAX_C = 30;
const COLD_MIN_C = 5;
const SWING_C = 5;

// 昨日の気温を残しておく日数
const WEATHER_KEEP_DAYS = 3;

/**
 * 今日これからの予定（日付だけの予定と、まだ始まっていない時刻の予定）を時間順に。
 */
function todaysUpcomingEvents(items, now = new Date()) {
  const today = todayJst(now);
  const clock = jstClock(now.toISOString());
  return (items || [])
    .filter((item) => item?.kind === 'event' && item.date === today && (!item.time || item.time >= clock))
    .sort((a, b) => (
      String(a.time || '').localeCompare(String(b.time || '')) ||
      String(a.createdAt || '').localeCompare(String(b.createdAt || ''))
    ));
}

/**
 * 天気予報（3時間ごと）から、今日（日本時間）の最高・最低気温と、雨・雪の予報を出す。
 * 今日の分が無ければ null。
 */
function summarizeForecast(list, now = new Date()) {
  const today = todayJst(now);
  const slots = (Array.isArray(list) ? list : [])
    .filter((slot) => Number.isFinite(slot?.dt) && todayJst(new Date(slot.dt * 1000)) === today);
  if (slots.length === 0) return null;
  const temps = (key) => slots.map((s) => Number(s.main?.[key])).filter(Number.isFinite);
  const max = Math.max(...temps('temp_max'), ...temps('temp'));
  const min = Math.min(...temps('temp_min'), ...temps('temp'));
  const kinds = slots.flatMap((s) => (s.weather || []).map((w) => w?.main));
  return {
    date: today,
    max: Math.round(max),
    min: Math.round(min),
    rain: kinds.some((k) => ['Rain', 'Drizzle', 'Thunderstorm'].includes(k)),
    snow: kinds.includes('Snow'),
  };
}

/**
 * 天気をひとこと言う理由（当てはまらなければ空）。
 *
 * @param {{ max, min, rain, snow }} today
 * @param {{ max, min } | null} yesterday
 */
function weatherReasons(today, yesterday = null) {
  if (!today) return [];
  const reasons = [];
  if (today.snow) reasons.push({ id: 'snow', text: '今日は雪の予報。足もとや寒さの一言を添える' });
  else if (today.rain) reasons.push({ id: 'rain', text: '今日は雨の予報。傘の一言を添える' });
  if (today.max >= HOT_MAX_C) reasons.push({ id: 'hot', text: `最高気温${today.max}℃の予報。暑さの一言を添える` });
  if (today.min <= COLD_MIN_C) reasons.push({ id: 'cold', text: `最低気温${today.min}℃の予報。上着の一言を添える` });
  if (yesterday && Number.isFinite(yesterday.max)) {
    const diff = today.max - Number(yesterday.max);
    if (diff >= SWING_C) reasons.push({ id: 'warmer', text: `昨日より${diff}℃くらい暖かい予報` });
    if (diff <= -SWING_C) reasons.push({ id: 'colder', text: `昨日より${-diff}℃くらい寒い予報。上着の一言を添える` });
  }
  return reasons;
}

/**
 * 朝のまとめの指示。
 *
 * @param {{ events: object[], weather?: object[], followUpLines?: string[] }} params
 *   weather は weatherReasons の結果。followUpLines は終わったことを聞く行（follow-up.js）
 */
function buildBriefInstruction({ events, weather = [], followUpLines = [] }) {
  const spoken = events.slice(0, SPOKEN_EVENTS);
  const rest = events.length - spoken.length;
  const lines = [
    '【その日はじめての話しかけ（今日の予定）】',
    'ユーザーが今日はじめてアプリを開いた。ライムから先に、今日の予定を伝える。',
    '今日の予定（時間順）:',
    ...spoken.map((e) => (
      `- ${e.time || '時間は決まっていない'} ${e.title}` +
      `${e.importance === 'important' ? '（大事な予定）' : ''}` +
      `${e.note ? `（メモ: ${e.note}）` : ''}`
    )),
  ];
  if (rest > 0) lines.push(`- ほかに${rest}つ（声では言わず「ほかに${rest}つあるよ」とだけ言う）`);
  if (weather.length > 0) {
    lines.push('天気（当てはまったので、ひとことだけ触れる）:', ...weather.map((w) => `- ${w.text}`));
  }
  if (followUpLines.length > 0) lines.push(...followUpLines);
  lines.push(
    '- 2〜3文で短く。いつもの口調のまま。時間帯に合った挨拶を軽く添えてよい',
    '- 予定は上に書いたものだけ。言っていない予定を足さない',
    '- 大事な予定には軽く応援を添えてよい',
    '- 「通知」「アプリ」「まとめ」「合図」という言葉は使わない',
  );
  return lines.join('\n');
}

/**
 * 今日の天気予報を調べる（現在地は約10kmに丸めたもの）。調べられなければ null。
 */
async function fetchTodayForecast({ location, apiKey, now = new Date(), fetchImpl = fetch }) {
  if (!apiKey || !location || !Number.isFinite(location.lat) || !Number.isFinite(location.lon)) return null;
  const url = new URL(OWM_FORECAST_URL);
  url.searchParams.set('lat', String(location.lat));
  url.searchParams.set('lon', String(location.lon));
  url.searchParams.set('appid', apiKey);
  url.searchParams.set('units', 'metric');
  // 今日の残りが入れば足りる（3時間ごと×8＝24時間）
  url.searchParams.set('cnt', '8');
  const res = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(WEATHER_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`forecast HTTP ${res.status}`);
  const data = await res.json();
  return summarizeForecast(data?.list, now);
}

/**
 * 今日の天気と昨日の気温から、ひとこと言う理由を出す。今日の気温は明日のために残す。
 * 失敗しても朝のまとめは続ける（天気に触れないだけ）。
 */
async function briefWeather({ sub, location, now = new Date(), store, getApiKey, fetchImpl }) {
  if (!location) return [];
  try {
    const apiKey = await getApiKey();
    const today = await fetchTodayForecast({ location, apiKey, now, fetchImpl });
    if (!today) return [];
    const yesterdayDate = addDays(today.date, -1);
    let yesterday = null;
    try {
      yesterday = await store.getItem(sub, `wx_${yesterdayDate}`);
    } catch (error) {
      console.warn(`[Brief] yesterday weather read failed (non-fatal): ${error.message}`);
    }
    try {
      await store.saveWeather(sub, { date: today.date, max: today.max, min: today.min, keepDays: WEATHER_KEEP_DAYS });
    } catch (error) {
      console.warn(`[Brief] weather save failed (non-fatal): ${error.message}`);
    }
    const reasons = weatherReasons(today, yesterday);
    console.log(`[Brief] weather reasons=${reasons.map((r) => r.id).join(',') || 'none'}`);
    return reasons;
  } catch (error) {
    console.warn(`[Brief] weather failed (non-fatal): ${error.message}`);
    return [];
  }
}

module.exports = {
  SPOKEN_EVENTS,
  todaysUpcomingEvents,
  summarizeForecast,
  weatherReasons,
  buildBriefInstruction,
  fetchTodayForecast,
  briefWeather,
};
