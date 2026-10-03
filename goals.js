// goals.js — rules you set for yourself, scored against your trips from the day you set them.
// GOAL_TYPES is the one list of goals: its params drive the add form and the server's
// validation, so a new goal is one entry. Pure, over trips enriched with session and entry
// context (lib/trip-enrichment.js).

import { THIN_TRIPS, netOf } from './habits.js';
import { SESSIONS } from './sessions.js';
import { periodStarts } from './trade-analytics.js';

const DAY_MS = 86_400_000;
const STOP_LOOK_MS = 5 * 60_000;
const SNAPSHOT_MATCH_MS = 15 * 60_000;
const STRIP_DAYS = 7;
const PREVIEW_DAYS = 14;
const CALENDAR_DAYS = 56;
const BREACHES_LISTED = 30;
const SUGGESTED_PERCENTILE = 0.85;
const SUGGESTIONS = 3;

const kept = { kept: true };
const broke = what => ({ kept: false, what });
const judge = (isBroken, what) => (isBroken ? broke(what()) : kept);
const lost = t => netOf(t) < 0;
const fmtUsd = v => `$${Math.abs(v).toFixed(2)}`;

/** The goals that can be set: params describe the form fields, `check` judges one trip. */
export const GOAL_TYPES = [
  { id: 'maxLeverage', label: 'Max leverage', unit: 'trip', forwardOnly: true,
    params: [{ key: 'max', label: 'Max', suffix: '×', min: 1, max: 125, step: 1, default: 10 }],
    describe: p => `Max leverage ${p.max}×`,
    check: (t, p) => {
      const lev = t.entry?.account?.leverage;
      return lev == null ? null : judge(lev > p.max, () => `leverage ${lev}×`);
    } },
  { id: 'stopWithin5m', label: 'Stop within 5 minutes', unit: 'trip', forwardOnly: true, params: [],
    describe: () => 'Stop within 5 minutes of entry',
    check: t => {
      if (!t.entry?.stopLooked || t.closeTime - t.openTime < STOP_LOOK_MS) return null;
      return judge(t.entry.yourStop == null, () => 'no stop after 5 min');
    } },
  { id: 'maxLossPct', label: 'Max loss per trade', unit: 'trip',
    params: [{ key: 'limit', label: 'Limit', min: 0.01, max: 1e6, step: 0.01, default: 1 },
             { key: 'of', label: 'Of', options: [['pct', '% of equity at entry'], ['usd', '$']], default: 'pct' }],
    describe: p => (p.of === 'usd' ? `Max loss ${fmtUsd(p.limit)} a trade` : `Max loss ${p.limit}% a trade`),
    check: (t, p, f, ctx) => {
      const net = netOf(t);
      if (p.of === 'usd') return judge(-net > p.limit, () => `lost ${fmtUsd(net)}`);
      const equity = ctx.equityAt?.(t.openTime);
      if (!(equity?.value > 0)) return null;
      const pct = -net / equity.value * 100;
      return judge(pct > p.limit, () => `lost ${pct.toFixed(2)}% of equity${equity.approx ? ' (≈ wallet)' : ''}`);
    } },
  { id: 'noUnderwaterAdds', label: 'No adding while underwater', unit: 'trip', params: [],
    describe: () => 'No adding while underwater',
    check: t => judge(t.addsWhileUnderwater > 0, () => `${t.addsWhileUnderwater} add${t.addsWhileUnderwater > 1 ? 's' : ''} underwater`) },
  { id: 'maxSize', label: 'Max size', unit: 'trip',
    params: [{ key: 'multiple', label: 'Max', suffix: '× median size', min: 1, max: 50, step: 0.1, default: 2 }],
    describe: p => `Max size ${p.multiple}× median`,
    check: (t, p, f) => {
      if (!(f.medianBefore > 0)) return null;
      const multiple = t.openNotional / f.medianBefore;
      return judge(multiple > p.multiple, () => `${multiple.toFixed(1)}× median size`);
    } },
  { id: 'maxTradesPerDay', label: 'Max trades a day', unit: 'day',
    params: [{ key: 'max', label: 'Max', suffix: 'trades a day', min: 1, max: 100, step: 1, default: 6 }],
    describe: p => `Max ${p.max} trades a day`,
    check: (t, p, f) => judge(f.nthToday > p.max, () => `trade ${f.nthToday} of the day`) },
  { id: 'lossStreakStop', label: 'Stop after losses in a row', unit: 'trip',
    params: [{ key: 'losses', label: 'After', suffix: 'losses in a row', min: 1, max: 20, step: 1, default: 3 }],
    describe: p => `Stop for the day after ${p.losses} loss${p.losses > 1 ? 'es' : ''} in a row`,
    check: (t, p, f) => judge(f.lossStreak >= p.losses, () => `after ${f.lossStreak} losses in a row`) },
  { id: 'noSessions', label: 'No trading in sessions', unit: 'trip', scoped: false,
    params: [{ key: 'sessions', label: 'Sessions', sessions: true, default: ['Weekend'] }],
    describe: p => `No trading: ${p.sessions.join(', ')}`,
    check: (t, p) => judge(p.sessions.includes(t.session), () => t.session) }
];

