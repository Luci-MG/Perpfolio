// costs.js — what trading cost: fees and funding over the trips in scope, in dollars and in
// basis points of notional traded, maker share by notional, the effective fee rate against the
// account's own, and the wallet ledger with the checks that say whether it reconciles. Method
// and sources: docs/research/timing-symbols-costs.md. Pure.

import { localDate, localWeekStart } from './local-time.js';

const TOP_SYMBOLS = 10;
const TREND_WEEKS = 8;
const FEE_DRAG_MIN_MULTIPLE = 2;
const WEEK_MS = 7 * 86_400_000;
const SNAPSHOT_MATCH_MS = 30 * 60_000;
const USD_ASSETS = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD']);
const LEDGER_TYPES = ['TRANSFER', 'REALIZED_PNL', 'COMMISSION', 'FUNDING_FEE'];

const round2 = v => (v == null ? null : +v.toFixed(2));
const round4 = v => (v == null ? null : +v.toFixed(4));
const sumOf = xs => xs.reduce((s, x) => s + x, 0);
const bp = (part, whole) => (whole ? round2(part / whole * 1e4) : null);

function bnbInDollars(trips, bnbPrice) {
  const paid = trips.filter(t => t.bnbFee > 0);
  const priced = paid.map(t => t.bnbFee * (bnbPrice(t.closeTime) ?? NaN));
  return { fee: round4(sumOf(paid.map(t => t.bnbFee))), usd: priced.some(Number.isNaN) ? null : round2(sumOf(priced)) };
}

/**
 * Fees (dollar stablecoins, plus BNB at `bnbPrice(ts)`), funding paid and received, notional
 * traded, cost in basis points, maker share by notional and realised gross over `trips`. Fee
 * drag (costs ÷ gross) only when gross is at least twice the costs; near zero it means nothing.
 */
export function costSummary(trips, { bnbPrice = () => null } = {}) {
  const traded = sumOf(trips.map(t => t.tradedNotional || 0));
  const fees = sumOf(trips.map(t => t.commission));
  const bnb = bnbInDollars(trips, bnbPrice);
  const funded = trips.filter(t => t.funding != null);
  const paid = sumOf(funded.map(t => Math.min(0, t.funding))), received = sumOf(funded.map(t => Math.max(0, t.funding)));
  const gross = sumOf(trips.map(t => t.realized));
  const costs = fees + (bnb.usd ?? 0) + Math.max(0, -(paid + received));
  return {
    trips: trips.length, traded: round2(traded), fees: round2(fees), bnb,
    fundingPaid: round2(paid), fundingReceived: round2(received), fundingUnknown: trips.length - funded.length,
    feesBp: bp(fees + (bnb.usd ?? 0), traded), fundingBp: bp(paid + received, traded),
    makerShare: traded ? round4(sumOf(trips.map(t => t.makerNotional || 0)) / traded) : null,
    gross: round2(gross), costs: round2(costs),
    feeDragPct: gross >= FEE_DRAG_MIN_MULTIPLE * costs && gross > 0 ? round2(costs / gross * 100) : null
  };
}

/**
 * The fee rate paid against the one the account's maker and taker rates imply, in basis
 * points, over the trips whose symbol has a rate in `rates` (symbol → { maker, taker, assumed }).
 */
export function feeCheck(trips, rates) {
  const priced = trips.filter(t => rates[t.symbol] && t.tradedNotional > 0);
  const traded = sumOf(priced.map(t => t.tradedNotional));
  const expected = sumOf(priced.map(t => {
    const r = rates[t.symbol], maker = t.makerNotional || 0;
    return maker * r.maker + (t.tradedNotional - maker) * r.taker;
  }));
  const all = sumOf(trips.map(t => t.tradedNotional || 0));
  return { effectiveBp: bp(sumOf(priced.map(t => t.commission)), traded), expectedBp: bp(expected, traded),
           pricedShare: all ? round4(traded / all) : null, assumed: priced.some(t => rates[t.symbol].assumed),
           rates: Object.fromEntries(Object.entries(rates).map(([s, r]) => [s, { makerBp: round2(r.maker * 1e4), takerBp: round2(r.taker * 1e4) }])) };
}

/** Fees, funding paid and funding received per local week (Monday) the trips closed in. */
export function weeklyCosts(trips, tz = 0) {
  const weeks = new Map();
  for (const t of trips) {
    const start = localWeekStart(t.closeTime, tz);
    const w = weeks.get(start) || { week: localDate(start, tz), fees: 0, paid: 0, received: 0 };
    w.fees += t.commission;
    w.paid += Math.min(0, t.funding ?? 0);
    w.received += Math.max(0, t.funding ?? 0);
    weeks.set(start, w);
  }
  return [...weeks].sort((a, b) => a[0] - b[0])
    .map(([, w]) => ({ week: w.week, fees: round2(w.fees), paid: round2(w.paid), received: round2(w.received) }));
}

