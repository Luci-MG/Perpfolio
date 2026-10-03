// habits.js — the journal's shared definitions (net, result, the trip before, usual size, hedge
// units) and the habits measured on them. A habit that changes how a trip ran is costed by
// replaying the trip without it; one that changes which trips happen is compared with its
// nearest alternative; one defined by the trip's own outcome is only counted, since a cost
// there would be circular. Method: docs/research/performance-behaviour.md. Pure.

import { localDayStart } from './local-time.js';
import { dayBootstrap, groupByDay, mean, median, quantile, welch } from './stats.js';

export const THIN_TRIPS = 10;
const REVENGE_SIZE_MULTIPLE = 1.5;
const WINNER_MFE_PCT = 1;
const REENTRY_MINUTES = 30;
const FLAT_USD = 0.01;
const TREND_WEEKS = 8;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** A trip's net after fees and funding; before funding while its funding is unknown. */
export const netOf = t => t.netAfterFunding ?? t.net;

/** 'win', 'loss' or 'flat' (within a cent) for a net amount. */
export const resultOf = net => (net > FLAT_USD ? 'win' : net < -FLAT_USD ? 'loss' : 'flat');

const lost = t => resultOf(netOf(t)) === 'loss';
const round2 = v => (v == null ? null : +v.toFixed(2));
const round4 = v => (v == null ? null : +v.toFixed(4));

/** For each trip, the last trip that closed before it opened, or null. */
export function previousTrips(all) {
  const byClose = [...all].sort((a, b) => a.closeTime - b.closeTime);
  const out = new Map();
  let i = -1;
  for (const t of [...all].sort((a, b) => a.openTime - b.openTime)) {
    while (i + 1 < byClose.length && byClose[i + 1].closeTime <= t.openTime) i++;
    let j = i;
    while (j >= 0 && byClose[j] === t) j--;
    out.set(t, j >= 0 ? byClose[j] : null);
  }
  return out;
}

function sortedMedian(sorted) {
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

function insertSorted(list, v) {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid] < v) lo = mid + 1; else hi = mid; }
  list.splice(lo, 0, v);
}

/** Each trip's median opening notional over the trips opened before it; null until there are THIN_TRIPS of them. */
export function medianSizesBefore(all) {
  const sizes = [];
  const out = new Map();
  for (const t of [...all].sort((a, b) => a.openTime - b.openTime)) {
    out.set(t, sizes.length >= THIN_TRIPS ? sortedMedian(sizes) : null);
    insertSorted(sizes, t.openNotional);
  }
  return out;
}

/**
 * Same-symbol trips that overlap in time, chained into one unit: a hedged long and short are
 * one decision, so counting them apart pulls a win rate towards half. Units sort by close.
 */
export function hedgeUnits(trips) {
  const units = [];
  const bySymbol = new Map();
  for (const t of trips) bySymbol.set(t.symbol, [...(bySymbol.get(t.symbol) || []), t]);
  for (const legs of bySymbol.values()) {
    let unit = null;
    for (const t of legs.sort((a, b) => a.openTime - b.openTime)) {
      if (unit && t.openTime < unit.closeTime) {
        unit.closeTime = Math.max(unit.closeTime, t.closeTime);
        unit.net += netOf(t);
        unit.legs++;
      } else {
        unit = { symbol: t.symbol, openTime: t.openTime, closeTime: t.closeTime, net: netOf(t), legs: 1 };
        units.push(unit);
      }
    }
  }
  return units.sort((a, b) => a.closeTime - b.closeTime);
}

function replayWithoutAdds(t) {
  if (!(t.openQty > 0) || !(t.enteredQty > 0) || t.avgExit == null) return null;
  const share = t.openQty / t.enteredQty;
  const direction = t.side === 'Long' ? 1 : -1;
  const openPrice = t.openNotional / t.openQty;
  const replay = direction * (t.avgExit - openPrice) * t.openQty - t.commission * share + (t.funding ?? 0) * share;
  return netOf(t) - replay;
}

function replayAtUsualSize(t, f) {
  const usual = f.medians.get(t);
  return usual > 0 ? netOf(t) * (1 - usual / t.openNotional) : null;
}

const afterLoss = (t, f) => f.previous.get(t) && lost(f.previous.get(t));
const afterWin = (t, f) => f.previous.get(t) && resultOf(netOf(f.previous.get(t))) === 'win';
const soonAfterPrevious = (t, f) => t.openTime - f.previous.get(t).closeTime <= REENTRY_MINUTES * 60_000;
const biggerThanUsual = (t, f) => f.medians.get(t) > 0 && t.openNotional > REVENGE_SIZE_MULTIPLE * f.medians.get(t);

