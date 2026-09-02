// lib/tools/get-weather.js
// ==============================================================================
// OpenWeatherMap API を使った天気取得ツール（v2 日本語都市名対応版）
// ==============================================================================
//
// 【v2 での変更点】
// - 日本語都市名（"東京"、"大阪"等）が来た時に英語名（"Tokyo", "Osaka"）に自動変換
// - OpenWeatherMap は日本語に対応していないため、これがないと404になる
//
// 【マッピングの方針】
// よく使われる主要都市は事前定義。マイナーな都市はそのまま渡す（API がローマ字対応する場合あり）。
// プロンプトでも「英語名で指定」と LLM に指示してるので、基本は最初から英語で来るはず。
// このマッピングはフォールバック的な位置づけ。

'use strict';

const OWM_API_URL = 'https://api.openweathermap.org/data/2.5/weather';

// ─────────────────────────────────────────────
// 日本語 → 英語都市名マッピング
// ─────────────────────────────────────────────
// OpenWeatherMap が認識する英語/ローマ字表記
// 主要都市のみ。網羅じゃなく実用優先
const JP_TO_EN_CITY = {
  // 47都道府県庁所在地
  '東京': 'Tokyo',
  '札幌': 'Sapporo',
  '青森': 'Aomori',
  '盛岡': 'Morioka',
  '仙台': 'Sendai',
  '秋田': 'Akita',
  '山形': 'Yamagata',
  '福島': 'Fukushima',
  '水戸': 'Mito',
  '宇都宮': 'Utsunomiya',
  '前橋': 'Maebashi',
  'さいたま': 'Saitama',
  '埼玉': 'Saitama',
  '千葉': 'Chiba',
  '横浜': 'Yokohama',
  '新潟': 'Niigata',
  '富山': 'Toyama',
  '金沢': 'Kanazawa',
  '福井': 'Fukui',
  '甲府': 'Kofu',
  '長野': 'Nagano',
  '岐阜': 'Gifu',
  '静岡': 'Shizuoka',
  '名古屋': 'Nagoya',
  '津': 'Tsu',
  '大津': 'Otsu',
  '京都': 'Kyoto',
  '大阪': 'Osaka',
  '神戸': 'Kobe',
  '奈良': 'Nara',
  '和歌山': 'Wakayama',
  '鳥取': 'Tottori',
  '松江': 'Matsue',
  '岡山': 'Okayama',
  '広島': 'Hiroshima',
  '山口': 'Yamaguchi',
  '徳島': 'Tokushima',
  '高松': 'Takamatsu',
  '松山': 'Matsuyama',
  '高知': 'Kochi',
  '福岡': 'Fukuoka',
  '佐賀': 'Saga',
  '長崎': 'Nagasaki',
  '熊本': 'Kumamoto',
  '大分': 'Oita',
  '宮崎': 'Miyazaki',
  '鹿児島': 'Kagoshima',
  '那覇': 'Naha',
  '沖縄': 'Okinawa',
  // よく話題になる地名
  '渋谷': 'Shibuya',
  '新宿': 'Shinjuku',
  '池袋': 'Ikebukuro',
  '秋葉原': 'Akihabara',
  '梅田': 'Umeda',
};

/**
 * 都市名を OpenWeatherMap が認識できる形式に正規化
 * 日本語の場合は英語に変換、それ以外はそのまま返す
 */
function normalizeCityName(city) {
  if (!city || typeof city !== 'string') return city;
  const trimmed = city.trim();
  // マッピングにあれば変換
  if (JP_TO_EN_CITY[trimmed]) {
    console.log(`  [get_weather] City name normalized: ${trimmed} → ${JP_TO_EN_CITY[trimmed]}`);
    return JP_TO_EN_CITY[trimmed];
  }
  // 「東京都」「大阪府」「〇〇市」等の末尾を削って再試行
  const stripped = trimmed.replace(/(都|府|県|市|町|村)$/, '');
  if (stripped !== trimmed && JP_TO_EN_CITY[stripped]) {
    console.log(`  [get_weather] City name normalized: ${trimmed} → ${JP_TO_EN_CITY[stripped]}`);
    return JP_TO_EN_CITY[stripped];
  }
  // マッピングになければそのまま渡す
  return trimmed;
}

/**
 * OpenWeatherMap で都市の現在天気を取得
 */
async function getWeather(city, countryCode = null, injectedApiKey = null) {
  // Lambdaでは環境変数へ平文保存せず、Secrets Managerから取得したキーを注入する。
  // ローカル検証用に環境変数フォールバックも残す。
  const apiKey = injectedApiKey || process.env.OPENWEATHERMAP_API_KEY;
  if (!apiKey) {
    throw new Error('OPENWEATHERMAP_API_KEY is not configured');
  }
  if (!city || typeof city !== 'string') {
    throw new Error('city is required and must be a string');
  }

  // 都市名を正規化（日本語→英語）
  const normalizedCity = normalizeCityName(city);
  const queryParam = countryCode ? `${normalizedCity},${countryCode}` : normalizedCity;

  const url = new URL(OWM_API_URL);
  url.searchParams.set('q', queryParam);
  url.searchParams.set('appid', apiKey);
  url.searchParams.set('units', 'metric');
  url.searchParams.set('lang', 'ja');

  const res = await fetch(url.toString());

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`都市が見つかりません: ${city} (正規化後: ${normalizedCity})`);
    }
    if (res.status === 401) {
      throw new Error('OPENWEATHERMAP_API_KEY が無効、または有効化前です（登録後数時間〜半日かかる場合あり）');
    }
    const errText = await res.text();
    throw new Error(`OpenWeatherMap API error: ${res.status} ${errText}`);
  }

  const data = await res.json();

  return {
    city: data.name,
    country: data.sys?.country || 'unknown',
    weather: data.weather?.[0]?.main || 'unknown',
    description: data.weather?.[0]?.description || '',
    temp: Math.round(data.main?.temp ?? 0),
    feels_like: Math.round(data.main?.feels_like ?? 0),
    humidity: data.main?.humidity ?? 0,
    wind_speed: data.wind?.speed ?? 0,
    timestamp: new Date().toISOString(),
  };
}

module.exports = { getWeather };