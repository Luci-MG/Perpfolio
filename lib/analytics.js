// analytics.js — round trips and statistics over the cached history, memoised per sync.

import * as store from '../history-store.js';
import * as ta from '../trade-analytics.js';
import { DATA_DIR, INCOME_FILE, META_FILE, syncState } from './history-sync.js';

// ── Performance analytics ─────────────────────────────────────────────────────
// Reads only the local cache; a sync is what refreshes it. Round trips are rebuilt from
// fills, so the whole 82-file corpus is parsed once and held until the next sync.

let analyticsCache = null;   // { key, built }

function buildAnalytics() {
  const income = store.readNdjson(INCOME_FILE);
  const symbols = store.storeStats(DATA_DIR).symbols;

  let trips = [], stillOpen = [], nonQuoteFees = 0;
  const orphans = { fills: 0, realized: 0, commission: 0 };
  const fillTimes = [];
  let maker = 0, taker = 0, makerFee = 0, takerFee = 0;

  for (const symbol of symbols) {
    const fills = store.readNdjson(store.tradesFile(DATA_DIR, symbol));
    const r = ta.buildRoundTrips(fills);
    trips = trips.concat(r.trips);
    stillOpen = stillOpen.concat(r.stillOpen);
    nonQuoteFees += r.nonQuoteFees;
    orphans.fills += r.orphans.fills;
    orphans.realized += r.orphans.realized;
    orphans.commission += r.orphans.commission;

    // aggregated here rather than holding 20k fill objects for the life of the cache
    for (const f of fills) {
      const fee = Math.abs(parseFloat(f.commission) || 0);
      if (f.maker) { maker++; makerFee += fee; } else { taker++; takerFee += fee; }
      fillTimes.push(f.time);
    }
  }

  const total = maker + taker;
  const execution = {
    maker, taker, fills: total,
    makerPct: total ? +(maker / total * 100).toFixed(1) : null,
    makerFee: +makerFee.toFixed(2), takerFee: +takerFee.toFixed(2),
    totalFee: +(makerFee + takerFee).toFixed(2),
    firstFill: fillTimes.length ? fillTimes.reduce((a, b) => Math.min(a, b)) : null,
    lastFill: fillTimes.length ? fillTimes.reduce((a, b) => Math.max(a, b)) : null
  };
  return { income, symbols, trips, stillOpen, nonQuoteFees, orphans, execution };
}

export function analytics() {
  const meta = store.readJson(META_FILE, {});
  const key = `${meta.lastIncomeTime || 0}:${Object.keys(meta.trades || {}).length}:${syncState.finishedAt || 0}`;
  if (analyticsCache?.key === key) return analyticsCache.built;
  const built = buildAnalytics();
  analyticsCache = { key, built };
  return built;
}