/**
 * The habits measured. `has` picks the trips showing it, `of` the trips its share is out of.
 * `replay` costs it per trip against the same trip without it; `comparison` costs it against
 * the nearest alternative trips; a habit with neither is counted only. `ratio` habits carry a
 * figure of their own.
 */
export const HABITS = [
  { id: 'underwaterAdds', label: 'Added to a losing position', against: 'the same trips without the adds (est.)',
    of: () => true, has: t => t.addsWhileUnderwater > 0, replay: replayWithoutAdds,
    goal: () => ({ type: 'noUnderwaterAdds', params: {} }) },
  { id: 'biggerAfterLoss', label: 'Opened bigger right after a loss', against: 'the same trips at your usual size',
    of: () => true, has: (t, f) => afterLoss(t, f) && biggerThanUsual(t, f), replay: replayAtUsualSize,
    goal: () => ({ type: 'maxSize', params: { multiple: REVENGE_SIZE_MULTIPLE } }) },
  { id: 'quickReentry', label: `Re-entered within ${REENTRY_MINUTES} min of a loss`, against: `re-entries within ${REENTRY_MINUTES} min of a win`,
    of: () => true, has: (t, f) => afterLoss(t, f) && soonAfterPrevious(t, f),
    comparison: (t, f) => afterWin(t, f) && soonAfterPrevious(t, f),
    goal: () => ({ type: 'lossStreakStop', params: { losses: 1 } }) },
  { id: 'busyDays', label: 'Traded on your busiest days', against: 'trips on your quietest days',
    of: () => true, has: (t, f) => f.dayCount.get(t) > f.busyCut, comparison: (t, f) => f.dayCount.get(t) <= f.quietCut,
    goal: f => ({ type: 'maxTradesPerDay', params: { max: Math.max(1, Math.ceil(f.busyCut)) } }) },
  { id: 'winnerToLoser', label: 'Let a winner turn into a loss', against: `losing trips that were up ${WINNER_MFE_PCT}% or more`,
    of: t => lost(t) && t.mfe != null, has: t => lost(t) && t.mfe >= WINNER_MFE_PCT,
    goal: () => ({ type: 'maxLossPct', params: {} }) },
  { id: 'heldLosers', label: 'Held losers longer than winners', against: 'median hold of losers ÷ winners',
    of: t => resultOf(netOf(t)) !== 'flat', has: lost, ratio: true,
    goal: () => ({ type: 'maxLossPct', params: {} }) }
];

function factsOf(all, tz) {
  const perDay = new Map();
  for (const t of all) perDay.set(localDayStart(t.openTime, tz), (perDay.get(localDayStart(t.openTime, tz)) || 0) + 1);
  const counts = [...perDay.values()].sort((a, b) => a - b);
  return {
    previous: previousTrips(all), medians: medianSizesBefore(all),
    dayCount: new Map(all.map(t => [t, perDay.get(localDayStart(t.openTime, tz))])),
    busyCut: counts.length ? quantile(counts, 2 / 3) : Infinity,
    quietCut: counts.length ? quantile(counts, 1 / 3) : -Infinity
  };
}

const sumOf = xs => xs.reduce((s, x) => s + x, 0);

function replayCost(def, trips, f, withInterval) {
  const costed = trips.map(t => [t, def.replay(t, f)]).filter(([, d]) => d != null);
  const delta = new Map(costed);
  const cost = sumOf(costed.map(([, d]) => d));
  const ci = withInterval && costed.length
    ? dayBootstrap(groupByDay(costed.map(([t]) => t)), sample => sumOf(sample.map(t => delta.get(t)))) : null;
  return { cost, ci, costed: costed.length, comparisonTrips: null };
}

function comparisonCost(def, trips, scope, f, withInterval) {
  const others = scope.filter(t => def.comparison(t, f));
  if (!trips.length || !others.length) return { cost: null, ci: null, comparisonTrips: others.length };
  const diff = mean(trips.map(netOf)) - mean(others.map(netOf));
  if (!withInterval) return { cost: diff * trips.length, ci: null, comparisonTrips: others.length };
  const inHabit = new Set(trips);
  const boot = dayBootstrap(groupByDay([...trips, ...others]), sample => {
    const a = sample.filter(t => inHabit.has(t)), b = sample.filter(t => !inHabit.has(t));
    return a.length && b.length ? mean(a.map(netOf)) - mean(b.map(netOf)) : null;
  });
  const w = welch(trips.map(netOf), others.map(netOf));
  const wider = [boot, w].filter(Boolean).sort((x, y) => (y.hi - y.lo) - (x.hi - x.lo))[0];
  const ci = wider && { lo: wider.lo * trips.length, hi: wider.hi * trips.length };
  return { cost: diff * trips.length, ci, comparisonTrips: others.length };
}

