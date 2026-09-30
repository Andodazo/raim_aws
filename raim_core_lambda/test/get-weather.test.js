'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { getWeather } = require('../lib/tools/get-weather');
const { executeTool, getToolDescription } = require('../lib/tools');

const OWM_OK = {
  name: 'Hachioji',
  sys: { country: 'JP' },
  weather: [{ main: 'Clouds', description: '曇りがち' }],
  main: { temp: 21.4, feels_like: 21.0, humidity: 70 },
  wind: { speed: 2.1 },
};

function mockFetch(t) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url) => {
    calls.push(new URL(url));
    return { ok: true, status: 200, json: async () => OWM_OK };
  };
  t.after(() => {
    global.fetch = original;
  });
  return calls;
}

test('場所の指定が無ければ現在地（緯度・経度）で引く', async (t) => {
  const calls = mockFetch(t);

  const result = await getWeather('', null, 'key', {
    location: { lat: 35.7, lon: 139.3 },
  });

  assert.equal(calls[0].searchParams.get('lat'), '35.7');
  assert.equal(calls[0].searchParams.get('lon'), '139.3');
  assert.equal(calls[0].searchParams.get('q'), null);
  assert.equal(result.city, 'Hachioji');
  assert.equal(result.source, 'current_location');
});

test('都市が指定されていれば現在地より都市を優先する', async (t) => {
  const calls = mockFetch(t);

  const result = await getWeather('大阪', null, 'key', {
    location: { lat: 35.7, lon: 139.3 },
  });

  assert.equal(calls[0].searchParams.get('q'), 'Osaka');
  assert.equal(calls[0].searchParams.get('lat'), null);
  assert.equal(result.source, undefined);
});

test('場所も現在地も無ければ、API を呼ばずに聞き返すよう返す', async (t) => {
  const calls = mockFetch(t);

  const result = await getWeather(undefined, null, 'key', {});

  assert.equal(calls.length, 0);
  assert.equal(result.needs_place, true);
  // エラー扱いにしない（「調べられなかった」ではなく、場所を聞いてほしい）
  assert.equal(result.error, undefined);
});

test('executeTool が現在地を get_weather へ渡す', async (t) => {
  const calls = mockFetch(t);

  await executeTool(
    'get_weather',
    {},
    { openWeatherMapApiKey: 'key' },
    { location: { lat: 35.7, lon: 139.3 } }
  );

  assert.equal(calls[0].searchParams.get('lat'), '35.7');
});

test('場所の指定が無いときの表示文', () => {
  assert.equal(getToolDescription('get_weather', {}), '今いるあたりの天気を調べています');
  assert.equal(getToolDescription('get_weather', { city: '東京' }), '東京の天気を調べています');
});
