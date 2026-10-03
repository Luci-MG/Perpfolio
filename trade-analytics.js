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
    size: 0, avgEntry: 0, openNotional: 0, exitQty: 0, exitValue: 0,
    realized: 0, commission: 0, fills: 0, adds: 0, partialCloses: 0,
    addsWhileUnderwater: 0, peakNotional: 0, maxSize: 0, makerFills: 0, steps: []
  };
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
    addsWhileUnderwater: trip.addsWhileUnderwater,
    peakNotional: +trip.peakNotional.toFixed(2),
    maxSize: +trip.maxSize.toFixed(8)
  };
}

// Commission can be charged in BNB; only quote-denominated fees are comparable with PnL, so
// anything else is counted separately rather than silently added to a dollar figure.
function quoteCommission(fill) {
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
    if (!fee && parseFloat(fill.commission)) nonQuoteFees += Math.abs(parseFloat(fill.commission));

    const adding = isIncrease(fill.side, positionSide, trip.size);

    // A hedge-mode fill that reduces a side with nothing open closes a position opened before
    // the earliest reachable fill. It has no entry to measure against, so it is kept out of
    // the trips and accounted for separately.
    if (!adding && positionSide !== 'BOTH' && trip.fills === 0) {
      orphans.fills++;
      orphans.realized += parseFloat(fill.realizedPnl) || 0;
      orphans.commission += fee;
      open.delete(key);
      continue;
    }

    const delta  = signedDelta(fill.side, positionSide, qty);
    const tol    = closedTolerance(trip, qty);
    const after  = Math.abs(trip.size + delta) <= tol ? 0 : trip.size + delta;

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
      }
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
    trip.fills++;
    if (fill.maker) trip.makerFills++;
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
    trips, stillOpen, sizeSteps, nonQuoteFees: +nonQuoteFees.toFixed(8),
    orphans: { fills: orphans.fills, realized: +orphans.realized.toFixed(8), commission: +orphans.commission.toFixed(8) }
  };
}

// ─── STATISTICS ──────────────────────────────────────────────────────────────

const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

export function summarise(trips) {
  const n = trips.length;
  if (!n) return { trips: 0, wins: 0, losses: 0, winRate: null, net: 0, grossWin: 0,
                   grossLoss: 0, avgWin: null, avgLoss: null, payoff: null, expectancy: null,
                   profitFactor: null, fees: 0, medianHoldHours: null };

  const wins = trips.filter(t => t.win);
  const losses = trips.filter(t => !t.win);
  const grossWin = sum(wins, t => t.net);
  const grossLoss = Math.abs(sum(losses, t => t.net));
  const avgWin = wins.length ? grossWin / wins.length : null;
  const avgLoss = losses.length ? grossLoss / losses.length : null;
  const holds = trips.map(t => t.holdHours).sort((a, b) => a - b);

  return {
    trips: n,
    wins: wins.length,
    losses: losses.length,
    winRate: +(wins.length / n * 100).toFixed(2),
    net: +sum(trips, t => t.net).toFixed(2),
    grossWin: +grossWin.toFixed(2),
    grossLoss: +grossLoss.toFixed(2),
    avgWin: avgWin == null ? null : +avgWin.toFixed(2),
    avgLoss: avgLoss == null ? null : +(-avgLoss).toFixed(2),
    payoff: (avgWin != null && avgLoss) ? +(avgWin / avgLoss).toFixed(3) : null,
    expectancy: +(sum(trips, t => t.net) / n).toFixed(2),
    profitFactor: grossLoss ? +(grossWin / grossLoss).toFixed(3) : null,
    fees: +sum(trips, t => t.commission).toFixed(2),
    medianHoldHours: +holds[Math.floor(n / 2)].toFixed(3)
  };
}

export function bySymbol(trips) {
  const groups = {};
  for (const t of trips) (groups[t.symbol] = groups[t.symbol] || []).push(t);
  return Object.entries(groups)
    .map(([symbol, list]) => ({ symbol, ...summarise(list) }))
    .sort((a, b) => a.net - b.net);
}

// The split that matters: trips where size was increased at a price worse than the running
// average entry, against trips where it never was.
export function behaviourSplit(trips) {
  const added = trips.filter(t => t.addsWhileUnderwater > 0);
  const clean = trips.filter(t => t.addsWhileUnderwater === 0);
  return {
    addedWhileUnderwater: { ...summarise(added), label: 'added while underwater' },
    clean:                { ...summarise(clean), label: 'never added while underwater' }
  };
}

