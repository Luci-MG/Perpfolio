import test from 'node:test';
import assert from 'node:assert/strict';
import { habitReport, hedgeUnits, medianSizesBefore, previousTrips, resultOf, sizing } from './habits.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 5, 1);
const trip = (openTime, o = {}) => ({
  symbol: 'SOLUSDT', side: 'Long', openTime, closeTime: openTime + HOUR, holdHours: 1, openNotional: 100, openQty: 1,
  enteredQty: 1, avgExit: 101, commission: 0, funding: 0, addsWhileUnderwater: 0, net: 1, netAfterFunding: 1, mfe: null, ...o
});
const byId = (rows, id) => rows.find(r => r.id === id);

test('a result within a cent is flat, neither a win nor a loss', () => {
  assert.deepEqual([0.02, 0.004, -0.004, -0.02].map(resultOf), ['win', 'flat', 'flat', 'loss']);
});

test('the trip before is the last one closed before this one opened, so an overlapping hedge leg is not it', () => {
  const a = trip(START), b = trip(START + 2 * HOUR, { closeTime: START + 6 * HOUR }), c = trip(START + 3 * HOUR);
  const previous = previousTrips([c, b, a]);
  assert.equal(previous.get(a), null);
  assert.equal(previous.get(b), a);
  assert.equal(previous.get(c), a, 'b was still open when c opened');
});

test('usual size is the median of earlier trips only, never of later ones', () => {
  const trips = Array.from({ length: 12 }, (_, i) => trip(START + i * DAY, { openNotional: i < 10 ? 100 : 10_000 }));
  const medians = medianSizesBefore(trips);
  assert.equal(medians.get(trips[9]), null);
  assert.equal(medians.get(trips[11]), 100);
});

test('overlapping same-symbol legs chain into one unit; other symbols and later trips stay apart', () => {
  const units = hedgeUnits([trip(START, { closeTime: START + 3 * HOUR, net: 5, netAfterFunding: 5 }),
                            trip(START + HOUR, { side: 'Short', closeTime: START + 5 * HOUR, net: -2, netAfterFunding: -2 }),
                            trip(START + 4 * HOUR, { side: 'Long', net: -1, netAfterFunding: -1 }),
                            trip(START + HOUR, { symbol: 'BTCUSDT' }),
                            trip(START + DAY)]);
  assert.deepEqual(units.map(u => [u.symbol, u.legs, u.net]), [['BTCUSDT', 1, 1], ['SOLUSDT', 3, 2], ['SOLUSDT', 1, 1]]);
});

test('adding to a loser is costed by replaying the trip without the adds, with fees and funding scaled', () => {
  const added = Array.from({ length: 12 }, (_, i) => trip(START + i * DAY, {
    addsWhileUnderwater: 1, openQty: 1, enteredQty: 2, avgExit: 90, commission: 0.4, funding: -0.2, net: -10.4, netAfterFunding: -10.6 }));
  const h = byId(habitReport([...added, trip(START + 20 * DAY)], { now: START + 21 * DAY }), 'underwaterAdds');
  assert.deepEqual([h.trips, h.outOf, h.costed, h.cost], [12, 13, 12, -3.6], 'each add cost $0.30 of extra fees and funding');
  assert.deepEqual(h.ci, { lo: -3.6, hi: -3.6 });
  assert.equal(h.verdict, 'costs');
  assert.deepEqual(h.goal, { type: 'noUnderwaterAdds', params: {} });
});

test('a quick re-entry after a loss is compared with a quick re-entry after a win, not with every trip', () => {
  const trips = [];
  for (let d = 0; d < 12; d++) {
    const day = START + d * 2 * DAY;
    trips.push(trip(day, { net: -5, netAfterFunding: -5 }), trip(day + HOUR + 10 * MIN, { net: -8 + d % 3, netAfterFunding: -8 + d % 3 }));
    trips.push(trip(day + DAY, { net: 5, netAfterFunding: 5 }), trip(day + DAY + HOUR + 10 * MIN, { net: 4 + d % 3, netAfterFunding: 4 + d % 3 }));
  }
  const h = byId(habitReport(trips, { now: START + 30 * DAY }), 'quickReentry');
  assert.deepEqual([h.trips, h.comparisonTrips], [12, 12]);
  assert.equal(h.cost, -144, '$12 worse a trip over 12 trips');
  assert.ok(h.ci.hi < 0);
  assert.equal(h.verdict, 'costs');
});

