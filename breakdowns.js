// breakdowns.js — when and on what the book does well: weekday and hour by the local time a
// position opened, per symbol, and the calendar of days. Totals are facts and shown at any size;
// averages are estimates, shrunk toward the book's average with an interval, and only from
// MIN_UNITS. Counted in hedge units. Method and sources: docs/research/timing-symbols-costs.md. Pure.

import { hedgeUnits, netOf, resultOf } from './habits.js';
import { localDate, wallTime } from './local-time.js';
import { shrunkMeans } from './stats.js';

export const MIN_UNITS = 8;
const SYMBOLS_EACH_END = 5;
const CONCENTRATION_TOP = 3;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const round2 = v => (v == null ? null : +v.toFixed(2));
const round4 = v => (v == null ? null : +v.toFixed(4));
const sumOf = xs => xs.reduce((s, x) => s + x, 0);
const mondayFirst = date => (date.getUTCDay() + 6) % 7;

function shrunkRows(labels, units, bucketOf) {
  const groups = labels.map((_, i) => ({ key: i, values: [] }));
  for (const u of units) groups[bucketOf(u)].values.push(u.net);
  const r = shrunkMeans(groups, { min: MIN_UNITS });
  return {
    overall: round2(r.overall), min: MIN_UNITS,
    chance: r.chance,
    rows: r.groups.map(g => ({ label: labels[g.key], units: g.n, total: round2(g.total), needs: g.needs,
                               mean: round2(g.mean), shrunk: round2(g.shrunk), ci: g.ci && { lo: round2(g.ci.lo), hi: round2(g.ci.hi) } }))
  };
}

/** Units by the local weekday they opened: total, and from MIN_UNITS a shrunk average per unit with its interval. */
export function byWeekday(trips, tz = 0) {
  return shrunkRows(WEEKDAYS, hedgeUnits(trips), u => mondayFirst(wallTime(u.openTime, tz)));
}

/** Units by the local hour they opened, as byWeekday. */
export function byHour(trips, tz = 0) {
  const labels = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);
  return shrunkRows(labels, hedgeUnits(trips), u => wallTime(u.openTime, tz).getUTCHours());
}

/** Units opened in each local weekday (Monday first) × hour cell: when you trade, not how it went. */
export function openingGrid(trips, tz = 0) {
  const grid = WEEKDAYS.map(() => new Array(24).fill(0));
  for (const u of hedgeUnits(trips)) {
    const w = wallTime(u.openTime, tz);
    grid[mondayFirst(w)][w.getUTCHours()]++;
  }
  return { weekdays: WEEKDAYS, counts: grid, max: Math.max(0, ...grid.flat()) };
}

/**
 * `{ date, pnl }` days in Monday-first weeks, each cell with the trips closed that local day,
 * plus each week's and month's total. A day without trading is null, never zero.
 */
export function calendarOf(days, trips, tz = 0) {
  const traded = days.filter(d => d.pnl != null);
  if (!traded.length) return { weeks: [], months: [], maxAbs: 0 };
  const closed = new Map();
  for (const t of trips) closed.set(localDate(t.closeTime, tz), (closed.get(localDate(t.closeTime, tz)) || 0) + 1);
  const pnl = new Map(traded.map(d => [d.date, d.pnl]));
  const first = new Date(`${traded[0].date}T00:00:00Z`), last = new Date(`${traded.at(-1).date}T00:00:00Z`);
  const cursor = new Date(first);
  cursor.setUTCDate(first.getUTCDate() - mondayFirst(first));
  const weeks = [];
  while (cursor <= last) {
    const cells = Array.from({ length: 7 }, () => {
      const date = cursor.toISOString().slice(0, 10);
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      return { date, pnl: pnl.has(date) ? pnl.get(date) : null, trips: closed.get(date) || 0 };
    });
    weeks.push({ start: cells[0].date, total: round2(sumOf(cells.map(c => c.pnl ?? 0))), days: cells });
  }
  const months = new Map();
  for (const d of traded) months.set(d.date.slice(0, 7), (months.get(d.date.slice(0, 7)) || 0) + d.pnl);
  return { weeks, months: [...months].map(([month, total]) => ({ month, total: round2(total) })),
           maxAbs: round2(Math.max(...traded.map(d => Math.abs(d.pnl)))) };
}

function symbolRow(symbol, legs) {
  const units = hedgeUnits(legs);
  const wins = units.filter(u => resultOf(u.net) === 'win').length;
  const traded = sumOf(legs.map(t => t.tradedNotional || 0));
  const funded = legs.filter(t => t.funding != null);
  const hours = sumOf(funded.map(t => t.holdHours));
  return {
    symbol, units: units.length, legs: legs.length, net: round2(sumOf(legs.map(netOf))),
    winRate: units.length ? round4(wins / units.length) : null,
    fees: round2(sumOf(legs.map(t => t.commission))), traded: round2(traded),
    costBp: traded ? round2(sumOf(legs.map(t => t.commission)) / traded * 1e4) : null,
    fundingPerHour: hours ? round4(sumOf(funded.map(t => t.funding)) / hours) : null,
    values: units.map(u => u.net)
  };
}

function concentrationOf(rows) {
  const gross = sumOf(rows.map(r => Math.abs(r.net)));
  const top = [...rows].sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, CONCENTRATION_TOP);
  const traded = sumOf(rows.map(r => r.traded));
  const hhi = traded ? sumOf(rows.map(r => (r.traded / traded) ** 2)) : null;
  return { top: top.map(r => r.symbol), topShare: gross ? round4(sumOf(top.map(r => Math.abs(r.net))) / gross) : null,
           effectiveSymbols: hhi ? round2(1 / hhi) : null, symbols: rows.length };
}

/**
 * Per symbol, best first by total net: units, net, win rate, a shrunk average per unit from
 * MIN_UNITS, cost in basis points of notional traded and funding per hour held. `shown` names
 * the best and worst few; `rest` totals the others. `concentration` gives the top symbols'
 * share of gross |net| and the effective number of symbols traded (1/HHI of notional).
 */
export function bySymbol(trips) {
  const groups = new Map();
  for (const t of trips) groups.set(t.symbol, [...(groups.get(t.symbol) || []), t]);
  const raw = [...groups].map(([symbol, legs]) => symbolRow(symbol, legs)).sort((a, b) => b.net - a.net);
  const shrunk = shrunkMeans(raw.map(r => ({ key: r.symbol, values: r.values })), { min: MIN_UNITS });
  const rows = raw.map(({ values, ...r }, i) => {
    const g = shrunk.groups[i];
    return { ...r, needs: g.needs, shrunk: round2(g.shrunk), ci: g.ci && { lo: round2(g.ci.lo), hi: round2(g.ci.hi) } };
  });
  const ends = rows.length > 2 * SYMBOLS_EACH_END ? [...rows.slice(0, SYMBOLS_EACH_END), ...rows.slice(-SYMBOLS_EACH_END)] : rows;
  const rest = rows.filter(r => !ends.includes(r));
  return { rows, shown: ends.map(r => r.symbol), chance: shrunk.chance, min: MIN_UNITS, overall: round2(shrunk.overall),
           rest: { symbols: rest.length, units: sumOf(rest.map(r => r.units)), net: round2(sumOf(rest.map(r => r.net))) },
           concentration: concentrationOf(rows) };
}