function holdRatio(scope) {
  const hold = pick => median(scope.filter(pick).map(t => t.holdHours));
  const losers = hold(lost), winners = hold(t => resultOf(netOf(t)) === 'win');
  return losers != null && winners > 0 ? losers / winners : null;
}

function measure(def, scope, f, withInterval) {
  const base = scope.filter(t => def.of(t, f));
  const trips = base.filter(t => def.has(t, f));
  const share = base.length ? trips.length / base.length : null;
  const costed = def.replay ? replayCost(def, trips, f, withInterval)
    : def.comparison ? comparisonCost(def, trips, scope, f, withInterval) : { cost: null, ci: null, comparisonTrips: null };
  return { trips: trips.length, outOf: base.length, share, ratio: def.ratio ? holdRatio(scope) : null, ...costed };
}

function verdictOf(def, m) {
  if (!def.replay && !def.comparison) return null;
  const sideThin = def.comparison && m.comparisonTrips < THIN_TRIPS;
  if (m.trips < THIN_TRIPS || sideThin || !m.ci) return 'thin';
  return m.ci.hi < 0 ? 'costs' : m.ci.lo > 0 ? 'helps' : 'cant-tell';
}

function weeklyShares(def, all, f, { inSession, now }) {
  return Array.from({ length: TREND_WEEKS }, (_, i) => {
    const to = now - (TREND_WEEKS - 1 - i) * WEEK_MS, from = to - WEEK_MS;
    const base = all.filter(t => t.openTime >= from && t.openTime < to && inSession(t) && def.of(t, f));
    return base.length ? { share: round4(base.filter(t => def.has(t, f)).length / base.length), n: base.length } : null;
  });
}

/**
 * Each habit over the trips `inScope` picks out of `all`: count and share, cost with a 90%
 * day-clustered interval and a verdict (`costs`, `helps`, `cant-tell`, `thin`; null when only
 * counted), the same over `inPrevious`, an 8-week share trend, and the goal that rules it out.
 * The trip before, usual size and busy days are always judged on `all`.
 */
export function habitReport(all, { inScope = () => true, inPrevious = null, inSession = () => true,
                                   now = Date.now(), tz = 0 } = {}) {
  const f = factsOf(all, tz);
  const scope = all.filter(inScope);
  const previousScope = inPrevious ? all.filter(inPrevious) : null;
  return HABITS.map(def => {
    const m = measure(def, scope, f, true);
    const before = previousScope ? measure(def, previousScope, f, false) : null;
    return {
      id: def.id, label: def.label, against: def.against,
      kind: def.replay ? 'replay' : def.comparison ? 'comparison' : def.ratio ? 'ratio' : 'count',
      trips: m.trips, outOf: m.outOf, share: round4(m.share), ratio: round2(m.ratio),
      comparisonTrips: m.comparisonTrips, costed: m.costed ?? null,
      cost: round2(m.cost), ci: m.ci && { lo: round2(m.ci.lo), hi: round2(m.ci.hi) },
      verdict: verdictOf(def, m),
      previous: before && { trips: before.trips, share: round4(before.share), cost: round2(before.cost), ratio: round2(before.ratio) },
      pending: def.id === 'winnerToLoser' ? scope.filter(t => lost(t) && t.mfe == null).length : null,
      weekly: weeklyShares(def, all, f, { inSession, now }),
      goal: def.goal(f)
    };
  });
}

/** Opening size over the trips `inScope` picks: spread, and the median after a loss against after a win. */
export function sizing(all, inScope = () => true) {
  const previous = previousTrips(all);
  const scope = all.filter(inScope);
  const sizes = scope.map(t => t.openNotional).sort((a, b) => a - b);
  if (!sizes.length) return null;
  const after = kind => {
    const xs = scope.filter(t => previous.get(t) && resultOf(netOf(previous.get(t))) === kind).map(t => t.openNotional);
    return { median: round2(median(xs)), trips: xs.length };
  };
  return { trips: sizes.length, p10: round2(quantile(sizes, 0.1)), median: round2(median(sizes)),
           p90: round2(quantile(sizes, 0.9)), max: round2(sizes.at(-1)), afterLoss: after('loss'), afterWin: after('win') };
}
