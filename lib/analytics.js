// analytics.js — round trips and statistics over the cached history, memoised per sync.

import * as store from '../history-store.js';
import * as ta from '../trade-analytics.js';
import { DATA_DIR, INCOME_FILE, META_FILE, syncState } from './history-sync.js';

let analyticsCache = null;   // { key, built }

function buildAnalytics(meta) {
  const income = store.readNdjson(INCOME_FILE);
  const symbols = store.storeStats(DATA_DIR).symbols;

  let trips = [], stillOpen = [], nonQuoteFees = 0;
  const sizeSteps = new Map();
  const orphans = { fills: 0, realized: 0, commission: 0 };
  const fillLedger = [];
  const preHistoryUntil = {};

  for (const symbol of symbols) {
    const fills = store.readNdjson(store.tradesFile(DATA_DIR, symbol));
    const r = ta.buildRoundTrips(fills);
    trips = trips.concat(r.trips);
    stillOpen = stillOpen.concat(r.stillOpen);
    for (const [key, steps] of r.sizeSteps) sizeSteps.set(key, steps);
    nonQuoteFees += r.nonQuoteFees;
    orphans.fills += r.orphans.fills;
    orphans.realized += r.orphans.realized;
    orphans.commission += r.orphans.commission;
    Object.assign(preHistoryUntil, r.preHistoryUntil);
    for (const f of fills) fillLedger.push([f.time, parseFloat(f.realizedPnl) || 0, ta.quoteCommission(f)]);
  }
  const openLegCheck = meta.openLegsAtSync
    ? { at: meta.walletAtSync?.at ?? null, mismatches: ta.openLegMismatches(stillOpen, meta.openLegsAtSync) } : null;
  return { income, symbols, trips, stillOpen, sizeSteps, nonQuoteFees, orphans, preHistoryUntil, fillLedger, openLegCheck };
}

export function analytics() {
  const meta = store.readJson(META_FILE, {});
  const key = `${meta.lastIncomeTime || 0}:${Object.keys(meta.trades || {}).length}:${syncState.finishedAt || 0}`;
  if (analyticsCache?.key === key) return analyticsCache.built;
  const built = buildAnalytics(meta);
  analyticsCache = { key, built };
  return built;
}
