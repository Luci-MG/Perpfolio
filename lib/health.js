// health.js — one verdict on whether the numbers on screen can be trusted right now: the
// Binance request budget and ban state, the order stream, the account snapshots and the
// last history sync. Pure, so the thresholds are unit-tested.

const RANK = { ok: 0, warn: 1, bad: 2 };

const ORDERS_STALE_MS = 3 * 60_000;

export function assessHealth({ rate, feed, snapshots, sync, streamExpected = true, now = Date.now() }) {
  const reasons = [];
  const flag = (level, text) => reasons.push({ level, text });

  if (rate.pausedUntil) flag('bad', `Binance paused after ${rate.pauseReason} — ${Math.ceil((rate.pausedUntil - now) / 1000)}s left`);
  if (rate.usedWeight1m >= rate.weightCeiling) flag('bad', `request weight ${rate.usedWeight1m} of ${rate.weightLimit}`);
  else if (rate.usedWeight1m >= rate.weightLimit / 2) flag('warn', `request weight ${rate.usedWeight1m} of ${rate.weightLimit}`);

  if (streamExpected) {
    const r = feed.lastReconcile;
    if (!r?.at) flag('warn', 'open orders not read yet');
    else if (now - r.at > ORDERS_STALE_MS) flag('warn', `open orders not refreshed for ${Math.round((now - r.at) / 60_000)}m`);
    else if (!feed.connected) flag('warn', 'order stream not connected — orders refresh every 60s by REST');
    else if (feed.lastMessageAgeSec != null && feed.lastMessageAgeSec > 600) flag('warn', `order stream quiet for ${Math.round(feed.lastMessageAgeSec / 60)}m`);
    if (r?.at && (r.added || r.removed)) flag('warn', `last reconcile found drift (${r.added} missing, ${r.removed} stale)`);
  }

  for (const [venue, ageMs] of Object.entries(snapshots)) {
    if (ageMs != null && ageMs > 120_000) flag('warn', `${venue} account read is ${Math.round(ageMs / 1000)}s old`);
  }
  if (sync?.phase === 'failed') flag('warn', `last history sync failed: ${sync.error}`);

  const level = reasons.reduce((worst, r) => (RANK[r.level] > RANK[worst] ? r.level : worst), 'ok');
  return { level, reasons };
}
