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

/**
 * One key per income row. Binance books both legs of a hedged funding settlement under one
 * tranId at one time, so the amount is part of it; without it the second leg's row is dropped.
 */
export const incomeKey = r => `${r.tranId}:${r.incomeType}:${r.symbol || ''}:${r.time}:${r.income}`;
export const INCOME_KEY_VERSION = 2;

async function syncIncome(meta) {
  // Resume a little before the cursor: a record can land with a timestamp just behind the
  // last one seen, and the dedupe makes the overlap free.
  const refetchWindow = !meta.lastIncomeTime || meta.incomeKeyVersion !== INCOME_KEY_VERSION;
  const from = refetchWindow ? Date.now() - INCOME_WINDOW_MS : meta.lastIncomeTime - 60_000;
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
  if (refetchWindow) {
    meta.incomeCompleteFrom = from;
    meta.incomeKeyVersion = INCOME_KEY_VERSION;
  }
  return added;
}

function markPulled(meta, symbol, at, added) {
  meta.tradesSyncedAt = { ...meta.tradesSyncedAt, [symbol]: at };
  return added;
}

async function syncTradesFor(symbol, meta) {
  meta.trades = meta.trades || {};
  const file = store.tradesFile(DATA_DIR, symbol);
  let fromId = (meta.trades[symbol] || 0) + 1;
  let added = 0;

  const startedAt = Date.now();
  for (let page = 0; page < 40; page++) {
    await throttleWeight();
    const batch = await binanceFetch('/fapi/v1/userTrades', { symbol, limit: 1000, fromId });
    if (!Array.isArray(batch) || !batch.length) return markPulled(meta, symbol, startedAt, added);

    added += store.appendNdjson(file, batch, t => t.id).added;
    const last = batch[batch.length - 1].id;
    meta.trades[symbol] = Math.max(meta.trades[symbol] || 0, last);
    if (batch.length < 1000) return markPulled(meta, symbol, startedAt, added);
    fromId = last + 1;
  }
  return added;
}

const TRADE_INCOME = new Set(['REALIZED_PNL', 'COMMISSION']);

/** Every symbol in the ledger, and those it shows trading after their fills were last pulled. */
export function symbolsToSync(meta) {
  const latest = new Map();
  for (const r of store.readNdjson(INCOME_FILE)) {
    if (!r.symbol) continue;
    latest.set(r.symbol, Math.max(latest.get(r.symbol) ?? 0, TRADE_INCOME.has(r.incomeType) ? r.time : 0));
  }
  const pulled = meta.tradesSyncedAt || {};
  const stale = [...latest].filter(([symbol, last]) => last > (pulled[symbol] ?? -1));
  return { all: [...latest.keys()].sort(), due: stale.map(([symbol]) => symbol).sort() };
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
    const bn = await getBinanceData();
    if (!bn.disabled) meta.walletAtSync = { wallet: bn.walletBalance, at: Date.now() };
    store.writeJson(META_FILE, meta);

    const open = bn.openPositions.map(p => p.symbol);
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
