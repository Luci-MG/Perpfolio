// trip-context.js — what surrounded each round trip: the session it opened in, whether the
// opposite leg was open, its funding, the price path while it was held and the market at
// entry. Pure functions over trips, income rows and candles ({ t, open, high, low, close }).

import { ema } from './confluence.js';
import { computeATR } from './vol-estimator.js';
import { tripKey } from './trade-analytics.js';

/** Bump when a cached field's formula changes; rows from another version are recomputed. */
export const CONTEXT_VERSION = 1;

const HOUR = 3_600_000;
const MAX_BARS = 1500;
const PATH_INTERVALS = [['1m', 60_000], ['5m', 5 * 60_000], ['15m', 15 * 60_000], ['1h', HOUR], ['4h', 4 * HOUR]];

export { sessionOf } from './sessions.js';

/** The finest kline interval, and its length, that covers the trip in one request of at most 1,500 bars. */
export function pathInterval(openTime, closeTime) {
  const span = Math.max(1, closeTime - openTime);
  const [interval, ms] = PATH_INTERVALS.find(([, step]) => span / step + 1 <= MAX_BARS) || ['1d', 24 * HOUR];
  return { interval, ms };
}

/** Symbols whose funding rows fall while both hedge legs were open, with those settlement times. */
export function hedgedSettlements({ trips, stillOpen = [], income }) {
  const legs = [...trips, ...stillOpen];
  const out = new Map();
  for (const row of income) {
    if (row.incomeType !== 'FUNDING_FEE' || !row.symbol) continue;
    const open = legs.filter(l => l.symbol === row.symbol && openDuring(l, row.time));
    if (open.length < 2) continue;
    if (!out.has(row.symbol)) out.set(row.symbol, []);
    out.get(row.symbol).push(row.time);
  }
  return out;
}

const openDuring = (leg, t) => leg.openTime <= t && (leg.closeTime == null || leg.closeTime > t);
const opposite = (a, b) => a.positionSide !== 'BOTH' && b.positionSide !== 'BOTH' && a.positionSide !== b.positionSide;

/** True when the same symbol's opposite hedge-mode leg was open at the trip's first fill. */
export function hedgedAtEntry(trip, legs) {
  return legs.some(l => l.symbol === trip.symbol && opposite(l, trip) && tripKey(l) !== tripKey(trip)
    && l.openTime < trip.openTime && openDuring(l, trip.openTime));
}

/** Worst and best move against average entry while held, in percent: MAE ≤ 0 ≤ MFE. */
export function excursion(trip, candles) {
  if (!candles?.length || !(trip.avgEntry > 0)) return null;
  const low = Math.min(...candles.map(c => c.low));
  const high = Math.max(...candles.map(c => c.high));
  const pct = px => (px - trip.avgEntry) / trip.avgEntry * 100;
  const long = trip.side === 'Long';
  return {
    mae: +Math.min(0, long ? pct(low) : -pct(high)).toFixed(2),
    mfe: +Math.max(0, long ? pct(high) : -pct(low)).toFixed(2)
  };
}

/** ATR(14) of the 1h bars before entry, as a percent of price. */
export function atrPctAtEntry(candlesBefore) {
  const atr = computeATR(candlesBefore);
  return atr == null ? null : +(atr * 100).toFixed(2);
}

/** BTC's 1h EMA50 against EMA200 at entry: up, down, or flat within 0.5%. */
export function btcTrendAt(btcCandles, time) {
  const closes = btcCandles.filter(c => c.t + HOUR <= time).map(c => c.close);
  if (closes.length < 200) return null;
  const fast = ema(closes, 50).at(-1);
  const slow = ema(closes, 200).at(-1);
  const gap = (fast - slow) / slow;
  if (Math.abs(gap) < 0.005) return 'flat';
  return gap > 0 ? 'up' : 'down';
}

function sizeAt(steps, t) {
  let size = 0;
  for (const [time, s] of steps || []) {
    if (time > t) break;
    size = s;
  }
  return size;
}

/**
 * Funding per trip from the income ledger; null for trips opened before `incomeFrom`. Binance
 * books a hedged pair's settlement as one net row, so a row with two legs open is split by
 * size × rate × mark, residual shared equally; the parts sum to the row (`fundingSplit`).
 */
export function attributeFunding({ trips, stillOpen = [], sizeSteps, income, rates = [], incomeFrom }) {
  const legsBySymbol = new Map();
  for (const leg of [...trips, ...stillOpen]) {
    if (!legsBySymbol.has(leg.symbol)) legsBySymbol.set(leg.symbol, []);
    legsBySymbol.get(leg.symbol).push(leg);
  }
  const rateAt = new Map(rates.map(r => [`${r.symbol}:${r.fundingTime}`, r]));
  const out = new Map(trips.map(t => [tripKey(t), { funding: 0, fundingSplit: false }]));

  for (const row of income) {
    if (row.incomeType !== 'FUNDING_FEE' || !row.symbol) continue;
    const legs = (legsBySymbol.get(row.symbol) || []).filter(l => openDuring(l, row.time));
    if (!legs.length) continue;
    const amount = parseFloat(row.income) || 0;
    const shares = legs.length === 1 ? [amount] : splitSettlement(legs, amount, rateAt, row, sizeSteps);
    legs.forEach((leg, i) => {
      const entry = out.get(tripKey(leg));
      if (!entry) return;
      entry.funding += shares[i];
      entry.fundingSplit ||= legs.length > 1;
    });
  }

  for (const t of trips) {
    const entry = out.get(tripKey(t));
    entry.funding = incomeFrom == null || t.openTime < incomeFrom ? null : +entry.funding.toFixed(8);
  }
  return out;
}

function splitSettlement(legs, amount, rateAt, row, sizeSteps) {
  const nearest = rateAt.get(`${row.symbol}:${row.time}`)
    || [...rateAt.values()].find(r => r.symbol === row.symbol && Math.abs(r.fundingTime - row.time) < 60_000);
  if (!nearest) return legs.map(() => amount / legs.length);
  const rate = parseFloat(nearest.fundingRate) || 0;
  const mark = parseFloat(nearest.markPrice) || 0;
  const modelled = legs.map(l => {
    const size = sizeAt(sizeSteps?.get(tripKey(l)), row.time) || Math.abs(l.size || 0);
    const price = mark || l.avgEntry || 0;
    return (l.side === 'Long' ? -1 : 1) * rate * size * price;
  });
  const residual = (amount - modelled.reduce((a, b) => a + b, 0)) / legs.length;
  return modelled.map(m => m + residual);
}

/** True for a user-data `ORDER_TRADE_UPDATE` order that filled and grows its leg; one-way mode counts every non-reduce-only fill. */
export function isIncreasingFill(o) {
  if (o?.x !== 'TRADE' || o.R) return false;
  if (o.ps === 'LONG') return o.S === 'BUY';
  if (o.ps === 'SHORT') return o.S === 'SELL';
  return true;
}