test('opening bigger after a loss is replayed at the usual size judged on earlier trips', () => {
  const base = Array.from({ length: 10 }, (_, i) => trip(START + i * DAY));
  const loss = trip(START + 10 * DAY, { net: -1, netAfterFunding: -1 });
  const big = trip(START + 10 * DAY + 2 * HOUR, { openNotional: 400, net: -8, netAfterFunding: -8 });
  const h = byId(habitReport([...base, loss, big], { now: START + 11 * DAY }), 'biggerAfterLoss');
  assert.deepEqual([h.trips, h.cost, h.verdict], [1, -6, 'thin'], 'at a quarter of the size it would have lost $2');
});

test('busy days are the top third by trips a day, compared with the quietest third', () => {
  const trips = [];
  for (let d = 0; d < 30; d++) {
    const busy = d % 3 === 0;
    for (let i = 0; i < (busy ? 4 : d % 3 === 1 ? 2 : 1); i++) {
      trips.push(trip(START + d * DAY + i * 2 * HOUR, { net: busy ? -3 : 2, netAfterFunding: busy ? -3 : 2 }));
    }
  }
  const h = byId(habitReport(trips, { now: START + 31 * DAY }), 'busyDays');
  assert.deepEqual([h.trips, h.comparisonTrips], [40, 10]);
  assert.equal(h.verdict, 'costs');
  assert.deepEqual(h.goal, { type: 'maxTradesPerDay', params: { max: 3 } }, 'busy days start above 2.67 a day');
});

test('habits picked by their own result are counted, never costed, and say how many await context', () => {
  const trips = [trip(START, { net: -5, netAfterFunding: -5, mfe: 2, holdHours: 9 }), trip(START + DAY, { net: -5, netAfterFunding: -5, mfe: 0.2, holdHours: 6 }),
                 trip(START + 2 * DAY, { net: -5, netAfterFunding: -5 }), trip(START + 3 * DAY, { holdHours: 2 })];
  const report = habitReport(trips, { now: START + 4 * DAY });
  const turned = byId(report, 'winnerToLoser'), held = byId(report, 'heldLosers');
  assert.deepEqual([turned.kind, turned.trips, turned.outOf, turned.pending, turned.cost, turned.verdict], ['count', 1, 2, 1, null, null]);
  assert.deepEqual([held.kind, held.ratio, held.cost], ['ratio', 3, null], 'losers held a median 6h against 2h');
});

test('a habit reports the window before and an eight-week trend of its share, with the session kept', () => {
  const trips = Array.from({ length: 56 }, (_, d) => trip(START + d * DAY, { addsWhileUnderwater: d >= 28 ? 1 : 0, session: d % 2 ? 'Asia' : 'Europe' }));
  const now = START + 56 * DAY;
  const h = byId(habitReport(trips, { inScope: t => t.openTime >= now - 28 * DAY, inPrevious: t => t.openTime < now - 28 * DAY,
                                      inSession: t => t.session === 'Asia', now }), 'underwaterAdds');
  assert.deepEqual([h.share, h.previous.share], [1, 0]);
  assert.equal(h.weekly.length, 8);
  assert.deepEqual(h.weekly.map(w => w.share), [0, 0, 0, 0, 1, 1, 1, 1]);
  assert.ok(h.weekly.every(w => w.n === 3 || w.n === 4), 'one session only');
});

test('sizing gives the spread at open and the median after a loss against after a win', () => {
  const trips = [trip(START, { net: -1, netAfterFunding: -1 }), trip(START + DAY, { openNotional: 300 }), trip(START + 2 * DAY, { openNotional: 50 })];
  const s = sizing(trips);
  assert.deepEqual([s.trips, s.median, s.max], [3, 100, 300]);
  assert.deepEqual([s.afterLoss, s.afterWin], [{ median: 300, trips: 1 }, { median: 50, trips: 1 }]);
  assert.equal(sizing([]), null);
});
