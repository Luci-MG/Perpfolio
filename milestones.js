// milestones.js — goals with a target rather than a rule: account value reaching a level,
// optionally by a date, and a monthly drawdown limit. Read from equity snapshots with deposits
// and withdrawals removed, the wallet curve standing in before snapshots began. Pure;
// goals.js sends here every GOAL_TYPES entry whose unit is 'milestone'.

import { localMidnight } from './local-time.js';
import { periodStarts } from './trade-analytics.js';

const DAY_MS = 86_400_000;
const MIN_HISTORY_DAYS = 7;
const PACE_WINDOW_DAYS = 30;
const CHART_POINTS = 200;
const MONTHS_SHOWN = 12;

const localDay = (ts, tz) => periodStarts(ts, tz).today;
const localMonth = (ts, tz) => periodStarts(ts, tz).month;
const round2 = v => (v == null ? null : +v.toFixed(2));

/** End of the local day `by` (YYYY-MM-DD) on the reader's clock `tz` (local-time.js). */
export function deadlineOf(by, tz = 0) {
  const [y, m, d] = by.split('-').map(Number);
  return localMidnight(y, m - 1, d + 1, tz);
}

const transfersBetween = (transfers, from, to) =>
  (transfers || []).filter(x => x.t > from && x.t <= to).reduce((s, x) => s + x.amount, 0);

const snapshotSeries = ctx => [...(ctx.snapshots || [])].sort((a, b) => a.t - b.t).map(s => ({ t: s.t, value: s.accountValue }));

function valueSeries(ctx) {
  const snaps = snapshotSeries(ctx);
  const firstSnap = snaps[0]?.t ?? Infinity;
  const wallet = (ctx.wallet || []).filter(p => p.t < firstSnap).map(p => ({ t: p.t, value: p.wallet, approx: true }));
  return [...wallet.sort((a, b) => a.t - b.t), ...snaps];
}

const netOfTransfers = (points, transfers, from) =>
  points.map(p => ({ ...p, value: p.value - transfersBetween(transfers, from, p.t) }));

function dailyCloses(points, tz) {
  const byDay = new Map();
  for (const p of points) byDay.set(localDay(p.t, tz), p);
  return [...byDay.values()];
}

function fitLine(points) {
  if (points.length < 2) return null;
  const t0 = points[0].t;
  const xs = points.map(p => (p.t - t0) / DAY_MS), ys = points.map(p => p.value);
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length, my = ys.reduce((s, y) => s + y, 0) / ys.length;
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  if (!sxx) return null;
  const perDay = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / sxx;
  const at = t => my + perDay * ((t - t0) / DAY_MS - mx);
  return { perDay, at, reach: v => (perDay > 0 ? t0 + ((v - my) / perDay + mx) * DAY_MS : null) };
}

function thin(points) {
  if (points.length <= CHART_POINTS) return points;
  const step = Math.ceil(points.length / CHART_POINTS);
  return points.filter((_, i) => i % step === 0 || i === points.length - 1);
}

function targetStatus({ paused, reachedAt, deadline, now, fit, eta }) {
  if (paused) return 'paused';
  if (reachedAt != null) return deadline && reachedAt > deadline ? 'reachedLate' : 'reached';
  if (deadline && now > deadline) return 'missed';
  if (!fit) return 'early';
  if (!deadline) return 'open';
  return eta != null && eta <= deadline ? 'onpace' : 'late';
}

function projectionLine(fit, last, eta, deadline) {
  if (!fit) return null;
  const end = deadline ? Math.min(eta ?? deadline, deadline) : eta ?? last.t + PACE_WINDOW_DAYS * DAY_MS;
  return [{ t: last.t, value: round2(fit.at(last.t)) }, { t: end, value: round2(fit.at(end)) }];
}

function scoreAccountTarget(goal, ctx, paused) {
  const tz = ctx.tz ?? 0;
  const all = snapshotSeries(ctx);
  const start = all.filter(p => p.t <= goal.setAt).at(-1) ?? all.find(p => p.t > goal.setAt);
  if (!start) return { status: paused ? 'paused' : 'early', waiting: true, days: 0 };
  const series = netOfTransfers(all.filter(p => p.t >= start.t), ctx.transfers, start.t);
  const last = series.at(-1);
  const { target, by } = goal.params;
  const reachedPoint = series.find(p => p.value >= target);
  const deadline = by ? deadlineOf(by, tz) : null;
  const days = (last.t - start.t) / DAY_MS;
  const fit = days >= MIN_HISTORY_DAYS ? fitLine(dailyCloses(series, tz)) : null;
  const eta = fit?.reach(target) ?? null;
  return {
    status: targetStatus({ paused, reachedAt: reachedPoint?.t ?? null, deadline, now: ctx.now, fit, eta }),
    start: round2(start.value), current: round2(last.value), asOf: last.t, target,
    progress: target > start.value ? +((last.value - start.value) / (target - start.value)).toFixed(4) : 1,
    paceFraction: deadline ? +Math.min(1, Math.max(0, (ctx.now - goal.setAt) / (deadline - goal.setAt))).toFixed(4) : null,
    deadline, eta: reachedPoint ? null : eta, reachedAt: reachedPoint?.t ?? null, days: +days.toFixed(1),
    perDay: fit ? round2(fit.perDay) : null,
    chart: thin(series).map(p => ({ t: p.t, value: round2(p.value) })),
    projection: reachedPoint ? null : projectionLine(fit, last, eta, deadline)
  };
}

