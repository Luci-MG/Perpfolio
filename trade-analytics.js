// trade-analytics.js — round-trip reconstruction and performance statistics (ESM)
//
// Pure functions over cached records. Two inputs:
//   fills  — /fapi/v1/userTrades rows: { symbol, id, side, positionSide, price, qty,
//            realizedPnl, commission, commissionAsset, time, maker }
//   income — /fapi/v1/income rows:     { symbol, incomeType, income, time }
//
// A "round trip" is one position's whole life: the fills that opened it, added to it,
// trimmed it and finally closed it. The exchange reports PnL per fill, not per position, so
// the lifecycle has to be rebuilt by tracking size per (symbol, positionSide) and cutting a
// trip whenever size returns to zero.

import { netOf, resultOf } from './habits.js';
import { localDate, localMidnight, wallTime } from './local-time.js';
import { median } from './stats.js';

const CLOSED = 1e-12;

// Summing fill quantities leaves float dust (~1e-11) behind, so "closed" is judged relative
// to the position's size. An absolute 1e-12 kept finished trips open and merged each into
// the next one.
const closedTolerance = (trip, qty) => Math.max(CLOSED, Math.max(trip.maxSize, qty) * 1e-9);

function isIncrease(side, positionSide, signedSize) {
  if (positionSide === 'LONG')  return side === 'BUY';
  if (positionSide === 'SHORT') return side === 'SELL';
  // one-way mode: a fill adds when it pushes further from zero in the direction already held
  if (Math.abs(signedSize) <= CLOSED) return true;
  return (signedSize > 0) === (side === 'BUY');
}

function signedDelta(side, positionSide, qty) {
  if (positionSide === 'SHORT') return side === 'SELL' ? -qty : qty;
  return side === 'BUY' ? qty : -qty;
}

function blankTrip(symbol, positionSide, fill) {
  return {
    symbol, positionSide, side: null, openOrderId: null,
    openTime: fill.time, closeTime: null,
    size: 0, avgEntry: 0, openNotional: 0, openQty: 0, enteredQty: 0, entryValue: 0, exitQty: 0, exitValue: 0,
    makerNotional: 0, bnbFee: 0,
    realized: 0, commission: 0, fills: 0, adds: 0, partialCloses: 0,
    addsWhileUnderwater: 0, peakNotional: 0, maxSize: 0, makerFills: 0, steps: []
  };
}

function closesMoreThanHistoryHolds(positionSide, size, after) {
  return positionSide !== 'BOTH' && after !== 0 && Math.sign(after) !== Math.sign(size);
}

function sideOf(positionSide, delta) {
  if (positionSide === 'LONG') return 'Long';
  if (positionSide === 'SHORT') return 'Short';
  return delta > 0 ? 'Long' : 'Short';
}

/** Identifies one round trip across the journal, the context cache and the funding split. */
export function tripKey(trip) {
  return `${trip.symbol}:${trip.positionSide}:${trip.openTime}`;
}

function finishTrip(trip, fill) {
  const net = trip.realized - Math.abs(trip.commission);
  return {
    symbol: trip.symbol, positionSide: trip.positionSide, side: trip.side, openOrderId: trip.openOrderId,
    openTime: trip.openTime, closeTime: fill.time,
    holdHours: (fill.time - trip.openTime) / 3_600_000,
    openNotional: +trip.openNotional.toFixed(2),
    openQty: +trip.openQty.toFixed(8),
    enteredQty: +trip.enteredQty.toFixed(8),
    avgEntry: trip.avgEntry,
    avgExit: trip.exitQty ? trip.exitValue / trip.exitQty : null,
    adds: trip.adds,
    partialCloses: trip.partialCloses,
    realized: +trip.realized.toFixed(8),
    commission: +Math.abs(trip.commission).toFixed(8),
    net: +net.toFixed(8),
    win: net > 0,
    fills: trip.fills,
    makerFills: trip.makerFills,
    tradedNotional: +(trip.entryValue + trip.exitValue).toFixed(2),
    makerNotional: +trip.makerNotional.toFixed(2),
    bnbFee: +trip.bnbFee.toFixed(8),
    addsWhileUnderwater: trip.addsWhileUnderwater,
    peakNotional: +trip.peakNotional.toFixed(2),
    maxSize: +trip.maxSize.toFixed(8)
  };
}

