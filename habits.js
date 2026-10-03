// habits.js — trading habits and what each one cost. Each habit splits trips into those that
// show it and a comparison group that does not; the cost is an estimate, the gap in average
// net between the two times the habit's trips. Pure, over trips enriched with context.

export const THIN_TRIPS = 10;
export const REVENGE_SIZE_MULTIPLE = 1.5;
export const WINNER_MFE_PCT = 1;

export const netOf = t => t.netAfterFunding ?? t.net;
const lost = t => netOf(t) < 0;

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function previousResult(trips) {
  const byClose = [...trips].sort((a, b) => a.closeTime - b.closeTime);
  return new Map(trips.map(t => {
    const before = byClose.filter(x => x.closeTime <= t.openTime).at(-1);
    return [t, before ? (lost(before) ? 'loss' : 'win') : null];
  }));
}

function contextOf(trips) {
  return {
    medianSize: median(trips.map(t => t.openNotional)),
    medianWinnerHold: median(trips.filter(t => !lost(t)).map(t => t.holdHours)),
    previous: previousResult(trips)
  };
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

const biggerThanUsual = (t, c) => t.openNotional > REVENGE_SIZE_MULTIPLE * c.medianSize;
const wasWinner = t => t.mfe >= WINNER_MFE_PCT;

/** The habits measured, each a trip predicate and the comparison it is measured against. */
export const HABITS = [
  { id: 'underwaterAdds', label: 'Added while underwater', against: 'trips that never added at a worse price',
    has: t => t.addsWhileUnderwater > 0, comparison: t => t.addsWhileUnderwater === 0 },
  { id: 'biggerAfterLoss', label: 'Bigger after a loss', against: 'other trips opened right after a loss',
    has: (t, c) => c.previous.get(t) === 'loss' && biggerThanUsual(t, c),
    comparison: (t, c) => c.previous.get(t) === 'loss' && !biggerThanUsual(t, c) },
  { id: 'winnerToLoser', label: 'Winner turned loser', against: 'other losing trips',
    has: t => lost(t) && t.mfe != null && wasWinner(t), comparison: t => lost(t) && t.mfe != null && !wasWinner(t) },
  { id: 'heldLosers', label: 'Held losers longer', against: 'losers closed within the median winner\'s hold',
    has: (t, c) => lost(t) && t.holdHours > c.medianWinnerHold, comparison: (t, c) => lost(t) && t.holdHours <= c.medianWinnerHold }
];

const average = trips => (trips.length ? trips.reduce((s, t) => s + netOf(t), 0) / trips.length : null);

/** Per habit: trip counts and average net on each side, the estimated cost, and whether either side is thin. */
export function habitCosts(trips) {
  const c = contextOf(trips || []);
  return HABITS.map(({ id, label, against, has, comparison }) => {
    const withIt = trips.filter(t => has(t, c));
    const without = trips.filter(t => comparison(t, c));
    const avgWith = average(withIt), avgWithout = average(without);
    const cost = avgWith != null && avgWithout != null ? (avgWith - avgWithout) * withIt.length : null;
    return { id, label, against, trips: withIt.length, comparisonTrips: without.length,
             avgNet: avgWith == null ? null : +avgWith.toFixed(2),
             avgNetComparison: avgWithout == null ? null : +avgWithout.toFixed(2),
             cost: cost == null ? null : +cost.toFixed(2),
             thin: withIt.length < THIN_TRIPS || without.length < THIN_TRIPS };
  });
}
