import test from 'node:test';
import assert from 'node:assert/strict';
import { habitCosts } from './habits.js';

const HOUR = 3_600_000;
let clock = 0;
const trip = o => {
  clock += 10 * HOUR;
  return { openTime: clock, closeTime: clock + HOUR, holdHours: 1, openNotional: 100, addsWhileUnderwater: 0,
           net: 10, netAfterFunding: null, mfe: null, win: true, ...o };
};
const byId = (rows, id) => rows.find(r => r.id === id);

test('the cost of a habit is the gap in average net times its trips', () => {
  const trips = [trip({ addsWhileUnderwater: 2, net: -50 }), trip({ addsWhileUnderwater: 1, net: -10 }),
                 trip({ net: 20 }), trip({ net: 0 })];
  const r = byId(habitCosts(trips), 'underwaterAdds');
  assert.deepEqual([r.trips, r.comparisonTrips, r.avgNet, r.avgNetComparison, r.cost], [2, 2, -30, 10, -80]);
  assert.equal(r.thin, true);
});

test('bigger after a loss compares only trips opened right after a loss', () => {
  const trips = [trip({ net: -5 }), trip({ openNotional: 400, net: -40 }), trip({ net: 10 }),
                 trip({ net: -5 }), trip({ net: 3 }), trip({ openNotional: 500, net: 2 })];
  const r = byId(habitCosts(trips), 'biggerAfterLoss');
  assert.equal(r.trips, 1, 'the 400 after the first loss');
  assert.equal(r.comparisonTrips, 2, 'the normal-size trips after the 400 and after the second loss');
  assert.equal(r.cost, -40 - (10 + 3) / 2);
});

test('a winner turned loser needs its price path; trips without context sit out', () => {
  const trips = [trip({ net: -20, mfe: 2.5 }), trip({ net: -5, mfe: 0.3 }), trip({ net: -8, mfe: null }), trip({ net: 4, mfe: 5 })];
  const r = byId(habitCosts(trips), 'winnerToLoser');
  assert.deepEqual([r.trips, r.comparisonTrips, r.cost], [1, 1, -15]);
});

test('held losers longer measures against the median winner\'s hold, net after funding when known', () => {
  const trips = [trip({ net: 5, holdHours: 2 }), trip({ net: 5, holdHours: 4 }),
                 trip({ net: -1, netAfterFunding: -30, holdHours: 20 }), trip({ net: -10, holdHours: 1 })];
  const r = byId(habitCosts(trips), 'heldLosers');
  assert.deepEqual([r.trips, r.avgNet, r.avgNetComparison, r.cost], [1, -30, -10, -20]);
});