// ─── BREAKDOWNS ──────────────────────────────────────────────────────────────
//
// Every bucket carries its trip count and a `thin` flag. A slice with three trades in it
// can show a five-figure number and mean nothing; the count is what says whether the
// number is a pattern or an accident, so it travels with the number everywhere.

const THIN = 10;

function bucketStats(trips, label, extra = {}) {
  return { label, ...summarise(trips), thin: trips.length < THIN, ...extra };
}

const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function byDayOfWeek(trips, stamp = 'closeTime') {
  return DOW.map((label, day) =>
    bucketStats((trips || []).filter(t => new Date(t[stamp]).getUTCDay() === day), label, { day }));
}

export function byHourOfDay(trips, stamp = 'openTime') {
  return Array.from({ length: 24 }, (_, hour) =>
    bucketStats((trips || []).filter(t => new Date(t[stamp]).getUTCHours() === hour),
                `${String(hour).padStart(2, '0')}:00`, { hour }));
}

const HOLD_BUCKETS = [
  [0, 0.25, 'under 15m'], [0.25, 1, '15m – 1h'], [1, 4, '1 – 4h'],
  [4, 24, '4 – 24h'], [24, 168, '1 – 7d'], [168, Infinity, 'over 7d']
];

export function byHoldTime(trips) {
  return HOLD_BUCKETS.map(([lo, hi, label]) =>
    bucketStats((trips || []).filter(t => t.holdHours >= lo && t.holdHours < hi), label,
                { fromHours: lo, toHours: hi === Infinity ? null : hi }));
}

export function bySide(trips) {
  return ['LONG', 'SHORT', 'BOTH']
    .map(side => bucketStats((trips || []).filter(t => t.positionSide === side), side, { side }))
    .filter(b => b.trips > 0);
}

export function byMonth(trips) {
  const groups = {};
  for (const t of trips || []) {
    const m = new Date(t.closeTime).toISOString().slice(0, 7);
    (groups[m] = groups[m] || []).push(t);
  }
  return Object.entries(groups).sort().map(([month, list]) => bucketStats(list, month, { month }));
}

export function streaks(trips) {
  const ordered = [...(trips || [])].sort((a, b) => a.closeTime - b.closeTime);
  let run = 0, bestWin = 0, worstLoss = 0;
  let winPnl = 0, lossPnl = 0, bestWinPnl = 0, worstLossPnl = 0;

  for (const t of ordered) {
    if (t.win) {
      run = run > 0 ? run + 1 : 1;
      winPnl = run === 1 ? t.net : winPnl + t.net;
      if (run > bestWin) { bestWin = run; bestWinPnl = winPnl; }
    } else {
      run = run < 0 ? run - 1 : -1;
      lossPnl = run === -1 ? t.net : lossPnl + t.net;
      if (run < worstLoss) { worstLoss = run; worstLossPnl = lossPnl; }
    }
  }
  return {
    longestWin: bestWin, longestWinPnl: +bestWinPnl.toFixed(2),
    longestLoss: Math.abs(worstLoss), longestLossPnl: +worstLossPnl.toFixed(2),
    current: run, currentIsWin: run > 0
  };
}

// Whether the previous result changes the next trade. Size is the tell: revenge trading
// shows up as a bigger position after a loss, not as a worse one.
export function sequenceEffect(trips) {
  const ordered = [...(trips || [])].sort((a, b) => a.closeTime - b.closeTime);
  const afterWin = [], afterLoss = [];
  for (let i = 1; i < ordered.length; i++) (ordered[i - 1].win ? afterWin : afterLoss).push(ordered[i]);

  const avgSize = a => a.length ? +(a.reduce((s, t) => s + t.peakNotional, 0) / a.length).toFixed(2) : null;
  return {
    afterWin:  { ...bucketStats(afterWin, 'after a win'),   avgSize: avgSize(afterWin) },
    afterLoss: { ...bucketStats(afterLoss, 'after a loss'), avgSize: avgSize(afterLoss) }
  };
}

export function sizeDistribution(trips) {
  const sizes = (trips || []).map(t => t.peakNotional).sort((a, b) => a - b);
  if (!sizes.length) return null;
  const q = p => sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * p))];
  return { p10: +q(0.1).toFixed(2), median: +q(0.5).toFixed(2), p90: +q(0.9).toFixed(2),
           max: +sizes[sizes.length - 1].toFixed(2), count: sizes.length };
}