/** A fill's fee when paid in a dollar stablecoin; 0 for BNB and other assets, which are counted apart. */
export function quoteCommission(fill) {
  const asset = (fill.commissionAsset || '').toUpperCase();
  return (asset === 'USDT' || asset === 'USDC' || asset === 'BUSD' || asset === 'FDUSD')
    ? Math.abs(parseFloat(fill.commission) || 0) : 0;
}

export function buildRoundTrips(fills) {
  const sorted = [...(fills || [])].sort((a, b) => a.time - b.time || a.id - b.id);
  const open = new Map();          // `${symbol}:${positionSide}` → trip in progress
  const trips = [];
  let nonQuoteFees = 0;
  const orphans = { fills: 0, realized: 0, commission: 0 };
  const preHistoryUntil = {};
  const sizeSteps = new Map();
  const close = (trip, fill) => {
    const done = finishTrip(trip, fill);
    trips.push(done);
    sizeSteps.set(tripKey(done), trip.steps);
  };

  for (const fill of sorted) {
    const positionSide = fill.positionSide || 'BOTH';
    const key = `${fill.symbol}:${positionSide}`;
    let trip = open.get(key);
    if (!trip) { trip = blankTrip(fill.symbol, positionSide, fill); open.set(key, trip); }

    const qty   = Math.abs(parseFloat(fill.qty) || 0);
    const price = parseFloat(fill.price) || 0;
    const fee   = quoteCommission(fill);
    const bnb = !fee && (fill.commissionAsset || '').toUpperCase() === 'BNB' ? Math.abs(parseFloat(fill.commission) || 0) : 0;
    if (!fee && parseFloat(fill.commission)) nonQuoteFees += Math.abs(parseFloat(fill.commission));

    const adding = isIncrease(fill.side, positionSide, trip.size);
    const delta  = signedDelta(fill.side, positionSide, qty);
    const tol    = closedTolerance(trip, qty);
    const after  = Math.abs(trip.size + delta) <= tol ? 0 : trip.size + delta;

    if (!adding && closesMoreThanHistoryHolds(positionSide, trip.size, after)) {
      orphans.fills += trip.fills + 1;
      orphans.realized += trip.realized + (parseFloat(fill.realizedPnl) || 0);
      orphans.commission += trip.commission + fee;
      preHistoryUntil[fill.symbol] = Math.max(preHistoryUntil[fill.symbol] ?? 0, fill.time);
      open.delete(key);
      continue;
    }

    if (adding) {
      if (Math.abs(trip.size) > CLOSED) {
        const worse = trip.size > 0 ? price < trip.avgEntry : price > trip.avgEntry;
        if (worse) trip.addsWhileUnderwater++;
        trip.adds++;
      } else {
        trip.openTime = fill.time;
        trip.side = sideOf(positionSide, delta);
        trip.openOrderId = fill.orderId ?? null;
        trip.openNotional = qty * price;
        trip.openQty = qty;
      }
      trip.enteredQty += qty;
      trip.entryValue += qty * price;
      const held = Math.abs(trip.size);
      trip.avgEntry = held <= CLOSED ? price : (trip.avgEntry * held + price * qty) / (held + qty);
    }

    if (!adding) {
      const closingQty = Math.min(qty, Math.abs(trip.size));
      trip.exitQty += closingQty;
      trip.exitValue += closingQty * price;
      if (after !== 0 && Math.sign(after) === Math.sign(trip.size)) trip.partialCloses++;
    }

    trip.size = after;
    trip.steps.push([fill.time, Math.abs(after)]);
    trip.realized += parseFloat(fill.realizedPnl) || 0;
    trip.commission += fee;
    trip.bnbFee += bnb;
    trip.fills++;
    if (fill.maker) { trip.makerFills++; trip.makerNotional += qty * price; }
    trip.maxSize = Math.max(trip.maxSize, Math.abs(after));
    trip.peakNotional = Math.max(trip.peakNotional, Math.abs(after) * price);

    // A one-way fill can cross zero, closing one position and opening the opposite one.
    if (after === 0) {
      close(trip, fill);
      open.delete(key);
    } else if (positionSide === 'BOTH' && trip.size !== 0 && Math.sign(after) !== Math.sign(trip.size - delta)
               && Math.abs(trip.size - delta) > CLOSED) {
      close(trip, fill);
      const next = blankTrip(fill.symbol, positionSide, fill);
      next.size = after;
      next.side = sideOf(positionSide, after);
      next.openOrderId = fill.orderId ?? null;
      next.avgEntry = price;
      next.openNotional = Math.abs(after) * price;
      next.openQty = Math.abs(after);
      next.enteredQty = Math.abs(after);
      next.entryValue = Math.abs(after) * price;
      next.fills = 1;
      next.maxSize = Math.abs(after);
      next.peakNotional = Math.abs(after) * price;
      next.steps = [[fill.time, Math.abs(after)]];
      open.set(key, next);
    }
  }

  const stillOpen = [...open.values()]
    .filter(t => t.size !== 0)
    .map(t => {
      sizeSteps.set(tripKey(t), t.steps);
      return { symbol: t.symbol, positionSide: t.positionSide, side: t.side, size: t.size,
               avgEntry: t.avgEntry, realized: t.realized, fills: t.fills,
               addsWhileUnderwater: t.addsWhileUnderwater, openTime: t.openTime };
    });

  return {
    trips, stillOpen, sizeSteps, nonQuoteFees: +nonQuoteFees.toFixed(8), preHistoryUntil,
    orphans: { fills: orphans.fills, realized: +orphans.realized.toFixed(8), commission: +orphans.commission.toFixed(8) }
  };
}

