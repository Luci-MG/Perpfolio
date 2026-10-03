// equity-snapshots.js — account value across both venues, recorded every 15 minutes while the
// server runs, so the journal can chart equity including open positions. Kept in
// data/equity-snapshots.ndjson, one row per interval.

import path from 'path';
import * as store from '../history-store.js';
import { getBinanceData } from './binance-account.js';
import { DATA_DIR } from './config.js';
import { getHyperliquidData } from './hyperliquid.js';
import { isEnabled } from './venues.js';

const SNAPSHOT_FILE = path.join(DATA_DIR, 'equity-snapshots.ndjson');
const SNAPSHOT_INTERVAL_MS = 15 * 60_000;
const READ_MAX_AGE_MS = 60_000;

/** Records one snapshot for the interval containing `now`; a second call in the same interval writes nothing. */
export async function recordEquitySnapshot(now = Date.now(), intervalMs = SNAPSHOT_INTERVAL_MS) {
  if (!isEnabled('binance') && !isEnabled('hyperliquid')) return;
  const [bn, hl] = await Promise.all([getBinanceData({ maxAgeMs: READ_MAX_AGE_MS }),
                                      getHyperliquidData({ maxAgeMs: READ_MAX_AGE_MS })]);
  const row = {
    t: Math.floor(now / intervalMs) * intervalMs,
    binance: bn.disabled ? null : { wallet: bn.walletBalance, equity: bn.equity },
    hyperliquid: hl.disabled ? null : { equity: hl.equity },
    accountValue: +(bn.equity + hl.equity).toFixed(2)
  };
  store.appendNdjson(SNAPSHOT_FILE, [row], r => r.t);
}

export function readEquitySnapshots() {
  return store.readNdjson(SNAPSHOT_FILE);
}

export function startEquitySnapshots(intervalMs = SNAPSHOT_INTERVAL_MS) {
  const record = () => recordEquitySnapshot(Date.now(), intervalMs)
    .catch(err => console.warn('[equity] snapshot failed:', err.message));
  record();
  setInterval(record, intervalMs);
}