/** Maker share by notional for each of the last 8 weeks to `now`, oldest first; null for a week without trades. */
export function makerTrend(trips, now) {
  return Array.from({ length: TREND_WEEKS }, (_, i) => {
    const to = now - (TREND_WEEKS - 1 - i) * WEEK_MS, from = to - WEEK_MS;
    const week = trips.filter(t => t.closeTime >= from && t.closeTime < to);
    const traded = sumOf(week.map(t => t.tradedNotional || 0));
    return traded ? { share: round4(sumOf(week.map(t => t.makerNotional || 0)) / traded), trips: week.length } : null;
  });
}

function topWithOthers(entries) {
  const sorted = entries.filter(e => e.value).sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  const others = sorted.slice(TOP_SYMBOLS);
  return { top: sorted.slice(0, TOP_SYMBOLS).map(e => ({ ...e, value: round2(e.value) })),
           others: { symbols: others.length, value: round2(sumOf(others.map(e => e.value))) } };
}

/** Per symbol, the 10 largest fees, funding paid and funding received, each with the rest as one total. */
export function symbolCosts(trips) {
  const by = new Map();
  for (const t of trips) {
    const s = by.get(t.symbol) || { symbol: t.symbol, trips: 0, fees: 0, paid: 0, received: 0 };
    s.trips++;
    s.fees += t.commission;
    s.paid += Math.min(0, t.funding ?? 0);
    s.received += Math.max(0, t.funding ?? 0);
    by.set(t.symbol, s);
  }
  const rows = [...by.values()];
  const pick = key => topWithOthers(rows.map(r => ({ symbol: r.symbol, trips: r.trips, value: r[key] })));
  return { fees: pick('fees'), paid: pick('paid'), received: pick('received') };
}

function snapshotCheck({ snapshots, from, end, after }) {
  const snap = snapshots.filter(s => s.binance?.wallet != null && s.t >= from && s.t <= from + SNAPSHOT_MATCH_MS).sort((a, b) => a.t - b.t)[0];
  if (!snap) return { id: 'start', checked: false };
  const derived = end - sumOf(after.filter(r => r.time > snap.t).map(r => parseFloat(r.income)));
  return { id: 'start', checked: true, diff: round2(snap.binance.wallet - derived), at: snap.t };
}

/**
 * The wallet from `from` to the last sync, line by line from the ledger (dollar assets only):
 * start, transfers, realised, fees, funding, every other income type, the wallet the sync saw,
 * and what moved since. `checks` compare the start with an equity snapshot when one is that
 * old, ledger realised and fees with the fills, and count funding rows no position explains.
 */
export function walletLedger({ income = [], from = 0, walletAtSync = null, walletLive = null, fills = [], unmatched = null, snapshots = [] }) {
  if (!walletAtSync) return null;
  const end = walletAtSync.wallet, at = walletAtSync.at;
  const rows = income.filter(r => USD_ASSETS.has((r.asset || 'USDT').toUpperCase()) && r.time >= from && r.time <= at);
  const total = type => round2(sumOf(rows.filter(r => r.incomeType === type).map(r => parseFloat(r.income))));
  const otherTypes = [...new Set(rows.map(r => r.incomeType).filter(t => !LEDGER_TYPES.includes(t)))].sort();
  const since = from || rows.reduce((m, r) => Math.min(m, r.time), at);
  const inRange = fills.filter(([time]) => time >= since && time <= at);
  return {
    from: since, at,
    start: round2(end - sumOf(rows.map(r => parseFloat(r.income)))),
    transfers: total('TRANSFER'), realised: total('REALIZED_PNL'), fees: total('COMMISSION'), funding: total('FUNDING_FEE'),
    other: otherTypes.map(type => ({ type, amount: total(type) })),
    wallet: round2(end), sinceSync: walletLive == null ? null : round2(walletLive - end),
    checks: [
      snapshotCheck({ snapshots, from: since, end, after: rows }),
      { id: 'realised', checked: true, diff: round2(total('REALIZED_PNL') - sumOf(inRange.map(f => f[1]))) },
      { id: 'fees', checked: true, diff: round2(total('COMMISSION') + sumOf(inRange.map(f => f[2]))) },
      { id: 'funding', checked: unmatched != null, rows: unmatched?.rows ?? null, diff: unmatched?.amount ?? null }
    ]
  };
}