/** Legs whose rebuilt open size differs from the size Binance reported at the last sync, which means fills are missing or misread. */
export function openLegMismatches(stillOpen, liveLegs) {
  const keyOf = l => `${l.symbol}:${l.positionSide}`;
  const rebuilt = new Map(stillOpen.map(l => [keyOf(l), l.size]));
  const live = new Map(liveLegs.map(l => [keyOf(l), l.size]));
  return [...new Set([...rebuilt.keys(), ...live.keys()])].sort()
    .map(key => ({ symbol: key.split(':')[0], positionSide: key.split(':')[1], rebuilt: rebuilt.get(key) ?? 0, live: live.get(key) ?? 0 }))
    .filter(m => Math.abs(m.rebuilt - m.live) > Math.max(1e-9, Math.abs(m.live) * 1e-6));
}

// ─── STATISTICS ──────────────────────────────────────────────────────────────

const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

/** Count, wins, losses, net, averages, payoff, expectancy, fees, funding and median hold, on net after fees and funding. */
export function summarise(trips) {
  const n = trips.length;
  if (!n) return { trips: 0, wins: 0, losses: 0, winRate: null, net: 0, avgWin: null, avgLoss: null,
                   payoff: null, expectancy: null, fees: 0, funding: 0, medianHoldHours: null };
  const wins = trips.filter(t => resultOf(netOf(t)) === 'win');
  const losses = trips.filter(t => resultOf(netOf(t)) === 'loss');
  const grossWin = sum(wins, netOf);
  const grossLoss = Math.abs(sum(losses, netOf));
  const avgWin = wins.length ? grossWin / wins.length : null;
  const avgLoss = losses.length ? grossLoss / losses.length : null;
  return {
    trips: n,
    wins: wins.length,
    losses: losses.length,
    winRate: +(wins.length / n * 100).toFixed(2),
    net: +sum(trips, netOf).toFixed(2),
    avgWin: avgWin == null ? null : +avgWin.toFixed(2),
    avgLoss: avgLoss == null ? null : +(-avgLoss).toFixed(2),
    payoff: (avgWin != null && avgLoss) ? +(avgWin / avgLoss).toFixed(2) : null,
    expectancy: +(sum(trips, netOf) / n).toFixed(2),
    fees: +sum(trips, t => t.commission).toFixed(2),
    funding: +sum(trips, t => t.funding ?? 0).toFixed(2),
    medianHoldHours: +median(trips.map(t => t.holdHours)).toFixed(3)
  };
}

