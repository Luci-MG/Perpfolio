// performance.js — how the account did: a daily value series (the wallet rebuilt from the
// ledger before equity snapshots began, account value after), the time-weighted return with
// transfers taken out, drawdown in percent, Sharpe and Sortino with their uncertainty, beta to
// BTC, and per-unit trade statistics where a hedged pair counts once. Every figure carries its
// sample size; under the minimum it says how much more is needed. Method and sources:
// docs/research/performance-behaviour.md. Pure.

import { hedgeUnits, netOf, resultOf } from './habits.js';
import { localDate, localDayStart, nextLocalDay } from './local-time.js';
import { dayBootstrap, groupByDay, mean, median, normalCdf, seededRandom, wilson } from './stats.js';

export const MIN_DAILY_RETURNS = 60;
export const MIN_UNITS_PROFIT_FACTOR = 30;
const MIN_DAYS_ZERO_EDGE = 10;
const ANNUAL_DAYS = 365;
const SHUFFLES = 2000;
const UNUSUAL_P = 0.05;
const DAY_MS = 86_400_000;
const USD_ASSETS = new Set(['USDT', 'USDC', 'BUSD', 'FDUSD']);
const ZERO_DRIFT_DRAWDOWN = Math.sqrt(Math.PI / 2);

const round2 = v => (v == null ? null : +v.toFixed(2));
const round4 = v => (v == null ? null : +v.toFixed(4));
const sumOf = xs => xs.reduce((s, x) => s + x, 0);

function walletCloses(income, walletNow, days) {
  const rows = income.filter(r => USD_ASSETS.has((r.asset || 'USDT').toUpperCase())).sort((a, b) => b.time - a.time);
  const out = new Map();
  let wallet = walletNow, i = 0;
  for (const { start, end } of [...days].reverse()) {
    while (i < rows.length && rows[i].time >= end) wallet -= parseFloat(rows[i++].income);
    out.set(start, wallet);
  }
  return out;
}

function snapshotCloses(snapshots, tz) {
  const out = new Map();
  for (const s of [...snapshots].sort((a, b) => a.t - b.t)) out.set(localDayStart(s.t, tz), s.accountValue);
  return out;
}

function flowsOf(income, { start, end }) {
  return income.filter(r => r.incomeType === 'TRANSFER' && r.time >= start && r.time < end)
    .map(r => ({ amount: parseFloat(r.income), weight: (end - r.time) / (end - start) }));
}

/**
 * One row per local day from `from`: the closing value, its source (`wallet` before the first
 * equity snapshot, `account` from then on), transfers, the day's result net of them and its
 * Modified Dietz return. A day whose value or the previous one is missing, or that crosses
 * from wallet to account, has a null return rather than a zero.
 */
export function dailySeries({ income = [], walletNow = null, snapshots = [], now = Date.now(), tz = 0, from = 0 } = {}) {
  const firstSnapshot = snapshots.length ? Math.min(...snapshots.map(s => s.t)) : null;
  const firstIncome = walletNow != null && income.length ? Math.min(...income.map(r => r.time)) : null;
  const starts = [firstIncome, firstSnapshot].filter(v => v != null);
  if (!starts.length) return [];
  const days = [];
  for (let d = localDayStart(Math.min(...starts), tz); d <= localDayStart(now, tz); d = nextLocalDay(d, tz)) days.push({ start: d, end: nextLocalDay(d, tz) });
  const wallet = walletNow != null ? walletCloses(income, walletNow, days) : new Map();
  const account = snapshotCloses(snapshots, tz);
  const accountFrom = firstSnapshot == null ? Infinity : localDayStart(firstSnapshot, tz);

  let prev = null;
  const rows = days.map(span => {
    const day = span.start;
    const source = day >= accountFrom ? 'account' : 'wallet';
    const value = source === 'account' ? account.get(day) ?? null : wallet.get(day) ?? null;
    const flows = flowsOf(income, span);
    const flow = sumOf(flows.map(f => f.amount));
    const comparable = prev && prev.value != null && value != null && prev.source === source;
    const base = comparable ? prev.value + sumOf(flows.map(f => f.amount * f.weight)) : null;
    const pnl = comparable ? value - prev.value - flow : null;
    const row = { day, date: localDate(day, tz), source, value: round2(value), flow: round2(flow),
                  pnl: round2(pnl), ret: base > 0 ? +(pnl / base).toFixed(6) : null };
    prev = row;
    return row;
  });
  return rows.filter(r => r.day >= localDayStart(from, tz));
}

