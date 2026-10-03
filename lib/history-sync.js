// history-sync.js — tops up the local income and fill cache from Binance.

import path from 'path';
import * as store from '../history-store.js';
import { getBinanceData } from './binance-account.js';
import { binanceFetch, throttleWeight } from './binance-client.js';
import { DATA_DIR } from './config.js';

// ── Account history sync ──────────────────────────────────────────────────────
// Binance keeps income for three months and serves fills only through `fromId` paging, so
// the history is cached locally and topped up. Both datasets dedupe on their own ids, which
// means an overlapping refetch is harmless and the cursors are an optimisation rather than
// a correctness requirement.

export { DATA_DIR };
export const INCOME_FILE = path.join(DATA_DIR, 'income.ndjson');
export const META_FILE   = path.join(DATA_DIR, 'meta.json');
const INCOME_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export let syncState = { running: false, startedAt: null, finishedAt: null, phase: 'idle',
                  symbolsDone: 0, symbolsTotal: 0, incomeAdded: 0, tradesAdded: 0, error: null };

const incomeKey = r => `${r.tranId}:${r.incomeType}:${r.symbol || ''}:${r.time}`;

async function syncIncome(meta) {
  // Resume a little before the cursor: a record can land with a timestamp just behind the
  // last one seen, and the dedupe makes the overlap free.
  const from = meta.lastIncomeTime ? meta.lastIncomeTime - 60_000 : Date.now() - INCOME_WINDOW_MS;
  let added = 0, newest = meta.lastIncomeTime || 0;

  for (let page = 1; page <= 60; page++) {
    await throttleWeight();
    const batch = await binanceFetch('/fapi/v1/income', { startTime: from, limit: 1000, page });
    if (!Array.isArray(batch) || !batch.length) break;

    added += store.appendNdjson(INCOME_FILE, batch, incomeKey).added;
    for (const r of batch) newest = Math.max(newest, r.time);
    if (batch.length < 1000) break;
  }

  meta.lastIncomeTime = newest || meta.lastIncomeTime;
  return added;
}

async function syncTradesFor(symbol, meta) {
  meta.trades = meta.trades || {};
  const file = store.tradesFile(DATA_DIR, symbol);
  let fromId = (meta.trades[symbol] || 0) + 1;
  let added = 0;

  for (let page = 0; page < 40; page++) {
    await throttleWeight();
    const batch = await binanceFetch('/fapi/v1/userTrades', { symbol, limit: 1000, fromId });
    if (!Array.isArray(batch) || !batch.length) break;

    added += store.appendNdjson(file, batch, t => t.id).added;
    const last = batch[batch.length - 1].id;
    meta.trades[symbol] = Math.max(meta.trades[symbol] || 0, last);
    if (batch.length < 1000) break;
    fromId = last + 1;
  }
  return added;
}

// A symbol needs syncing when it has never been pulled, or when it has traded recently.
// Walking all 81 every time costs 44s of round-trips to add nothing; this keeps a routine
// refresh to a handful of calls while a first build still covers everything.
function symbolsToSync(meta, recentMs = 7 * 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - recentMs;
  const everSeen = new Set();
  const recent = new Set();

  for (const r of store.readNdjson(INCOME_FILE)) {
    if (!r.symbol) continue;
    everSeen.add(r.symbol);
    if (r.time >= cutoff) recent.add(r.symbol);
  }

  const cursors = meta.trades || {};
  const never = [...everSeen].filter(s => cursors[s] == null);
  return { all: [...everSeen].sort(), due: [...new Set([...never, ...recent])].sort() };
}

/** Syncs income, then fills, then runs `afterTrades`, all under one progress state. */
export async function runHistorySync(req_full = false, { afterTrades } = {}) {
  if (syncState.running) return syncState;
  syncState = { running: true, startedAt: Date.now(), finishedAt: null, phase: 'income',
                symbolsDone: 0, symbolsTotal: 0, symbolsKnown: 0, full: req_full,
                incomeAdded: 0, tradesAdded: 0, error: null };

  try {
    const meta = store.readJson(META_FILE, {});
    syncState.incomeAdded = await syncIncome(meta);
    store.writeJson(META_FILE, meta);

    const open = (await getBinanceData()).openPositions.map(p => p.symbol);
    const { all, due } = symbolsToSync(meta);
    const symbols = [...new Set([...(req_full ? all : due), ...open])];
    syncState.phase = 'trades';
    syncState.symbolsTotal = symbols.length;
    syncState.symbolsKnown = all.length;

    for (const symbol of symbols) {
      syncState.tradesAdded += await syncTradesFor(symbol, meta);
      syncState.symbolsDone++;
      if (syncState.symbolsDone % 10 === 0) store.writeJson(META_FILE, meta);
    }
    store.writeJson(META_FILE, meta);
    if (afterTrades) await afterTrades();
    syncState.phase = 'done';
  } catch (err) {
    console.error('[sync]', err);
    syncState.error = err.message;
    syncState.phase = 'failed';
  } finally {
    syncState.running = false;
    syncState.finishedAt = Date.now();
  }
  return syncState;
}
