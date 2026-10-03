// outcome-factors.js — which conditions at entry go with better or worse trips. Each factor
// splits trips into buckets known when the trip opened; each bucket is compared with the rest
// of the book on average net per trip and win rate, with intervals that treat a day's trips as
// one draw. Exploratory: association, not cause. Method and thresholds:
// docs/research/outcome-factors.md. Pure, over trips enriched with context.

import { medianSizesBefore, netOf, previousTrips, resultOf } from './habits.js';
import { BOOTSTRAP_DRAWS, benjaminiHochberg, dayBootstrap, groupByDay, mean, median as medianOf, quantile, welch, wilson } from './stats.js';
import { wallTime } from './local-time.js';
import { periodStarts } from './trade-analytics.js';

export const MIN_TRIPS = 20;
const MIN_DAYS = 8;
const THIN_BELOW = 40;
const RECENT_SHARE = 0.3;
const STABILITY_MIN_TRIPS = 10;
const STRATUM_MIN_TRIPS = 5;
const DAY_MS = 86_400_000;
const CONFLUENCE_LEAN = 0.25;

const won = t => resultOf(netOf(t)) === 'win';
const confluenceSide = score => (score >= CONFLUENCE_LEAN ? 'Long' : score <= -CONFLUENCE_LEAN ? 'Short' : null);

function confluenceBucket(t) {
  const score = t.entry?.confluence?.score;
  if (score == null) return null;
  const lean = confluenceSide(score);
  return !lean ? 'Neutral' : lean === t.side ? 'Agrees' : 'Against';
}

function previousBucket(t, f) {
  const prev = f.previous.get(t);
  return !prev ? 'First of the day' : won(prev) ? 'After a win' : 'After a loss';
}

function sizeBucket(t, f) {
  const median = f.medians.get(t);
  if (!(median > 0)) return null;
  const ratio = t.openNotional / median;
  return ratio < 0.75 ? 'Under 0.75× median' : ratio <= 1.5 ? '0.75–1.5× median' : 'Over 1.5× median';
}

const HOUR_BANDS = ['00–06', '06–12', '12–18', '18–24'];

/**
 * Factors known when a trip opens. `bucket` names a trip's bucket (null leaves it out); a
 * factor with `value` is split into terciles cut on the early window. `needs: 'entry'` marks
 * factors read from the context captured at entry.
 */
export const FACTORS = [
  { id: 'session', label: 'Session', sessionWide: true, bucket: t => t.session },
  { id: 'weekend', label: 'Weekday or weekend', sessionWide: true, bucket: t => (t.session === 'Weekend' ? 'Weekend' : 'Weekday') },
  { id: 'hour', label: 'Hour opened', bucket: (t, f) => HOUR_BANDS[Math.floor(f.localHour(t.openTime) / 6)] },
  { id: 'side', label: 'Side', bucket: t => t.side },
  { id: 'hedged', label: 'Hedged at entry', bucket: t => (t.hedged ? 'Hedged' : 'Not hedged') },
  { id: 'size', label: 'Size against earlier median', bucket: sizeBucket },
  { id: 'previous', label: 'Previous trip', bucket: previousBucket },
  { id: 'group', label: 'Coin', bucket: t => (/^(BTC|ETH)/.test(t.symbol) ? 'BTC & ETH' : 'Alts') },
  { id: 'btc', label: 'BTC trend at entry', bucket: t => (t.btcTrend ? `BTC ${t.btcTrend}` : null) },
  { id: 'atr', label: 'Volatility at entry (ATR)', value: t => t.atrPct, names: ['Calm', 'Normal', 'Volatile'] },
  { id: 'confluence', label: 'Confluence at entry', needs: 'entry', bucket: confluenceBucket },
  { id: 'leverage', label: 'Leverage at entry', needs: 'entry', value: t => t.entry?.account?.leverage, names: ['Low', 'Mid', 'High'] },
  { id: 'margin', label: 'Margin used at entry', needs: 'entry', value: t => t.entry?.account?.marginPct, names: ['Low', 'Mid', 'High'] },
  { id: 'stop', label: 'Stop within 5 minutes', needs: 'entry',
    bucket: t => (t.entry?.stopLooked ? (t.entry.yourStop ? 'Stop set' : 'No stop') : null) }
];

/** Behaviour during the trade: shown apart and never ranked, since it is not known at entry. */
export const DURING_TRADE = [
  { id: 'adds', label: 'Added while underwater', bucket: t => (t.addsWhileUnderwater > 0 ? 'Added underwater' : 'Never added underwater') },
  { id: 'hold', label: 'Hold time', value: t => t.holdHours, names: ['Short', 'Medium', 'Long'] }
];

const GOAL_FOR = {
  'weekend:Weekend': { type: 'noSessions', params: { sessions: ['Weekend'] } },
  'size:Over 1.5× median': { type: 'maxSize', params: { multiple: 1.5 } },
  'previous:After a loss': { type: 'lossStreakStop', params: { losses: 1 } }
};

