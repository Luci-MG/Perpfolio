// entry-context.js — the account and the market at the moment a position was opened or added
// to, captured from the order stream while the server runs and kept in
// data/entry-context.ndjson, one entry row and one later stop row per order.

import path from 'path';
import * as store from '../history-store.js';
import { legStop, stopVsSuggested } from '../stop-check.js';
import * as tc from '../trip-context.js';
import * as vol from '../vol-estimator.js';
import { binanceSnapshotAgeMs, getBinanceData } from './binance-account.js';
import { DATA_DIR } from './config.js';
import { readConfluence } from './confluence-reading.js';
import { getBinanceKlines } from './market-data.js';
import { suggestStop } from './stop-suggestion.js';
import { sleep } from './util.js';
import { isEnabled } from './venues.js';

const ENTRY_FILE = path.join(DATA_DIR, 'entry-context.ndjson');
const STOP_LOOK_MS = 5 * 60_000;
const SNAPSHOT_MAX_AGE_MS = 60_000;
const STOPS_TAB_DEFAULTS = { riskPct: 0.01, k: 1.5 };
const capturedOrders = new Set();

const legOf = o => ({
  orderId: o.i, symbol: o.s, positionSide: o.ps,
  side: o.ps === 'SHORT' || (o.ps === 'BOTH' && o.S === 'SELL') ? 'Short' : 'Long',
  price: parseFloat(o.L), qty: parseFloat(o.l), time: o.T
});

async function accountAt(leg) {
  const bn = await getBinanceData({ maxAgeMs: SNAPSHOT_MAX_AGE_MS });
  return { equity: bn.equity, marginPct: parseFloat(bn.marginPct), freeMargin: bn.freeMargin,
           leverage: bn.leverageByLeg[`${leg.symbol}:${leg.positionSide}`] ?? null,
           snapshotAgeMs: binanceSnapshotAgeMs() };
}

async function confluenceAt(leg) {
  const reading = await readConfluence(leg.symbol);
  return { ...reading.overall,
           byTf: Object.fromEntries(Object.entries(reading.timeframes).map(([tf, r]) => [tf, r?.score ?? null])) };
}

async function suggestedStopAt(leg) {
  const [bn, candles, btcCandles] = await Promise.all([
    getBinanceData({ maxAgeMs: SNAPSHOT_MAX_AGE_MS }), getBinanceKlines(leg.symbol), getBinanceKlines('BTCUSDT')
  ]);
  const held = bn.openPositions.find(p => p.symbol === leg.symbol && p.positionSide === leg.positionSide);
  const position = { pair: leg.symbol, exchange: 'binance', side: leg.side, entry: leg.price, mark: leg.price,
                     fundingRate: held?.fundingRate ?? null, _equity: bn.equity };
  const { result } = suggestStop(position, {
    candles, candlesBackfilled: !candles?.length, btcCandles,
    btcAtrHistory: btcCandles ? vol.buildAtrSeries(btcCandles) : [], totalEquity: bn.equity, ...STOPS_TAB_DEFAULTS
  });
  return { price: result.stopPrice, distancePct: result.stopDistPct, regime: result.regimeLabel,
           ...STOPS_TAB_DEFAULTS, backfilled: result.backfilled };
}

async function yourStopAt(leg) {
  const bn = await getBinanceData({ maxAgeMs: 0 });
  return legStop(bn.openOrders, { ...leg, qty: null }, leg.price);
}

function alreadyCaptured(orderId) {
  if (!capturedOrders.size) {
    for (const r of store.readNdjson(ENTRY_FILE)) capturedOrders.add(r.orderId);
  }
  return capturedOrders.has(orderId);
}

/**
 * Records the context of an increasing fill once per order: account, confluence and suggested
 * stop at once, then your stop `stopDelayMs` later. A part that fails is left null and named in
 * `errors`; nothing is captured while Binance is switched off.
 */
export async function captureEntryContext(o, { stopDelayMs = STOP_LOOK_MS } = {}) {
  if (!tc.isIncreasingFill(o) || !isEnabled('binance') || alreadyCaptured(o.i)) return;
  capturedOrders.add(o.i);
  const leg = legOf(o);
  const errors = [];
  const part = (name, read) => read(leg).catch(err => { errors.push(`${name}: ${err.message}`); return null; });

  const [account, confluence, suggestedStop] = await Promise.all([
    part('account', accountAt), part('confluence', confluenceAt), part('suggested stop', suggestedStopAt)
  ]);
  store.appendNdjson(ENTRY_FILE, [{ stage: 'entry', ...leg, capturedAt: Date.now(), account, confluence,
                                    suggestedStop, errors }], r => `${r.orderId}:${r.stage}`);

  await sleep(stopDelayMs);
  const yourStop = await part('your stop', yourStopAt);
  store.appendNdjson(ENTRY_FILE, [{ stage: 'stop', orderId: leg.orderId, lookedAt: Date.now(), yourStop,
                                    stopVsSuggested: stopVsSuggested(yourStop, suggestedStop) }],
                     r => `${r.orderId}:${r.stage}`);
}

/** Captured context by orderId, the entry and stop rows merged. */
export function entryContextByOrder() {
  const out = new Map();
  for (const { stage, ...row } of store.readNdjson(ENTRY_FILE)) {
    out.set(row.orderId, { ...out.get(row.orderId), ...row, [`${stage}Captured`]: true });
  }
  return out;
}
