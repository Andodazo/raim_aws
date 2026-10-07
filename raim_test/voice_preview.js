#!/usr/bin/env node
/**
 * voice-config.json の声の設定を、耳で確かめるための試聴ツール。
 *
 * 自分の PC で VOICEVOX（エンジン）を起動した状態で実行する。CloudShell では動かない。
 * 各プロファイル × 各感情の wav を voice_preview/ に書き出すので、聞き比べて
 * raim_core_lambda/voice-config.json の数値を直す → もう一度実行、をくり返す。
 *
 * 使い方（raim_test フォルダで。Node 18 以上）
 *   node voice_preview.js                              全部作る（2プロファイル × 12感情）
 *   node voice_preview.js --profile tsumugi_downer     1つのプロファイルだけ
 *   node voice_preview.js --emotion thoughtful         1つの感情だけ
 *   node voice_preview.js --text "今日はいい天気だね"   全部同じ文で読む（違いを比べやすい）
 *   node voice_preview.js --intensity 0.6              強さ 0.6 で読む（既定は 1.0）
 *   node voice_preview.js --host http://127.0.0.1:50021
 *
 * 強さについて
 *   本番では neutral の値と感情の値の間を、感情の強さで補間して使う（voice-mapper.js）。
 *   --intensity 1.0 は設定した値そのもの。0.5 なら neutral との中間になる。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'raim_core_lambda', 'voice-config.json');
const OUT_DIR = path.join(__dirname, 'voice_preview');
const KEYS = ['speedScale', 'pitchScale', 'intonationScale', 'volumeScale'];

// 感情ごとの読み上げ文。人格に合わせた言い方にしてある（そのまま会話で使うわけではない）
const SAMPLE_LINES = {
  bright: {
    neutral: 'そうなんだ、今日は学校だったんだね。',
    happy: 'ほんとに？それ、すごく嬉しいな！',
    sad: 'そっか…それはちょっと寂しいね。',
    angry: 'えー、それはひどいよ。ちゃんと怒っていいと思う。',
    surprised: 'えっ、うそ！もう終わっちゃったの？',
    caring: '無理しないでね。今日はゆっくり休んでほしいな。',
    embarrassed: 'そんなに褒められると、恥ずかしいけど嬉しいな。',
    excited: 'やったー！ずっと待ってたんだ、早く遊びたいな！',
    curious: 'それってどんな感じなの？もっと聞きたいな。',
    amused: 'あはは、それはちょっと面白いね。',
    thoughtful: 'うーん、どっちがいいかな。ちょっと考えてみるね。',
    playful: 'じゃあ、当ててみて？ヒントはね、青いものだよ。',
  },
  downer: {
    neutral: 'ん、今日は学校だったんだ。',
    happy: '…よかったね。ちょっと嬉しいかも。',
    sad: 'そっか。…それはしんどかったね。',
    angry: 'それは、さすがにひどいと思う。',
    surprised: 'え、もう終わったの？早いね。',
    caring: 'まあ、無理しなくていいんじゃない？今日はもう休も。',
    embarrassed: '…そんなに言われると、ちょっと照れる。',
    excited: 'え、それ出たの？あのシリーズ、ずっと待ってたんだよね。',
    curious: 'ふーん、それってどんな感じ？',
    amused: 'ふ、それはちょっと面白いかも。',
    thoughtful: 'んー、どっちだろうね。ちょっと考える。',
    playful: 'じゃあ、当ててみて。…ヒントは、青いもの。',
  },
};

function parseArgs(argv) {
  const args = { intensity: 1, host: 'http://127.0.0.1:50021' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--profile') { args.profile = value; i += 1; }
    else if (key === '--emotion') { args.emotion = value; i += 1; }
    else if (key === '--text') { args.text = value; i += 1; }
    else if (key === '--intensity') { args.intensity = Number(value); i += 1; }
    else if (key === '--host') { args.host = value.replace(/\/$/, ''); i += 1; }
    else {
      console.error(`知らないオプションです: ${key}`);
      process.exit(1);
    }
  }
  if (!Number.isFinite(args.intensity) || args.intensity < 0 || args.intensity > 1) {
    console.error('--intensity は 0〜1 の数で指定してください');
    process.exit(1);
  }
  return args;
}

// voice-mapper.js と同じ補間
function blend(neutral, target, intensity) {
  const params = {};
  for (const key of KEYS) {
    const from = Number(neutral[key]);
    const to = Number(target[key] ?? from);
    params[key] = Math.round((from + (to - from) * intensity) * 1000) / 1000;
  }
  return params;
}

function personaOf(profileName, config) {
  const entry = Object.entries(config.persona_profiles || {}).find(([, name]) => name === profileName);
  return entry ? entry[0] : (profileName.includes('downer') ? 'downer' : 'bright');
}

async function synthesize(host, speaker, text, params) {
  const queryRes = await fetch(
    `${host}/audio_query?speaker=${speaker}&text=${encodeURIComponent(text)}`,
    { method: 'POST' }
  );
  if (!queryRes.ok) throw new Error(`audio_query ${queryRes.status}: ${await queryRes.text()}`);
  const query = await queryRes.json();
  Object.assign(query, params);

  const synthRes = await fetch(`${host}/synthesis?speaker=${speaker}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
  });
  if (!synthRes.ok) throw new Error(`synthesis ${synthRes.status}: ${await synthRes.text()}`);
  return Buffer.from(await synthRes.arrayBuffer());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

  // VOICEVOX が起動しているか先に確かめる
  try {
    const res = await fetch(`${args.host}/version`);
    console.log(`VOICEVOX ${await res.text()} に接続しました（${args.host}）`);
  } catch (error) {
    console.error(`VOICEVOX に接続できません（${args.host}）。VOICEVOX を起動してからもう一度実行してください。`);
    process.exit(1);
  }

  const profileNames = args.profile ? [args.profile] : Object.keys(config.profiles);
  const rows = [];

  for (const profileName of profileNames) {
    const profile = config.profiles[profileName];
    if (!profile) {
      console.error(`プロファイルがありません: ${profileName}`);
      process.exit(1);
    }
    const persona = personaOf(profileName, config);
    const emotions = args.emotion ? [args.emotion] : Object.keys(profile.emotion_map);
    const dir = path.join(OUT_DIR, profileName);
    fs.mkdirSync(dir, { recursive: true });

    for (const emotion of emotions) {
      const target = profile.emotion_map[emotion];
      if (!target) {
        console.error(`${profileName} に ${emotion} がありません`);
        continue;
      }
      const params = blend(profile.emotion_map.neutral, target, args.intensity);
      const text = args.text || SAMPLE_LINES[persona][emotion] || SAMPLE_LINES[persona].neutral;
      const speaker = Number(target.speaker_id ?? profile.default_speaker_id ?? 8);

      const wav = await synthesize(args.host, speaker, text, params);
      // 番号は感情の並び順。どのプロファイルでも同じ感情は同じ番号になる
      const order = Object.keys(profile.emotion_map).indexOf(emotion) + 1;
      const file = path.join(dir, `${String(order).padStart(2, '0')}_${emotion}.wav`);
      fs.writeFileSync(file, wav);

      rows.push({ profileName, emotion, params, text, file });
      console.log(
        `${profileName.padEnd(20)} ${emotion.padEnd(12)} ` +
        KEYS.map((key) => `${key.replace('Scale', '')}=${params[key]}`).join(' ') +
        `  ${text}`
      );
    }
  }

  // 聞きながら見られるよう、一覧を書き出す
  const list = rows.map((row) =>
    [path.relative(__dirname, row.file), row.profileName, row.emotion, ...KEYS.map((k) => row.params[k]), row.text].join('\t')
  );
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(OUT_DIR, 'list.tsv'),
    ['file\tprofile\temotion\t' + KEYS.join('\t') + '\ttext', ...list].join('\n') + '\n'
  );
  console.log(`\n${rows.length}個の wav を ${OUT_DIR} に書き出しました（一覧: list.tsv）`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
