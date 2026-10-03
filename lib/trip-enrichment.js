// trip-enrichment.js — the journal's per-trip context: price path, market at entry and
// funding. Candles are fetched during a history sync, never on a request, and only the
// computed values are kept, versioned, in data/trip-context.ndjson.

import path from 'path';
import * as store from '../history-store.js';
import { tripKey } from '../trade-analytics.js';
import * as tc from '../trip-context.js';
import { analytics } from './analytics.js';
import { annotationsFor } from './annotations-store.js';
import { bnPublic, throttleWeight } from './binance-client.js';
import { DATA_DIR } from './config.js';
import { entryContextByOrder } from './entry-context.js';
import { syncState } from './history-sync.js';

const CONTEXT_FILE = path.join(DATA_DIR, 'trip-context.ndjson');
const RATES_FILE = path.join(DATA_DIR, 'funding-rates.ndjson');
const HOUR = 3_600_000;
const BTC_LOOKBACK_BARS = 210;

const toCandle = k => ({ t: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4] });

async function publicRows(endpoint, params) {
  await throttleWeight();
  return bnPublic(`${endpoint}?${new URLSearchParams(params)}`);
}

async function klines(symbol, interval, params) {
  const rows = await publicRows('/fapi/v1/klines', { symbol, interval, limit: 1500, ...params });
  return rows.map(toCandle);
}

async function btcHourly(from, to) {
  const out = [];
  for (let start = from; start < to;) {
    const page = await klines('BTCUSDT', '1h', { startTime: start, endTime: to });
    out.push(...page);
    if (page.length < 1500) break;
    start = page.at(-1).t + HOUR;
  }
  return out;
}

async function contextFor(trip, btc) {
  const { interval, ms } = tc.pathInterval(trip.openTime, trip.closeTime);
  const pathBars = await klines(trip.symbol, interval,
    { startTime: Math.floor(trip.openTime / ms) * ms, endTime: trip.closeTime });
  const before = await klines(trip.symbol, '1h', { endTime: trip.openTime - 1, limit: 20 });
  return { key: tripKey(trip), v: tc.CONTEXT_VERSION, interval, ...tc.excursion(trip, pathBars),
           atrPct: tc.atrPctAtEntry(before), btcTrend: tc.btcTrendAt(btc, trip.openTime) };
}

const delisted = err => /→ 400/.test(err.message);

async function syncRates(needed) {
  const have = new Set(store.readNdjson(RATES_FILE).map(r => `${r.symbol}:${r.fundingTime}`));
  for (const [symbol, times] of needed) {
    const missing = times.filter(t => !have.has(`${symbol}:${t}`));
    if (!missing.length) continue;
    const rows = await publicRows('/fapi/v1/fundingRate',
      { symbol, startTime: Math.min(...missing) - HOUR, endTime: Math.max(...missing) + HOUR, limit: 1000 });
    store.appendNdjson(RATES_FILE, rows, r => `${r.symbol}:${r.fundingTime}`);
  }
}

/** Fills in context for every closed trip not yet cached at this formula version; resumable. */
export async function syncTripContext() {
  const { trips, stillOpen, income } = analytics();
  const cached = new Set(store.readNdjson(CONTEXT_FILE).filter(r => r.v === tc.CONTEXT_VERSION).map(r => r.key));
  const pending = trips.filter(t => !cached.has(tripKey(t)));
  Object.assign(syncState, { phase: 'context', contextDone: 0, contextTotal: pending.length });

  await syncRates(tc.hedgedSettlements({ trips, stillOpen, income }));
  if (!pending.length) return;

  const first = Math.min(...pending.map(t => t.openTime));
  const btc = await btcHourly(first - BTC_LOOKBACK_BARS * HOUR, Math.max(...pending.map(t => t.openTime)));
  for (const trip of pending) {
    const row = await contextFor(trip, btc).catch(err => {
      if (!delisted(err)) throw err;
      return { key: tripKey(trip), v: tc.CONTEXT_VERSION, unavailable: true };
    });
    store.appendNdjson(CONTEXT_FILE, [row], r => r.key + ':' + r.v);
    syncState.contextDone++;
  }
}

function entryOf(captured) {
  if (!captured) return null;
  const { account, confluence, suggestedStop, yourStop = null, stopVsSuggested = null, capturedAt, errors } = captured;
  return { account, confluence, suggestedStop, yourStop, stopVsSuggested, capturedAt, errors,
           stopLooked: captured.stopCaptured === true };
}

/** Every closed trip with its funding, session, hedge state, cached context and your note and tags, plus coverage. */
export function enrichedTrips() {
  const { trips, stillOpen, sizeSteps, income } = analytics();
  const context = new Map(store.readNdjson(CONTEXT_FILE)
    .filter(r => r.v === tc.CONTEXT_VERSION).map(r => [r.key, r]));
  const incomeFrom = income.length ? income.reduce((m, r) => Math.min(m, r.time), Infinity) : null;
  const funding = tc.attributeFunding({ trips, stillOpen, sizeSteps, income,
                                        rates: store.readNdjson(RATES_FILE), incomeFrom });
  const legs = [...trips, ...stillOpen];
  const entries = entryContextByOrder();

  const rows = trips.map(t => {
    const key = tripKey(t);
    const c = context.get(key);
    const f = funding.get(key);
    return {
      ...t, key,
      session: tc.sessionOf(t.openTime),
      hedged: tc.hedgedAtEntry(t, legs),
      funding: f.funding,
      fundingSplit: f.fundingSplit,
      netAfterFunding: f.funding == null ? null : +(t.net + f.funding).toFixed(8),
      mae: c?.mae ?? null,
      mfe: c?.mfe ?? null,
      atrPct: c?.atrPct ?? null,
      btcTrend: c?.btcTrend ?? null,
      pathInterval: c?.interval ?? null,
      context: c ? (c.unavailable ? 'unavailable' : 'ready') : 'pending',
      entry: entryOf(entries.get(t.openOrderId))
    };
  });
  const notes = annotationsFor(rows);
  for (const r of rows) {
    const a = notes.matched.get(r.key);
    r.note = a?.note || null;
    r.tags = a?.tags ?? [];
  }
  const count = state => rows.filter(r => r.context === state).length;
  const capturedSince = entries.size ? Math.min(...[...entries.values()].map(e => e.time ?? Infinity)) : null;
  return { trips: rows, coverage: { incomeFrom, ready: count('ready'), pending: count('pending'),
                                    unavailable: count('unavailable'), entryCapturedSince: capturedSince,
                                    orphanNotes: notes.orphans } };
}