const typeOf = id => GOAL_TYPES.find(g => g.id === id);

function cleanNumber(spec, raw) {
  const v = typeof raw === 'string' ? parseFloat(raw) : raw;
  if (!Number.isFinite(v) || v < spec.min || v > spec.max) throw new Error(`${spec.label} must be ${spec.min}–${spec.max}`);
  if (Number.isInteger(spec.step) && !Number.isInteger(v)) throw new Error(`${spec.label} must be a whole number`);
  return v;
}

function cleanParam(spec, raw) {
  if (spec.sessions) {
    const list = Array.isArray(raw) ? [...new Set(raw)] : [];
    if (!list.length || !list.every(s => SESSIONS.includes(s))) throw new Error(`${spec.label}: pick from ${SESSIONS.join(', ')}`);
    return list;
  }
  if (spec.options) {
    if (!spec.options.some(([v]) => v === raw)) throw new Error(`${spec.label}: one of ${spec.options.map(o => o[0]).join(', ')}`);
    return raw;
  }
  return cleanNumber(spec, raw);
}

/** The goal's type, params and session scope, checked against GOAL_TYPES; throws a readable Error otherwise. */
export function validateGoal({ type, params = {}, session = null } = {}) {
  const def = typeOf(type);
  if (!def) throw new Error(`unknown goal type ${type}`);
  if (session != null && (def.scoped === false || !SESSIONS.includes(session))) throw new Error('session scope not allowed here');
  const clean = Object.fromEntries(def.params.map(spec => [spec.key, cleanParam(spec, params?.[spec.key] ?? spec.default)]));
  return { type, params: clean, session: session ?? null };
}

export function describeGoal({ type, params, session }) {
  const text = typeOf(type).describe(params);
  return session ? `${text} · ${session}` : text;
}

const localDay = (ts, tz) => periodStarts(ts, tz).today;

function median(sorted) {
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}

function insertSorted(list, v) {
  let lo = 0, hi = list.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid] < v) lo = mid + 1; else hi = mid; }
  list.splice(lo, 0, v);
}

function medianSizesBefore(all) {
  const sizes = [];
  const out = new Map();
  for (const t of [...all].sort((a, b) => a.openTime - b.openTime)) {
    out.set(t, sizes.length >= THIN_TRIPS ? median(sizes) : null);
    insertSorted(sizes, t.openNotional);
  }
  return out;
}

function trailingLosses(scoped, trip, day) {
  const closed = scoped.filter(x => x.closeTime >= day && x.closeTime <= trip.openTime).sort((a, b) => a.closeTime - b.closeTime);
  let streak = 0;
  for (let i = closed.length - 1; i >= 0 && lost(closed[i]); i--) streak++;
  return streak;
}

function evaluate(def, goal, trips, ctx) {
  const tz = ctx.tzOffsetMin || 0;
  const scoped = trips.filter(t => !goal.session || t.session === goal.session).sort((a, b) => a.openTime - b.openTime);
  const medians = def.id === 'maxSize' ? medianSizesBefore(trips) : null;
  const perDay = new Map();
  return scoped.flatMap(trip => {
    const day = localDay(trip.openTime, tz);
    perDay.set(day, (perDay.get(day) || 0) + 1);
    const facts = { nthToday: perDay.get(day), medianBefore: medians?.get(trip),
                    lossStreak: def.id === 'lossStreakStop' ? trailingLosses(scoped, trip, day) : 0 };
    const verdict = def.check(trip, goal.params, facts, ctx);
    return verdict ? [{ trip, day, ...verdict }] : [];
  });
}