// ─── BREAKDOWNS ──────────────────────────────────────────────────────────────
//
// Every bucket carries its trip count and a `thin` flag. A slice with three trades in it
// can show a five-figure number and mean nothing; the count is what says whether the
// number is a pattern or an accident, so it travels with the number everywhere.

const THIN = 10;

function bucketStats(trips, label) {
  return { label, ...summarise(trips), thin: trips.length < THIN };
}

const HOLD_BUCKETS = [
  [0, 0.25, 'under 15m'], [0.25, 1, '15m – 1h'], [1, 4, '1 – 4h'],
  [4, 24, '4 – 24h'], [24, 168, '1 – 7d'], [168, Infinity, 'over 7d']
];

export function byHoldTime(trips) {
  return HOLD_BUCKETS.map(([lo, hi, label]) =>
    bucketStats((trips || []).filter(t => t.holdHours >= lo && t.holdHours < hi), label));
}

export function bySide(trips) {
  return ['Long', 'Short']
    .map(side => bucketStats((trips || []).filter(t => t.side === side), side))
    .filter(b => b.trips > 0);
}

export function byMonth(trips, tz = 0) {
  const groups = {};
  for (const t of trips || []) {
    const m = localDate(t.closeTime, tz).slice(0, 7);
    (groups[m] = groups[m] || []).push(t);
  }
  return Object.entries(groups).sort().map(([month, list]) => bucketStats(list, month));
}

/** Net per local date from the ledger's realised, fees and funding rows. */
export function dailyIncomeNet(income, tz = 0) {
  const byDay = new Map();
  for (const r of income || []) {
    if (!NET_TYPES.includes(r.incomeType)) continue;
    const d = localDate(r.time, tz);
    byDay.set(d, (byDay.get(d) || 0) + parseFloat(r.income));
  }
  return [...byDay.entries()].sort().map(([date, pnl]) => ({ date, pnl: +pnl.toFixed(2) }));
}

// ─── INCOME-BASED SERIES ─────────────────────────────────────────────────────

// Funding settlements actually observed per day, which is how the declared
// fundingIntervalHours gets checked against reality rather than trusted.
export function inferFundingInterval(income, symbol) {
  const stamps = [...new Set((income || [])
    .filter(r => r.incomeType === 'FUNDING_FEE' && r.symbol === symbol)
    .map(r => r.time))].sort((a, b) => a - b);
  if (stamps.length < 3) return { symbol, settlements: stamps.length, inferredHours: null };

  const gaps = [];
  for (let i = 1; i < stamps.length; i++) {
    const h = (stamps[i] - stamps[i - 1]) / 3_600_000;
    if (h > 0.5) gaps.push(h);
  }
  if (!gaps.length) return { symbol, settlements: stamps.length, inferredHours: null };

  const median = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  return {
    symbol,
    settlements: stamps.length,
    inferredHours: median <= 2 ? 1 : median <= 6 ? 4 : 8,
    medianGapHours: +median.toFixed(2)
  };
}

// ─── OVERVIEW: PERIODS AND CURVES ───────────────────────────────────────────

const DAY_MS = 86_400_000;
const NET_TYPES = ['REALIZED_PNL', 'COMMISSION', 'FUNDING_FEE'];
const USD_ASSETS = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD']);

/** Start of today, this week (Monday) and this month on the reader's clock `tz` (local-time.js). */
export function periodStarts(now, tz = 0) {
  const w = wallTime(now, tz);
  const [y, m, d] = [w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()];
  return { today: localMidnight(y, m, d, tz), week: localMidnight(y, m, d - (w.getUTCDay() + 6) % 7, tz), month: localMidnight(y, m, 1, tz) };
}

