import { binanceSnapshotAgeMs } from '../lib/binance-account.js';
import { getRateState } from '../lib/binance-client.js';
import { BINANCE_API_KEY } from '../lib/config.js';
import { assessHealth } from '../lib/health.js';
import { syncState } from '../lib/history-sync.js';
import { hyperliquidSnapshotAgeMs } from '../lib/hyperliquid.js';
import { getOrderFeedHealth } from '../lib/orders-stream.js';

// ── Health ────────────────────────────────────────────────────────────────────
// Everything here is already held in memory, so the route makes no exchange call and is
// cheap enough to ride along with every dashboard poll.
export function register(app) {
  app.get('/api/health', (req, res) => {
    const rate = getRateState();
    const feed = getOrderFeedHealth();
    const snapshots = { binance: binanceSnapshotAgeMs(), hyperliquid: hyperliquidSnapshotAgeMs() };
    const sync = { phase: syncState.phase, error: syncState.error, finishedAt: syncState.finishedAt };
    const { level, reasons } = assessHealth({ rate, feed, snapshots, sync, hasKey: !!BINANCE_API_KEY });
    res.json({ ok: true, level, reasons, rate, feed, snapshotAgeMs: snapshots, sync });
  });
}