function periodsOf(def, rows) {
  if (def.unit === 'trip') return rows.map(r => ({ t: r.trip.openTime, kept: r.kept }));
  const days = new Map();
  for (const r of rows) days.set(r.day, (days.get(r.day) ?? true) && r.kept);
  return [...days].map(([t, isKept]) => ({ t, kept: isKept }));
}

function streakOf(periods) {
  let n = 0;
  for (let i = periods.length - 1; i >= 0 && periods[i].kept; i--) n++;
  return n;
}

const average = trips => (trips.length ? trips.reduce((s, t) => s + netOf(t), 0) / trips.length : null);
const round2 = v => (v == null ? null : +v.toFixed(2));

function costOf(rows) {
  const brokenTrips = rows.filter(r => !r.kept).map(r => r.trip);
  const keptTrips = rows.filter(r => r.kept).map(r => r.trip);
  const avgBroken = average(brokenTrips), avgKept = average(keptTrips);
  const cost = avgBroken != null && avgKept != null ? (avgBroken - avgKept) * brokenTrips.length : null;
  return { brokenTrips: brokenTrips.length, keptTrips: keptTrips.length, avgBroken: round2(avgBroken),
           avgKept: round2(avgKept), cost: round2(cost),
           thin: brokenTrips.length < THIN_TRIPS || keptTrips.length < THIN_TRIPS };
}

function summary(def, rows) {
  const periods = periodsOf(def, rows);
  return { n: periods.length, unit: def.unit,
           adherence: periods.length ? +(periods.filter(p => p.kept).length / periods.length).toFixed(4) : null,
           ...costOf(rows) };
}

function dayCells(rows, today, count, isScored = () => true) {
  return Array.from({ length: count }, (_, i) => {
    const day = today - (count - 1 - i) * DAY_MS;
    const onDay = rows.filter(r => r.day === day);
    const state = !isScored(day + DAY_MS - 1) ? 'unset'
      : onDay.some(r => !r.kept) ? 'broken' : onDay.length ? 'kept' : 'none';
    return { day, state };
  });
}

const activePause = goal => (goal.pauses || []).find(p => p.to == null) || null;
const inPause = (goal, t) => (goal.pauses || []).some(p => t >= p.from && (p.to == null || t < p.to));

function statusOf(def, goal, today, periods) {
  if (activePause(goal)) return 'paused';
  if (today.some(r => !r.kept)) return 'broken';
  if (def.unit === 'day' && today.length) return 'progress';
  return periods.length ? 'kept' : 'idle';
}

/**
 * One goal's record from `setAt`: status today, adherence with n, streak, the day strip and
 * calendar, breaches with their estimated cost, and what history before `setAt` would have said.
 * `ctx` is `{ tzOffsetMin, now, equityAt }`; time paused is never scored.
 */
export function scoreGoal(goal, trips, ctx) {
  const def = typeOf(goal.type);
  const tz = ctx.tzOffsetMin || 0;
  const rows = evaluate(def, goal, trips || [], ctx);
  const scored = rows.filter(r => r.trip.openTime >= goal.setAt && !inPause(goal, r.trip.openTime));
  const before = rows.filter(r => r.trip.openTime < goal.setAt);
  const periods = periodsOf(def, scored);
  const todayStart = localDay(ctx.now, tz);
  const todayRows = scored.filter(r => r.day === todayStart);
  const scoredDay = day => day >= goal.setAt && !inPause(goal, day);
  const breaches = scored.filter(r => !r.kept).reverse();
  return {
    id: goal.id, type: goal.type, params: goal.params, session: goal.session, setAt: goal.setAt,
    label: describeGoal(goal), unit: def.unit, forwardOnly: !!def.forwardOnly,
    status: statusOf(def, goal, todayRows, periods),
    pausedAt: activePause(goal)?.from ?? null,
    waiting: !!def.forwardOnly && !rows.length,
    today: { trips: todayRows.length, broken: todayRows.filter(r => !r.kept).length,
             limit: def.unit === 'day' ? goal.params.max : null },
    streak: streakOf(periods),
    ...summary(def, scored),
    strip: dayCells(scored, todayStart, STRIP_DAYS, scoredDay),
    calendar: dayCells(scored, todayStart, CALENDAR_DAYS, scoredDay),
    breachCount: breaches.length,
    breaches: breaches.slice(0, BREACHES_LISTED).map(({ trip, what }) => ({
      symbol: trip.symbol, side: trip.side, openTime: trip.openTime, closeTime: trip.closeTime,
      net: round2(netOf(trip)), what })),
    before: before.length ? summary(def, before) : null
  };
}

