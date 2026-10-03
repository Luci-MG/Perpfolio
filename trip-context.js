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
 * books one row per leg, so a hedged settlement's rows are matched to its legs by the rate,
 * size and mark at that time. The ledger is complete from `completeFrom`: after it, a leg with
 * no row of its own paid nothing; before it, a hedged settlement missing a row leaves its trips
 * `fundingIncomplete`, funding null. With no rate to match by, rows are shared evenly and the
 * trips marked `fundingSplit`.
 */
export function attributeFunding({ trips, stillOpen = [], sizeSteps, income, rates = [], incomeFrom, completeFrom = Infinity }) {
  const legsBySymbol = new Map();
  for (const leg of [...trips, ...stillOpen]) {
    if (!legsBySymbol.has(leg.symbol)) legsBySymbol.set(leg.symbol, []);
    legsBySymbol.get(leg.symbol).push(leg);
  }
  const rateAt = new Map(rates.map(r => [`${r.symbol}:${r.fundingTime}`, r]));
  const out = new Map(trips.map(t => [tripKey(t), { funding: 0, fundingSplit: false, fundingIncomplete: false }]));
  const credit = (leg, amount, flags = {}) => {
    const entry = out.get(tripKey(leg));
    if (!entry) return;
    entry.funding += amount;
    entry.fundingSplit ||= !!flags.split;
    entry.fundingIncomplete ||= !!flags.incomplete;
  };

  for (const rows of settlementsOf(income)) {
    const { symbol, time } = rows[0];
    const legs = (legsBySymbol.get(symbol) || []).filter(l => openDuring(l, time));
    if (!legs.length) continue;
    const amounts = rows.map(r => parseFloat(r.income) || 0);
    if (legs.length === 1) {
      const modelled = amounts.length > 1 ? modelledShares(legs, rateAt, symbol, time, sizeSteps) : amounts;
      if (modelled) credit(legs[0], nearestAmount(amounts, modelled[0]));
      else credit(legs[0], 0, { incomplete: true });
      continue;
    }
    if (amounts.length < legs.length && time < completeFrom) { legs.forEach(l => credit(l, 0, { incomplete: true })); continue; }
    const modelled = modelledShares(legs, rateAt, symbol, time, sizeSteps);
    if (modelled && amounts.length < legs.length) {
      nearestLegs(legs, modelled, amounts).forEach(([leg, amount]) => credit(leg, amount));
      continue;
    }
    if (!modelled || amounts.length > legs.length) {
      const total = amounts.reduce((a, b) => a + b, 0);
      legs.forEach(l => credit(l, total / legs.length, { split: true }));
      continue;
    }
    pairInSortedOrder(legs, modelled, amounts).forEach(([leg, amount]) => credit(leg, amount));
  }

  for (const t of trips) {
    const entry = out.get(tripKey(t));
    const unknown = incomeFrom == null || t.openTime < incomeFrom || entry.fundingIncomplete;
    entry.funding = unknown ? null : +entry.funding.toFixed(8);
  }
  return out;
}

/**
 * Funding rows from `from` on for which no rebuilt position leg was open, and their total. A row
 * on a symbol before `preHistoryUntil[symbol]`, the last fill that closed a position opened
 * before history, belongs to that position and is not counted.
 */
export function unmatchedFunding({ trips, stillOpen = [], income, from = 0, preHistoryUntil = {} }) {
  const legsBySymbol = new Map();
  for (const leg of [...trips, ...stillOpen]) legsBySymbol.set(leg.symbol, [...(legsBySymbol.get(leg.symbol) || []), leg]);
  const rows = income.filter(r => r.incomeType === 'FUNDING_FEE' && r.symbol && r.time >= from
    && !(r.time <= (preHistoryUntil[r.symbol] ?? -Infinity))
    && !(legsBySymbol.get(r.symbol) || []).some(l => openDuring(l, r.time)));
  return { rows: rows.length, amount: +rows.reduce((s, r) => s + parseFloat(r.income), 0).toFixed(2) };
}

function settlementsOf(income) {
  const groups = new Map();
  for (const row of income) {
    if (row.incomeType !== 'FUNDING_FEE' || !row.symbol) continue;
    const key = `${row.symbol}:${row.time}`;
    groups.set(key, [...(groups.get(key) || []), row]);
  }
  return groups.values();
}

function modelledShares(legs, rateAt, symbol, time, sizeSteps) {
  const nearest = rateAt.get(`${symbol}:${time}`)
    || [...rateAt.values()].find(r => r.symbol === symbol && Math.abs(r.fundingTime - time) < 60_000);
  if (!nearest) return null;
  const rate = parseFloat(nearest.fundingRate) || 0;
  const mark = parseFloat(nearest.markPrice) || 0;
  return legs.map(l => {
    const size = sizeAt(sizeSteps?.get(tripKey(l)), time) || Math.abs(l.size || 0);
    return (l.side === 'Long' ? -1 : 1) * rate * size * (mark || l.avgEntry || 0);
  });
}

function nearestAmount(amounts, modelled) {
  return amounts.reduce((a, b) => (Math.abs(b - modelled) < Math.abs(a - modelled) ? b : a));
}

function nearestLegs(legs, modelled, amounts) {
  const free = legs.map((leg, i) => ({ leg, m: modelled[i] }));
  return amounts.map(amount => {
    const best = free.reduce((a, b) => (Math.abs(b.m - amount) < Math.abs(a.m - amount) ? b : a));
    free.splice(free.indexOf(best), 1);
    return [best.leg, amount];
  });
}

function pairInSortedOrder(legs, modelled, amounts) {
  const legOrder = legs.map((leg, i) => ({ leg, m: modelled[i] })).sort((a, b) => a.m - b.m);
  const rowOrder = [...amounts].sort((a, b) => a - b);
  return legOrder.map(({ leg }, i) => [leg, rowOrder[i]]);
}

/** True for a user-data `ORDER_TRADE_UPDATE` order that filled and grows its leg; one-way mode counts every non-reduce-only fill. */
export function isIncreasingFill(o) {
  if (o?.x !== 'TRADE' || o.R) return false;
  if (o.ps === 'LONG') return o.S === 'BUY';
  if (o.ps === 'SHORT') return o.S === 'SELL';
  return true;
}
