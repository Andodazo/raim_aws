'use strict';

// ==============================================================================
// 事実の質問への対策（知ったかぶり防止）
// ==============================================================================
//
// 【なぜ必要か】
// Gemma 4 は、人名・作品・誰の曲かのような「決まった事実」をよく間違える。
// しかもモデル自身は「知らない」ことに気づけないので、プロンプトに
// 「知らなければ調べて」と書くだけでは、知っているつもりで答えてしまう。
// 2026-10 の会話サンプルでも「ジャイロの星のPlatinum」「ジェラードンは
// 昔トリオだった」のような間違いが、検索せずに出ていた。
//
// そこで、事実を聞いている形の発話のときだけ、サーバー側から
// 「今回は web_search で調べてから答える」という指示を足す。
// モデルの判断に任せず、調べるきっかけを外から作る。
//
// 【環境変数】
// FACT_CHECK_SEARCH       'true'（既定）で有効、'false' で無効
// SCENE_REASONING_EFFORTS Scene ごとの reasoning effort。例: 'question=low'
//                         未設定なら全 Scene で MANTLE_REASONING_EFFORT（既定 none）

// 事実を聞いている形の発話
const FACT_PATTERNS = [
  /知って(る|ます|た|い)/,
  /って(誰|だれ|何者)/,
  /について(教えて|知りたい)/,
  /どんな(人|曲|作品|ゲーム|アニメ|漫画|マンガ|映画|ドラマ|キャラ|店|お店|グループ|バンド)/,
  /(誰|だれ)が(歌|作|書|描|出|演|監督)/,
];

// 自分たちのこと（ユーザーやライム自身）を聞いているときは調べない。
// 「私の名前知ってる？」を Web で検索しても意味がないため。
const SELF_PATTERN = /(私|わたし|俺|おれ|僕|ぼく|自分|ライム|あなた|きみ|君)(の|って|は|を|が|こと)/;

// 天気は get_weather の担当
const EXCLUDE_PATTERN = /天気|気温/;

function isFactQuestion(text) {
  const value = String(text || '');
  if (!value.trim()) return false;
  if (EXCLUDE_PATTERN.test(value) || SELF_PATTERN.test(value)) return false;
  return FACT_PATTERNS.some((pattern) => pattern.test(value));
}

function isFactCheckEnabled(env = process.env) {
  return String(env.FACT_CHECK_SEARCH ?? 'true').trim().toLowerCase() !== 'false';
}

const FACT_CHECK_INSTRUCTION = [
  '【今回は調べてから答える】',
  'ユーザーは人・作品・ゲーム・お店などの事実を聞いている。',
  '知っているつもりでも、先に web_search で調べてから答える。',
  '調べても分からなければ、知ったかぶりせず「分からなかった」と言う。',
].join('\n');

/**
 * Scene ごとの reasoning effort を返す。指定が無ければ空文字（＝通常どおり）。
 *
 * 例: SCENE_REASONING_EFFORTS='question=low,advice=low'
 */
function resolveSceneReasoningEffort(sceneId, env = process.env) {
  const setting = String(env.SCENE_REASONING_EFFORTS || '').trim();
  if (!setting || !sceneId) return '';

  for (const pair of setting.split(',')) {
    const [id, effort] = pair.split('=').map((part) => String(part || '').trim());
    if (id === sceneId && effort) return effort;
  }
  return '';
}

module.exports = {
  isFactQuestion,
  isFactCheckEnabled,
  FACT_CHECK_INSTRUCTION,
  resolveSceneReasoningEffort,
};