function goalFor(factor, bucket) {
  if (factor === 'session') return { type: 'noSessions', params: { sessions: [bucket] } };
  return GOAL_FOR[`${factor}:${bucket}`] ?? null;
}

/**
 * Interval (90%) and two-sided p for the difference in average net, `inBucket` trips against
 * the rest, resampling whole days so a day's trips move together. Seeded: same input, same answer.
 */
export function clusterBootstrap(days, inBucket, draws = BOOTSTRAP_DRAWS) {
  const summaries = days.map(day => {
    const s = { sumIn: 0, nIn: 0, sumRest: 0, nRest: 0 };
    for (const t of day) {
      if (inBucket(t)) { s.sumIn += netOf(t); s.nIn++; } else { s.sumRest += netOf(t); s.nRest++; }
    }
    return [s];
  });
  return dayBootstrap(summaries, sample => {
    let sumIn = 0, nIn = 0, sumRest = 0, nRest = 0;
    for (const s of sample) { sumIn += s.sumIn; nIn += s.nIn; sumRest += s.sumRest; nRest += s.nRest; }
    return nIn && nRest ? sumIn / nIn - sumRest / nRest : null;
  }, draws);
}

function contextOf(trips, tz) {
  const localDay = ts => periodStarts(ts, tz).today;
  const before = previousTrips(trips);
  const previous = new Map(trips.map(t => {
    const prev = before.get(t);
    return [t, prev && prev.closeTime >= localDay(t.openTime) ? prev : null];
  }));
  return { medians: medianSizesBefore(trips), previous, localHour: ts => wallTime(ts, tz).getUTCHours() };
}

function tercileBucketer(def, early) {
  const values = early.map(def.value).filter(v => v != null).sort((a, b) => a - b);
  if (values.length < 3) return () => null;
  const cuts = [quantile(values, 1 / 3), quantile(values, 2 / 3)];
  return t => {
    const v = def.value(t);
    return v == null ? null : def.names[v <= cuts[0] ? 0 : v <= cuts[1] ? 1 : 2];
  };
}

function bucketerFor(def, early, facts) {
  return def.value ? tercileBucketer(def, early) : t => def.bucket(t, facts);
}

const dayKey = t => Math.floor(t.openTime / DAY_MS);

const diffOf = (a, b) => (a.length && b.length ? mean(a.map(netOf)) - mean(b.map(netOf)) : null);

function stabilityOf(trips, split, inBucket) {
  const halves = [trips.slice(0, split), trips.slice(split)].map(part => {
    const inside = part.filter(inBucket), rest = part.filter(t => !inBucket(t));
    return { diff: diffOf(inside, rest), thin: inside.length < STABILITY_MIN_TRIPS || rest.length < STABILITY_MIN_TRIPS };
  });
  const [early, recent] = halves;
  if (early.diff == null || recent.diff == null || recent.thin) return 'thin';
  return Math.sign(early.diff) === Math.sign(recent.diff) ? 'holds' : 'fades';
}

function signFlips(trips, inBucket, diff, strata) {
  return strata.some(stratumOf => {
    const groups = new Map();
    for (const t of trips) {
      const key = stratumOf(t);
      if (key != null) groups.set(key, [...(groups.get(key) || []), t]);
    }
    return [...groups.values()].some(group => {
      const inside = group.filter(inBucket), rest = group.filter(t => !inBucket(t));
      if (inside.length < STRATUM_MIN_TRIPS || rest.length < STRATUM_MIN_TRIPS) return false;
      return Math.sign(diffOf(inside, rest)) === -Math.sign(diff);
    });
  });
}

const round2 = v => (v == null ? null : +v.toFixed(2));
const round4 = v => (v == null ? null : +v.toFixed(4));
const roundInterval = ({ lo, hi }, round) => ({ lo: round(lo), hi: round(hi) });