/** What a goal would have scored on all of `trips`, with no set date: the add drawer's preview. */
export function previewGoal(goal, trips, ctx) {
  const def = typeOf(goal.type);
  const rows = evaluate(def, goal, trips || [], ctx);
  return { label: describeGoal(goal), ...summary(def, rows),
           strip: dayCells(rows, localDay(ctx.now, ctx.tzOffsetMin || 0), PREVIEW_DAYS) };
}

/**
 * Equity at a time, for loss caps: the account value snapshot within 15 minutes when one
 * exists, otherwise the wallet curve, marked `approx`.
 */
export function equityLookup(snapshots, walletPoints) {
  const snaps = [...(snapshots || [])].sort((a, b) => a.t - b.t);
  const wallet = [...(walletPoints || [])].sort((a, b) => a.t - b.t);
  return t => {
    const near = snaps.reduce((best, s) => (Math.abs(s.t - t) < Math.abs((best?.t ?? Infinity) - t) ? s : best), null);
    if (near && Math.abs(near.t - t) <= SNAPSHOT_MATCH_MS) return { value: near.accountValue, approx: false };
    const point = wallet.filter(p => p.t <= t).at(-1) ?? wallet[0];
    return point ? { value: point.wallet, approx: true } : null;
  };
}

function percentile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

const stepRound = (v, step) => +(Math.round(v / step) * step).toFixed(2);

function worstSession(trips) {
  const bySession = SESSIONS.map(s => ({ s, trips: trips.filter(t => t.session === s) }))
    .filter(x => x.trips.length >= THIN_TRIPS);
  const worst = bySession.sort((a, b) => average(a.trips) - average(b.trips))[0];
  return worst && average(worst.trips) < 0 ? worst.s : null;
}

function candidates(trips, ctx) {
  const tz = ctx.tzOffsetMin || 0;
  const lossPcts = trips.filter(lost).map(t => {
    const eq = ctx.equityAt?.(t.openTime);
    return eq?.value > 0 ? -netOf(t) / eq.value * 100 : null;
  }).filter(v => v != null);
  const medians = medianSizesBefore(trips);
  const multiples = trips.map(t => (medians.get(t) > 0 ? t.openNotional / medians.get(t) : null)).filter(v => v != null);
  const perDay = [...trips.reduce((m, t) => m.set(localDay(t.openTime, tz), (m.get(localDay(t.openTime, tz)) || 0) + 1), new Map()).values()];
  const lossPct = percentile(lossPcts, SUGGESTED_PERCENTILE);
  const multiple = percentile(multiples, SUGGESTED_PERCENTILE);
  const tradesPerDay = percentile(perDay, SUGGESTED_PERCENTILE);
  const session = worstSession(trips);
  return [
    { type: 'noUnderwaterAdds', params: {} },
    lossPct > 0 && { type: 'maxLossPct', params: { limit: Math.max(0.05, stepRound(lossPct, 0.05)), of: 'pct' } },
    multiple > 1 && { type: 'maxSize', params: { multiple: stepRound(multiple, 0.1) } },
    tradesPerDay >= 1 && { type: 'maxTradesPerDay', params: { max: Math.round(tradesPerDay) } },
    { type: 'lossStreakStop', params: { losses: 2 } },
    session && { type: 'noSessions', params: { sessions: [session] } }
  ].filter(Boolean);
}

/**
 * Up to three goals worth setting, costliest first: only those whose breaches lost money on
 * `trips`, thresholds from the reader's own distribution. Types in `exclude` are skipped.
 */
export function suggestGoals(trips, ctx, exclude = []) {
  return candidates(trips || [], ctx)
    .filter(c => !exclude.includes(c.type))
    .map(c => ({ ...validateGoal(c), preview: previewGoal(validateGoal(c), trips, ctx) }))
    .filter(s => s.preview.cost < 0)
    .sort((a, b) => a.preview.cost - b.preview.cost)
    .slice(0, SUGGESTIONS);
}