/** Chain-linked return over the series' daily returns, in percent, with how many days it rests on. */
export function timeWeightedReturn(series) {
  const returns = series.filter(r => r.ret != null);
  if (!returns.length) return { pct: null, days: 0, gaps: series.length };
  const growth = returns.reduce((g, r) => g * (1 + r.ret), 1);
  return { pct: round2((growth - 1) * 100), days: returns.length, gaps: series.slice(1).filter(r => r.ret == null).length };
}

/**
 * Drawdown on the return index: the deepest fall from a peak in percent, when it started, how
 * long it lasted and whether it recovered, today's depth, the underwater series, and the
 * √(π/2)·σ·√T a book with no edge would expect (Magdon-Ismail et al. 2004). A fall touching the
 * wallet segment leaves out open losses, so it is marked as at least that deep.
 */
export function drawdown(series) {
  let index = 1, peak = 1, peakAt = series[0]?.date ?? null, episode = null, worst = null;
  const underwater = series.map(r => {
    if (r.ret != null) index *= 1 + r.ret;
    if (index >= peak) {
      if (episode) episode.recoveredAt = r.date;
      peak = index; peakAt = r.date; episode = null;
    } else {
      episode = episode || { peakAt, depth: 0, troughAt: null, recoveredAt: null, wallet: false };
      episode.wallet ||= r.source === 'wallet';
      if (index / peak - 1 < episode.depth) Object.assign(episode, { depth: index / peak - 1, troughAt: r.date });
      if (!worst || episode.depth < worst.depth) worst = episode;
    }
    return { date: r.date, pct: round2((index / peak - 1) * 100) };
  });
  const returns = series.map(r => r.ret).filter(v => v != null);
  const sigma = returns.length >= MIN_DAYS_ZERO_EDGE ? Math.sqrt(sumOf(returns.map(v => (v - mean(returns)) ** 2)) / (returns.length - 1)) : null;
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY_MS);
  return {
    maxPct: worst ? round2(worst.depth * 100) : 0, peakAt: worst?.peakAt ?? null, troughAt: worst?.troughAt ?? null,
    recoveredAt: worst?.recoveredAt ?? null, lowerBound: worst?.wallet ?? false,
    days: worst ? daysBetween(worst.peakAt, worst.recoveredAt ?? series.at(-1).date) : null,
    current: { pct: underwater.at(-1)?.pct ?? 0, since: episode?.peakAt ?? null },
    underwater,
    zeroEdgePct: sigma == null ? null : round2(-ZERO_DRIFT_DRAWDOWN * sigma * Math.sqrt(returns.length) * 100)
  };
}

function moments(xs) {
  const m = mean(xs);
  const sd = Math.sqrt(sumOf(xs.map(v => (v - m) ** 2)) / xs.length);
  return { m, sd, skew: sd ? mean(xs.map(v => ((v - m) / sd) ** 3)) : 0, kurt: sd ? mean(xs.map(v => ((v - m) / sd) ** 4)) : 3 };
}

const sortinoOf = xs => {
  const downside = Math.sqrt(mean(xs.map(v => Math.min(v, 0) ** 2)));
  return downside ? mean(xs) / downside * Math.sqrt(ANNUAL_DAYS) : null;
};

/**
 * Annualised Sharpe with its standard error and the chance the true Sharpe is above zero
 * (Probabilistic Sharpe Ratio), both corrected for skew and fat tails; Sortino with a 90%
 * bootstrap interval. Under MIN_DAILY_RETURNS days, `needs` says how many more.
 */
