'use strict';

// ==============================================================================
// 予定が変わったことを、同じ人のほかの端末へ知らせる
// ==============================================================================
//
// 予定とタイマーは Windows とスマホで共有する（安藤さんと決めた）。
// どこかで足した・直した・消したら、つながっているほかの端末へ
// { type: 'planner.changed' } を送る。受け取ったアプリは一覧を読み直して、
// 通知の予約を合わせ直す。つながっていない端末は、次に開いたときに読み直す。
//
// 失敗しても元の操作は成功のまま（知らせは「おまけ」）。
// ==============================================================================

/**
 * @param {{ sub, exceptConnectionId, sessionStore, postback, logger? }} options
 * @returns {Promise<number>} 知らせた端末の数
 */
async function broadcastPlannerChanged({ sub, exceptConnectionId, sessionStore, postback, logger = console }) {
  let sent = 0;
  try {
    const ids = await sessionStore.listConnections(sub);
    for (const connectionId of ids) {
      if (!connectionId || connectionId === exceptConnectionId) continue;
      try {
        const result = await postback.postJson(connectionId, { type: 'planner.changed' });
        if (result?.gone) {
          await sessionStore.removeConnection(sub, connectionId).catch(() => {});
        } else {
          sent += 1;
        }
      } catch (error) {
        logger.warn(`[PlannerSync] post failed: ${error.message}`);
      }
    }
  } catch (error) {
    logger.warn(`[PlannerSync] broadcast failed (non-fatal): ${error.message}`);
  }
  return sent;
}

module.exports = { broadcastPlannerChanged };