/**
 * The same periods one step back — yesterday, last week, last month — each cut at the same
 * elapsed time as the current one, so a Tuesday is compared with last week's Monday and Tuesday.
 * A previous month shorter than the elapsed time ends at its own end.
 */
export function previousPeriodStarts(now, tz = 0) {
  const current = periodStarts(now, tz);
  const w = wallTime(now, tz);
  const [y, m, d] = [w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()];
  const back = (from, start) => ({ from, to: Math.min(from + (now - start), start) });
  return { today: back(localMidnight(y, m, d - 1, tz), current.today),
           week: back(localMidnight(y, m, d - (w.getUTCDay() + 6) % 7 - 7, tz), current.week),
           month: back(localMidnight(y, m - 1, 1, tz), current.month) };
}

const sumIncome = (rows, type) => rows.filter(r => r.incomeType === type).reduce((s, r) => s + parseFloat(r.income), 0);

/** Net, trips closed and wins between `from` and `to`. */
export function periodNetBetween(income, trips, from, to) {
  const rows = (income || []).filter(r => r.time >= from && r.time < to);
  const closed = (trips || []).filter(t => t.closeTime >= from && t.closeTime < to);
  const net = NET_TYPES.reduce((s, type) => s + sumIncome(rows, type), 0);
  return { from, to, net: +net.toFixed(2), trips: closed.length, wins: closed.filter(t => t.win).length };
}

/** Realised, fees, funding, net, transfers and closed trips since each start in `starts`. */
export function periodNet(income, trips, starts) {
  return Object.fromEntries(Object.entries(starts).map(([period, from]) => {
    const rows = (income || []).filter(r => r.time >= from);
    const closed = (trips || []).filter(t => t.closeTime >= from);
    const [realized, fees, funding] = NET_TYPES.map(type => sumIncome(rows, type));
    return [period, { from, realized: +realized.toFixed(2), fees: +fees.toFixed(2), funding: +funding.toFixed(2),
                      net: +(realized + fees + funding).toFixed(2), transfers: +sumIncome(rows, 'TRANSFER').toFixed(2),
                      trips: closed.length, wins: closed.filter(t => t.win).length }];
  }));
}

/**
 * Wallet at the close of each day, rebuilt backwards from `walletNow` through every
 * dollar-denominated income row — exact as far back as the ledger reaches.
 */
export function walletCurve(income, walletNow, now = Date.now()) {
  const rows = (income || []).filter(r => USD_ASSETS.has((r.asset || 'USDT').toUpperCase()))
    .sort((a, b) => b.time - a.time);
  const points = [{ t: now, wallet: +walletNow.toFixed(2) }];
  let wallet = walletNow;
  let day = Math.floor(now / DAY_MS);
  for (const r of rows) {
    const rowDay = Math.floor(r.time / DAY_MS);
    if (rowDay < day) {
      points.push({ t: (rowDay + 1) * DAY_MS - 1, wallet: +wallet.toFixed(2) });
      day = rowDay;
    }
    wallet -= parseFloat(r.income);
  }
  if (rows.length) points.push({ t: rows.at(-1).time - 1, wallet: +wallet.toFixed(2) });
  return points.reverse();
}

/**
 * Account value change since each start, from equity snapshots, with transfers removed so a
 * deposit is not a gain. When snapshots begin after a start, the change runs from the first
 * snapshot and `since` says so.
 */
export function accountChange(snapshots, income, starts) {
  const sorted = [...(snapshots || [])].sort((a, b) => a.t - b.t);
  const last = sorted.at(-1);
  return Object.fromEntries(Object.entries(starts).map(([period, from]) => {
    const first = sorted.find(s => s.t >= from);
    if (!first || !last || first === last) return [period, null];
    const transfers = sumIncome((income || []).filter(r => r.time >= first.t), 'TRANSFER');
    return [period, { change: +(last.accountValue - first.accountValue - transfers).toFixed(2),
                      since: first.t, partial: first.t - from > DAY_MS / 24 }];
  }));
}