function worstFall(points) {
  let peak = -Infinity, worst = 0;
  for (const p of points) {
    peak = Math.max(peak, p.value);
    if (peak > 0) worst = Math.min(worst, (p.value - peak) / peak * 100);
  }
  return worst;
}

function monthlyDrawdowns(ctx) {
  const tz = ctx.tz ?? 0;
  const byMonth = new Map();
  for (const p of valueSeries(ctx)) {
    const month = localMonth(p.t, tz);
    byMonth.set(month, [...(byMonth.get(month) || []), p]);
  }
  return [...byMonth].map(([month, points]) => ({
    month, approx: points.some(p => p.approx),
    ddPct: +worstFall(netOfTransfers(points, ctx.transfers, points[0].t)).toFixed(2)
  }));
}

function streakOf(periods) {
  let n = 0;
  for (let i = periods.length - 1; i >= 0 && periods[i].kept; i--) n++;
  return n;
}

const adherenceOf = months => (months.length ? +(months.filter(m => m.kept).length / months.length).toFixed(4) : null);

function monthCells(months, now, tz, setMonth) {
  const cells = [];
  let month = localMonth(now, tz);
  for (let i = 0; i < MONTHS_SHOWN; i++) {
    const m = months.find(x => x.month === month);
    const state = month < setMonth ? 'unset' : !m ? 'none' : !m.kept ? 'broken' : m.current ? 'progress' : 'kept';
    cells.unshift({ day: month, state, ddPct: m?.ddPct ?? null, approx: m?.approx ?? false });
    month = localMonth(month - 1, tz);
  }
  return cells;
}

function scoreDrawdown(goal, ctx, paused, isPaused) {
  const tz = ctx.tz ?? 0;
  const current = localMonth(ctx.now, tz);
  const setMonth = localMonth(goal.setAt, tz);
  const months = monthlyDrawdowns(ctx).map(m => ({ ...m, kept: m.ddPct > -goal.params.maxPct, current: m.month === current }));
  const scored = months.filter(m => m.month >= setMonth && !isPaused(m.month));
  const now = scored.find(m => m.current);
  const periods = scored.filter(m => !m.current || !m.kept);
  const before = months.filter(m => m.month < setMonth);
  const status = paused ? 'paused' : now && !now.kept ? 'broken' : now ? 'progress' : periods.length ? 'kept' : 'idle';
  return {
    status, n: periods.length, adherence: adherenceOf(periods), streak: streakOf(periods),
    month: now ? { ddPct: now.ddPct, limit: goal.params.maxPct, approx: now.approx } : null,
    strip: monthCells(scored, ctx.now, tz, setMonth),
    before: before.length ? { n: before.length, adherence: adherenceOf(before), worst: Math.min(...before.map(m => m.ddPct)),
                              approx: before.some(m => m.approx) } : null
  };
}

/** A milestone's progress, pace and status; `isPaused(t)` says whether `t` fell in a pause. */
export function scoreMilestone(goal, ctx, isPaused) {
  const paused = isPaused(ctx.now);
  return goal.type === 'accountTarget' ? scoreAccountTarget(goal, ctx, paused) : scoreDrawdown(goal, ctx, paused, isPaused);
}

function recentPace(ctx) {
  const since = ctx.now - PACE_WINDOW_DAYS * DAY_MS;
  const snaps = snapshotSeries(ctx).filter(p => p.t >= since);
  const enoughSnaps = snaps.length > 1 && (snaps.at(-1).t - snaps[0].t) / DAY_MS >= MIN_HISTORY_DAYS;
  const points = enoughSnaps ? snaps : (ctx.wallet || []).filter(p => p.t >= since).map(p => ({ t: p.t, value: p.wallet }));
  const fit = fitLine(dailyCloses(netOfTransfers(points, ctx.transfers, points[0]?.t ?? since), ctx.tz ?? 0));
  return fit ? { perDay: round2(fit.perDay), approx: !enoughSnaps } : null;
}

/** What a milestone would ask for from today, against the recent pace or the months on record. */
export function previewMilestone(goal, ctx) {
  if (goal.type !== 'accountTarget') {
    const months = monthlyDrawdowns(ctx).map(m => ({ ...m, kept: m.ddPct > -goal.params.maxPct }));
    return { n: months.length, adherence: adherenceOf(months),
             worst: months.length ? Math.min(...months.map(m => m.ddPct)) : null, approx: months.some(m => m.approx) };
  }
  const snaps = snapshotSeries(ctx);
  const wallet = ctx.wallet || [];
  const current = snaps.at(-1)?.value ?? wallet.at(-1)?.wallet ?? null;
  const daysLeft = goal.params.by ? Math.max(0, (deadlineOf(goal.params.by, ctx.tz ?? 0) - ctx.now) / DAY_MS) : null;
  const needed = current == null ? null : goal.params.target - current;
  return {
    current: round2(current), currentApprox: !snaps.length, needed: round2(needed),
    neededPct: current > 0 ? +(needed / current * 100).toFixed(2) : null,
    daysLeft: daysLeft == null ? null : +daysLeft.toFixed(1),
    requiredPerDay: daysLeft > 0 && needed > 0 ? round2(needed / daysLeft) : null,
    pace: recentPace(ctx)
  };
}
