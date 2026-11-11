'use strict';

// ==============================================================================
// 手で足した予定に、あとから知らせる文と大事さを付ける
// ==============================================================================
//
// 「予定とメモ」画面で手で足した予定や、「予定に入れる？」ボタンで足した予定は、
// Edge Lambda が保存する。Edge は LLM を呼ばないので、そのままだと知らせる文は
// 決まり文句のまま。Edge は保存したあと Request Queue に planner.enrich を入れ、
// Core がここで文を作って保存し、アプリへ planner.updated を送る。
//
// 安藤さんと決めた「手で追加した予定は、次につながったときに作る（それまでは決まり文句）」
// を、つながっている間にすぐ作る形で実現している。
// ==============================================================================

const PLANNER_ENRICH_TYPE = 'planner.enrich';

/**
 * Request Queue のメッセージ本文が planner.enrich なら、その中身を返す。違えば null。
 */
function parsePlannerEnrichMessage(body) {
  let payload;
  try {
    payload = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return null;
  }
  if (!payload || payload.type !== PLANNER_ENRICH_TYPE) return null;
  const sub = String(payload.sub || '').trim();
  const itemId = String(payload.itemId || '').trim();
  if (!sub || !itemId) return null;
  return {
    sub,
    itemId,
    connectionId: String(payload.connectionId || '').trim(),
    requestId: String(payload.requestId || '').trim(),
  };
}

/**
 * 知らせる文と大事さを作って保存し、アプリへ知らせる。
 *
 * @param {{ sub, itemId }} job
 * @param {{ store, writeEventExtras, createResponse, notify }} deps
 *   notify({ action, params }) はアプリへ client_action を送る（つながっていなければ何もしない）
 * @returns {Promise<boolean>} 保存したら true
 */
async function enrichPlannerItem(job, { store, writeEventExtras, createResponse, notify }) {
  const item = await store.getItem(job.sub, job.itemId);
  if (!item || item.kind !== 'event' || item.enriched) {
    return false;
  }

  const extras = await writeEventExtras({ title: item.title, note: item.note, createResponse });
  if (!extras.fromLlm) {
    return false;
  }

  const updated = await store.updateItem(job.sub, job.itemId, {
    lines: extras.lines,
    importance: extras.importance,
    enriched: true,
  });
  if (!updated) return false;

  console.log(`[Planner] enriched: importance=${updated.importance}`);
  if (notify) {
    await notify({ action: 'planner.updated', params: { item: updated } });
  }
  return true;
}

module.exports = {
  PLANNER_ENRICH_TYPE,
  parsePlannerEnrichMessage,
  enrichPlannerItem,
};
