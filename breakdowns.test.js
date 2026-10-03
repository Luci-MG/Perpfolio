import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_UNITS, byHour, byWeekday, bySymbol, calendarOf, openingGrid } from './breakdowns.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MON = Date.UTC(2026, 5, 1);
const trip = (openTime, o = {}) => ({ symbol: 'SOLUSDT', side: 'Long', openTime, closeTime: openTime + HOUR, holdHours: 1,
  net: 1, netAfterFunding: 1, commission: 0.1, funding: -0.2, tradedNotional: 1000, ...o });

test('weekday counts units by the local day they opened; a total shows at any size, an average only from the minimum', () => {
  const trips = [...Array.from({ length: 10 }, (_, i) => trip(MON + i * 7 * DAY + 10 * HOUR, { net: 3, netAfterFunding: 3 })),
                 trip(MON + DAY + 23.5 * HOUR)];
  const w = byWeekday(trips, 60);
  const monday = w.rows[0], thursday = w.rows[3];
  assert.equal(w.rows[1].units, 0, 'Tuesday 23:30 UTC is Wednesday at UTC+1');
  assert.deepEqual([w.rows[2].units, w.rows[2].total, w.rows[2].needs], [1, 1, MIN_UNITS - 1]);
  assert.deepEqual([monday.units, monday.total, monday.needs], [10, 30, 0]);
  assert.ok(monday.ci.lo <= monday.shrunk && monday.shrunk <= monday.ci.hi);
  assert.equal(thursday.units, 0);
});

test('a hedged pair is one unit in every bucket, and the hour follows the clock it was opened on', () => {
  const pair = [trip(MON + 9 * HOUR, { closeTime: MON + 12 * HOUR }), trip(MON + 10 * HOUR, { side: 'Short' })];
  assert.equal(byHour(pair).rows[9].units, 1);
  assert.equal(byHour(pair, 120).rows[11].units, 1);
  assert.equal(openingGrid(pair).counts[0][9], 1);
  assert.equal(openingGrid(pair).max, 1);
});

test('the calendar puts days in Monday-first weeks with trades closed, week and month totals, and no trading as null', () => {
  const cal = calendarOf([{ date: '2026-06-03', pnl: 5 }, { date: '2026-06-09', pnl: -2 }, { date: '2026-07-01', pnl: 0 }],
                         [trip(Date.UTC(2026, 5, 3, 8)), trip(Date.UTC(2026, 5, 3, 9))]);
  assert.equal(cal.weeks[0].start, '2026-06-01');
  assert.deepEqual(cal.weeks[0].days[2], { date: '2026-06-03', pnl: 5, trips: 2 });
  assert.equal(cal.weeks[0].days[3].pnl, null);
  assert.deepEqual(cal.weeks.map(w => w.total).slice(0, 2), [5, -2]);
  assert.deepEqual(cal.months, [{ month: '2026-06', total: 3 }, { month: '2026-07', total: 0 }]);
  assert.equal(cal.weeks.at(-1).days[2].pnl, 0, 'a flat day is zero, not missing');
  assert.deepEqual(calendarOf([], []).weeks, []);
});

test('symbols sort by total net, show the best and worst five with the rest folded, and say how concentrated the book is', () => {
  const trips = Array.from({ length: 14 }, (_, i) => trip(MON + i * DAY, { symbol: `S${i}USDT`, net: i - 6, netAfterFunding: i - 6,
                                                                              tradedNotional: i === 0 ? 10_000 : 1000 }));
  const s = bySymbol(trips);
  assert.deepEqual(s.rows.slice(0, 2).map(r => r.symbol), ['S13USDT', 'S12USDT']);
  assert.equal(s.shown.length, 10);
  assert.deepEqual([s.rest.symbols, s.rest.units, s.rest.net], [4, 4, 2 + 1 + 0 - 1]);
  assert.deepEqual(s.concentration.top, ['S13USDT', 'S12USDT', 'S0USDT']);
  assert.ok(s.concentration.effectiveSymbols > 1 && s.concentration.effectiveSymbols < 14, 'one symbol carries ten times the notional');
  assert.equal(s.rows[0].costBp, 1);
  assert.equal(s.rows[0].fundingPerHour, -0.2);
  assert.ok(s.rows.every(r => r.needs === MIN_UNITS - 1));
});