function compareBucket(name, members, trips, days, ctx) {
  const inBucket = t => members.has(t);
  const inside = trips.filter(inBucket), rest = trips.filter(t => !inBucket(t));
  const insideDays = new Set(inside.map(dayKey)).size;
  const base = { bucket: name, n: inside.length, days: insideDays };
  if (inside.length < MIN_TRIPS || insideDays < MIN_DAYS || rest.length < MIN_TRIPS) return { ...base, hidden: true };
  const diff = diffOf(inside, rest);
  const boot = clusterBootstrap(days, inBucket);
  const w = welch(inside.map(netOf), rest.map(netOf));
  const wider = [boot, w].filter(Boolean).sort((a, b) => (b.hi - b.lo) - (a.hi - a.lo))[0];
  const wins = inside.filter(won).length;
  const net = inside.reduce((s, t) => s + netOf(t), 0);
  const total = trips.reduce((s, t) => s + netOf(t), 0);
  const medianDiff = medianOf(inside.map(netOf)) - medianOf(rest.map(netOf));
  return {
    ...base, thin: inside.length < THIN_BELOW,
    avgNet: round2(mean(inside.map(netOf))), restAvgNet: round2(mean(rest.map(netOf))), diff: round2(diff),
    ci: roundInterval(wider, round2), p: Math.max(boot?.p ?? 0, w?.p ?? 0),
    medianDiff: round2(medianDiff), medianDisagrees: Math.sign(medianDiff) === -Math.sign(diff),
    winRate: round4(wins / inside.length), winCi: roundInterval(wilson(wins, inside.length), round4),
    restWinRate: round4(rest.filter(won).length / rest.length),
    net: round2(net), share: total ? round4(net / total) : null,
    stability: stabilityOf(trips, ctx.split, inBucket),
    signFlip: signFlips(trips, inBucket, diff, ctx.strata)
  };
}

function scoreTags(trips, days, ctx) {
  const byTag = new Map();
  for (const t of trips) for (const tag of t.tags || []) byTag.set(tag, (byTag.get(tag) || new Set()).add(t));
  const strata = ctx.strata.map(s => s.of);
  const buckets = [...byTag].map(([tag, members]) => ({ ...compareBucket(tag, members, trips, days, { ...ctx, strata }), standsOut: false }));
  return { id: 'tags', label: 'Your tags', buckets: buckets.filter(b => !b.hidden), hiddenBuckets: buckets.filter(b => b.hidden).length };
}

function scoreFactor(def, trips, days, ctx) {
  const bucketOf = bucketerFor(def, ctx.early, ctx.facts);
  const groups = new Map();
  for (const t of trips) {
    const name = bucketOf(t);
    if (name != null) groups.set(name, (groups.get(name) || new Set()).add(t));
  }
  const buckets = [...groups].map(([name, members]) => compareBucket(name, members, trips, days, {
    ...ctx, strata: ctx.strata.filter(s => s.id !== def.id).map(s => s.of)
  }));
  return { id: def.id, label: def.label, needs: def.needs ?? null,
           buckets: buckets.filter(b => !b.hidden), hiddenBuckets: buckets.filter(b => b.hidden).length };
}

/**
 * Every factor's buckets against the rest of the book, the rows that stand out (interval clear
 * of zero and passing Benjamini–Hochberg across every comparison shown), and the during-trade
 * behaviours and your own tags apart, since both are known only after entry. `session` hides
 * the factors a session filter makes meaningless. `all` is every trip before any filter, which
 * the previous trip and the usual size are judged on; `trips` must be drawn from it.
 */
export function outcomeFactors(trips, { tz = 0, session = null, all = trips } = {}) {
  const sorted = [...(trips || [])].sort((a, b) => a.openTime - b.openTime);
  const split = Math.floor(sorted.length * (1 - RECENT_SHARE));
  const facts = contextOf([...(all || [])].sort((a, b) => a.openTime - b.openTime), tz);
  const early = sorted.slice(0, split);
  const size = FACTORS.find(f => f.id === 'size'), hedged = FACTORS.find(f => f.id === 'hedged');
  const strata = [{ id: 'size', of: t => size.bucket(t, facts) }, { id: 'hedged', of: t => hedged.bucket(t) }];
  const ctx = { facts, early, split, strata };
  const days = groupByDay(sorted);
  const entryCaptured = sorted.filter(t => t.entry).length;

  const shown = FACTORS.filter(f => !(session && f.sessionWide) && !(f.needs === 'entry' && !entryCaptured));
  const factors = shown.map(def => scoreFactor(def, sorted, days, ctx));
  const rows = factors.flatMap(f => f.buckets.map(b => ({ f, b })));
  const pass = benjaminiHochberg(rows.map(({ b }) => b.p));
  rows.forEach(({ f, b }, i) => {
    b.standsOut = pass[i] && (b.ci.lo > 0 || b.ci.hi < 0);
    b.goal = b.standsOut && b.diff < 0 ? goalFor(f.id, b.bucket) : null;
  });
  const verdict = rows.filter(({ b }) => b.standsOut)
    .map(({ f, b }) => ({ factor: f.id, label: f.label, ...b }))
    .sort((x, y) => x.diff - y.diff);

  return {
    trips: sorted.length, days: days.length, comparisons: rows.length, entryCaptured,
    worse: verdict.filter(r => r.diff < 0), better: verdict.filter(r => r.diff > 0).reverse(),
    factors,
    waiting: entryCaptured ? [] : FACTORS.filter(f => f.needs === 'entry').map(f => f.label),
    during: DURING_TRADE.map(def => scoreFactor(def, sorted, days, ctx)),
    tags: scoreTags(sorted, days, ctx)
  };
}