export function riskAdjusted(series) {
  const returns = series.map(r => r.ret).filter(v => v != null);
  const n = returns.length;
  if (n < MIN_DAILY_RETURNS) return { n, needs: MIN_DAILY_RETURNS - n };
  const { m, sd, skew, kurt } = moments(returns);
  if (!sd) return { n, needs: 0, sharpe: null, sortino: null };
  const sr = m / sd;
  const se = Math.sqrt(Math.max(0, 1 - skew * sr + (kurt - 1) / 4 * sr ** 2) / (n - 1));
  const boot = dayBootstrap(returns.map(r => [{ r }]), sample => sortinoOf(sample.map(x => x.r)));
  return {
    n, needs: 0,
    sharpe: { value: round2(sr * Math.sqrt(ANNUAL_DAYS)), se: round2(se * Math.sqrt(ANNUAL_DAYS)),
              probAboveZero: se ? round4(normalCdf(sr / se)) : null },
    sortino: { value: round2(sortinoOf(returns)), ci: boot && { lo: round2(boot.lo), hi: round2(boot.hi) } }
  };
}

/** Beta and correlation of daily returns against BTC's daily close-to-close, from MIN_DAILY_RETURNS paired days. */
export function btcBeta(series, btcCandles) {
  const closes = new Map((btcCandles || []).map(c => [new Date(c.t).toISOString().slice(0, 10), c.close]));
  const btcReturn = date => {
    const prev = new Date(Date.parse(date) - DAY_MS).toISOString().slice(0, 10);
    return closes.has(date) && closes.has(prev) ? closes.get(date) / closes.get(prev) - 1 : null;
  };
  const pairs = series.filter(r => r.ret != null).map(r => [r.ret, btcReturn(r.date)]).filter(([, b]) => b != null);
  if (pairs.length < MIN_DAILY_RETURNS) return { n: pairs.length, needs: MIN_DAILY_RETURNS - pairs.length };
  const a = pairs.map(p => p[0]), b = pairs.map(p => p[1]);
  const ma = mean(a), mb = mean(b);
  const cov = sumOf(pairs.map(([x, y]) => (x - ma) * (y - mb))) / (pairs.length - 1);
  const va = sumOf(a.map(x => (x - ma) ** 2)) / (a.length - 1), vb = sumOf(b.map(y => (y - mb) ** 2)) / (b.length - 1);
  return { n: pairs.length, needs: 0, beta: vb ? round2(cov / vb) : null, correlation: va && vb ? round2(cov / Math.sqrt(va * vb)) : null };
}

function riskUsd(t) {
  const stop = t.entry?.yourStop?.price;
  return stop > 0 && t.avgEntry > 0 ? t.openNotional * Math.abs(t.avgEntry - stop) / t.avgEntry : null;
}

/**
 * Win rate (Wilson), payoff, expectancy (day-clustered bootstrap) and profit factor over hedge
 * units, with R on the trips that had a stop. Profit factor needs MIN_UNITS_PROFIT_FACTOR units.
 */