export function makerTaker(fills) {
  let maker = 0, taker = 0, makerFee = 0, takerFee = 0;
  for (const f of fills || []) {
    const fee = Math.abs(parseFloat(f.commission) || 0);
    if (f.maker) { maker++; makerFee += fee; } else { taker++; takerFee += fee; }
  }
  const total = maker + taker;
  return {
    maker, taker, fills: total,
    makerPct: total ? +(maker / total * 100).toFixed(1) : null,
    makerFee: +makerFee.toFixed(2), takerFee: +takerFee.toFixed(2),
    totalFee: +(makerFee + takerFee).toFixed(2)
  };
}

export function records(trips, equity) {
  const ordered = [...(trips || [])].sort((a, b) => b.net - a.net);
  const pick = t => t && { symbol: t.symbol, positionSide: t.positionSide, net: t.net,
                           closeTime: t.closeTime, fills: t.fills, holdHours: +t.holdHours.toFixed(2),
                           addsWhileUnderwater: t.addsWhileUnderwater };
  const longest = [...(trips || [])].sort((a, b) => b.holdHours - a.holdHours)[0];
  const busiest = [...(trips || [])].sort((a, b) => b.fills - a.fills)[0];
  return {
    bestTrip: pick(ordered[0]),
    worstTrip: pick(ordered[ordered.length - 1]),
    longestHeld: pick(longest),
    mostFills: pick(busiest),
    bestDay: equity?.bestDay || null,
    worstDay: equity?.worstDay || null
  };
}

// Daily PnL keyed by date, for a calendar view. Weeks start Monday.
export function calendar(income, types = ['REALIZED_PNL', 'COMMISSION', 'FUNDING_FEE']) {
  const wanted = new Set(types);
  const byDay = new Map();
  for (const r of income || []) {
    if (!wanted.has(r.incomeType)) continue;
    const d = new Date(r.time).toISOString().slice(0, 10);
    byDay.set(d, (byDay.get(d) || 0) + parseFloat(r.income));
  }
  const days = [...byDay.entries()].sort().map(([date, pnl]) => ({ date, pnl: +pnl.toFixed(2) }));
  if (!days.length) return { days: [], weeks: [], maxAbs: 0 };

  const maxAbs = Math.max(...days.map(d => Math.abs(d.pnl)));
  const first = new Date(days[0].date + 'T00:00:00Z');
  const startMonday = new Date(first);
  startMonday.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));

  const map = new Map(days.map(d => [d.date, d.pnl]));
  const last = new Date(days[days.length - 1].date + 'T00:00:00Z');
  const weeks = [];
  for (let cur = new Date(startMonday); cur <= last; ) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      const key = cur.toISOString().slice(0, 10);
      week.push({ date: key, pnl: map.has(key) ? map.get(key) : null });
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    weeks.push(week);
  }
  return { days, weeks, maxAbs: +maxAbs.toFixed(2) };
}

// ─── INCOME-BASED SERIES ─────────────────────────────────────────────────────

const dayOf = t => new Date(t).toISOString().slice(0, 10);

export function equityCurve(income, types = ['REALIZED_PNL', 'COMMISSION', 'FUNDING_FEE']) {
  const wanted = new Set(types);
  const byDay = new Map();
  for (const r of income || []) {
    if (!wanted.has(r.incomeType)) continue;
    const d = dayOf(r.time);
    byDay.set(d, (byDay.get(d) || 0) + parseFloat(r.income));
  }

  let cum = 0, peak = 0, maxDrawdown = 0;
  const points = [...byDay.entries()].sort().map(([date, pnl]) => {
    cum += pnl;
    peak = Math.max(peak, cum);
    maxDrawdown = Math.min(maxDrawdown, cum - peak);
    return { date, pnl: +pnl.toFixed(2), cumulative: +cum.toFixed(2),
             drawdown: +(cum - peak).toFixed(2) };
  });

  const green = points.filter(p => p.pnl > 0).length;
  return {
    points,
    days: points.length,
    greenDays: green,
    redDays: points.filter(p => p.pnl < 0).length,
    net: +cum.toFixed(2),
    maxDrawdown: +maxDrawdown.toFixed(2),
    bestDay: points.reduce((b, p) => !b || p.pnl > b.pnl ? p : b, null),
    worstDay: points.reduce((w, p) => !w || p.pnl < w.pnl ? p : w, null)
  };
}

export function incomeTotals(income) {
  const totals = {};
  for (const r of income || []) {
    totals[r.incomeType] = (totals[r.incomeType] || 0) + parseFloat(r.income);
  }
  for (const k of Object.keys(totals)) totals[k] = +totals[k].toFixed(2);
  const gross = totals.REALIZED_PNL || 0;
  const fees = Math.abs(totals.COMMISSION || 0);
  return { totals, feeDragPct: gross ? +(fees / Math.abs(gross) * 100).toFixed(1) : null };
}

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