export function unitStats(trips, { intervals = true } = {}) {
  const units = hedgeUnits(trips);
  const n = units.length;
  const results = units.map(u => resultOf(u.net));
  const wins = units.filter((_, i) => results[i] === 'win'), losses = units.filter((_, i) => results[i] === 'loss');
  const grossWin = sumOf(wins.map(u => u.net)), grossLoss = -sumOf(losses.map(u => u.net));
  const winCi = intervals ? wilson(wins.length, n) : null;
  const boot = intervals && n ? dayBootstrap(groupByDay(units), sample => mean(sample.map(u => u.net))) : null;
  const risked = trips.map(t => [t, riskUsd(t)]).filter(([, r]) => r > 0);
  return {
    units: n, legs: trips.length, wins: wins.length, losses: losses.length, flat: n - wins.length - losses.length,
    net: round2(sumOf(units.map(u => u.net))),
    winRate: n ? round4(wins.length / n) : null, winCi: winCi && { lo: round4(winCi.lo), hi: round4(winCi.hi) },
    avgWin: wins.length ? round2(grossWin / wins.length) : null, avgLoss: losses.length ? round2(-grossLoss / losses.length) : null,
    payoff: wins.length && losses.length ? round2((grossWin / wins.length) / (grossLoss / losses.length)) : null,
    expectancy: n ? round2(sumOf(units.map(u => u.net)) / n) : null, expectancyCi: boot && { lo: round2(boot.lo), hi: round2(boot.hi) },
    profitFactor: n < MIN_UNITS_PROFIT_FACTOR ? { needs: MIN_UNITS_PROFIT_FACTOR - n }
      : { needs: 0, value: grossLoss ? round2(grossWin / grossLoss) : null },
    r: { trips: risked.length, of: trips.length,
         avg: risked.length ? round2(mean(risked.map(([t, r]) => netOf(t) / r))) : null },
    medianHoldHours: round2(median(trips.map(t => t.holdHours)))
  };
}

function longestRun(results, kind) {
  let best = 0, run = 0;
  for (const r of results) { run = r === kind ? run + 1 : 0; best = Math.max(best, run); }
  return best;
}

/**
 * Longest losing and winning streaks over hedge units, each against what reshuffling the
 * same results gives: the median longest run and how often chance alone reaches the one seen.
 */
export function streaksVsChance(trips) {
  const results = hedgeUnits(trips).map(u => resultOf(u.net)).filter(r => r !== 'flat');
  const seen = { loss: longestRun(results, 'loss'), win: longestRun(results, 'win') };
  const random = seededRandom();
  const runs = { loss: [], win: [] };
  const deck = [...results];
  for (let s = 0; s < (results.length ? SHUFFLES : 0); s++) {
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    runs.loss.push(longestRun(deck, 'loss'));
    runs.win.push(longestRun(deck, 'win'));
  }
  const chance = kind => {
    if (!runs[kind].length) return null;
    const p = runs[kind].filter(v => v >= seen[kind]).length / runs[kind].length;
    return { median: median(runs[kind]), p: round4(p), unusual: p < UNUSUAL_P };
  };
  let current = 0;
  for (let i = results.length - 1; i >= 0 && results[i] === results.at(-1); i--) current++;
  return { units: results.length, longestLoss: seen.loss, longestWin: seen.win,
           current: results.length ? { result: results.at(-1), length: current } : null,
           chance: { loss: chance('loss'), win: chance('win') } };
}

/** Net per local day from trips, by the day each closed, for a curve narrowed to some trips. */
export function dailyTripNet(trips, tz = 0) {
  const byDay = new Map();
  for (const t of trips) {
    const day = localDayStart(t.closeTime, tz);
    byDay.set(day, (byDay.get(day) || 0) + netOf(t));
  }
  let cum = 0, peak = 0;
  return [...byDay].sort((a, b) => a[0] - b[0]).map(([day, pnl]) => {
    cum += pnl;
    peak = Math.max(peak, cum);
    return { day, date: localDate(day, tz), source: 'trips', value: round2(cum), pnl: round2(pnl), ddUsd: round2(cum - peak) };
  });
}

/** Best and worst unit and day, each with how many it was picked from. */
export function records(trips, days) {
  const units = hedgeUnits(trips).sort((a, b) => b.net - a.net);
  const traded = days.filter(d => d.pnl != null && d.pnl !== 0).sort((a, b) => b.pnl - a.pnl);
  const unit = u => u && { symbol: u.symbol, legs: u.legs, net: round2(u.net), closeTime: u.closeTime };
  const day = d => d && { date: d.date, pnl: d.pnl };
  return { units: units.length, days: traded.length,
           bestUnit: unit(units[0]), worstUnit: unit(units.at(-1)), bestDay: day(traded[0]), worstDay: day(traded.at(-1)) };
}
