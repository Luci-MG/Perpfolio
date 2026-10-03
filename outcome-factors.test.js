import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_TRIPS, benjaminiHochberg, clusterBootstrap, outcomeFactors, welch, wilson } from './outcome-factors.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MON = Date.UTC(2026, 5, 1);
const near = (actual, expected, tol, what) => assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} vs ${expected}`);

const trip = (openTime, o = {}) => ({
  symbol: 'SOLUSDT', side: 'Long', openTime, closeTime: openTime + HOUR, holdHours: 1, openNotional: 100,
  addsWhileUnderwater: 0, net: 5, netAfterFunding: null, session: 'Europe', hedged: false, btcTrend: 'up',
  atrPct: 1, entry: null, ...o
});

function book(days, perDay, make) {
  const trips = [];
  for (let d = 0; d < days; d++) for (let i = 0; i < perDay; i++) trips.push(trip(MON + d * DAY + (8 + i * 3) * HOUR, make(d, i)));
  return trips;
}

const weekendLoses = (d, i) => (d % 7 >= 5 ? { session: 'Weekend', net: -20 + i } : { net: 6 + (d % 3) - i });
const row = (r, factor, bucket) => r.factors.find(f => f.id === factor)?.buckets.find(b => b.bucket === bucket);

test('Wilson and Welch match their published forms', () => {
  const none = wilson(0, 10);
  near(none.lo, 0, 1e-12, 'Wilson lower at 0/10');
  near(none.hi, 0.2129, 1e-4, 'Wilson upper at 0/10');
  const half = wilson(5, 10);
  near(half.lo, 0.2693, 1e-4, 'Wilson lower at 5/10');
  near(half.hi, 0.7307, 1e-4, 'Wilson upper at 5/10');
  const w = welch([1, 2, 3, 4], [2, 4, 6, 8]);
  near(w.lo, -5.5, 0.1, 'Welch lower, df ≈ 4.4');
  near(w.hi, 0.5, 0.1, 'Welch upper');
  near(w.p, 0.15, 0.03, 'Welch p');
  assert.equal(welch([1], [2, 3]), null);
});

test('Benjamini–Hochberg passes the step-up set', () => {
  assert.deepEqual(benjaminiHochberg([0.01, 0.04, 0.03, 0.2], 0.1), [true, true, true, false]);
  assert.deepEqual(benjaminiHochberg([0.2, 0.3], 0.1), [false, false]);
});

test('the bootstrap is seeded, and copies of a trip within one day do not narrow it', () => {
  const trips = book(30, 1, d => ({ net: d % 2 ? 10 : -8, session: d % 3 ? 'Europe' : 'US' }));
  const inUs = t => t.session === 'US';
  const days = trips.map(t => [t]);
  const once = clusterBootstrap(days, inUs);
  assert.deepEqual(clusterBootstrap(days, inUs), once);
  const copied = clusterBootstrap(trips.map(t => [t, { ...t }, { ...t }, { ...t }]), t => t.session === 'US');
  assert.ok(copied.hi - copied.lo > 0.8 * (once.hi - once.lo), 'four copies a day still count as one draw');
});

test('a losing weekend stands out, with its interval, win rate, stability and a goal to set', () => {
  const r = outcomeFactors(book(70, 3, weekendLoses));
  const weekend = row(r, 'weekend', 'Weekend');
  assert.equal(weekend.n, 60);
  assert.equal(weekend.days, 20);
  assert.ok(weekend.ci.hi < 0 && weekend.standsOut);
  assert.equal(weekend.stability, 'holds');
  assert.equal(weekend.winRate, 0);
  assert.deepEqual(weekend.goal, { type: 'noSessions', params: { sessions: ['Weekend'] } });
  assert.equal(r.worse[0].bucket, 'Weekend');
  assert.ok(r.comparisons >= 4);
  assert.deepEqual(r.waiting, ['Confluence at entry', 'Leverage at entry', 'Margin used at entry', 'Stop within 5 minutes']);
});

test('a bucket under the minimum is hidden and counted, and so is a bucket with too little to compare against', () => {
  const r = outcomeFactors(book(70, 3, (d, i) => (d === 3 ? { side: 'Short' } : weekendLoses(d, i))));
  const side = r.factors.find(f => f.id === 'side');
  assert.deepEqual([side.buckets.length, side.hiddenBuckets], [0, 2], `3 shorts is under ${MIN_TRIPS}, so longs have nothing to be compared with`);
});

test('a session filter drops the factors it makes meaningless', () => {
  const ids = outcomeFactors(book(30, 2, weekendLoses), { session: 'Europe' }).factors.map(f => f.id);
  assert.ok(!ids.includes('session') && !ids.includes('weekend'));
  assert.ok(ids.includes('side'));
});

test('no look-ahead: size compares with earlier trips, the previous trip closed before this one opened', () => {
  const trips = book(40, 2, (d, i) => ({ openNotional: d < 20 ? 100 : 400, net: i ? -3 : 4 }));
  const r = outcomeFactors(trips);
  const big = row(r, 'size', 'Over 1.5× median');
  assert.ok(big && big.n >= 20, 'later trips are big against the median before them');
  assert.ok(row(r, 'previous', 'First of the day').n === 40);
  assert.ok(row(r, 'previous', 'After a win').n === 40);
});

test('a factor that flips sign once hedging is held equal is marked', () => {
  const kinds = [...Array(50).fill(['SOLUSDT', true, -5]), ...Array(10).fill(['BTCUSDT', true, -10]),
                 ...Array(10).fill(['SOLUSDT', false, 12]), ...Array(50).fill(['BTCUSDT', false, 8])];
  const trips = kinds.map(([symbol, hedged, net], i) => trip(MON + Math.floor(i / 2) * DAY + (i % 2) * 4 * HOUR,
    { symbol, hedged, net: net + (i % 3) * 0.1 }));
  const alts = row(outcomeFactors(trips), 'group', 'Alts');
  assert.ok(alts.diff < 0, 'alts look worse overall');
  assert.equal(alts.signFlip, true, 'but do better within hedged and within unhedged trips');
});

test('during-trade behaviour is reported apart and never in the verdict', () => {
  const r = outcomeFactors(book(70, 3, (d, i) => (i === 2 ? { addsWhileUnderwater: 1, net: -30 } : { net: 5 })));
  assert.ok(r.during.find(f => f.id === 'adds').buckets.some(b => b.bucket === 'Added underwater'));
  assert.ok(!r.worse.some(v => v.factor === 'adds'));
});

test('factors read from entry context join once entries are captured', () => {
  const r = outcomeFactors(book(70, 3, (d, i) => ({ ...weekendLoses(d, i),
    entry: { account: { leverage: 5 + (d % 3) * 5, marginPct: 20 + i }, confluence: { score: i ? 0.5 : -0.5 }, stopLooked: true, yourStop: i ? { price: 1 } : null } })));
  assert.deepEqual(r.waiting, []);
  assert.ok(row(r, 'confluence', 'Agrees') && row(r, 'confluence', 'Against'));
  assert.ok(row(r, 'stop', 'No stop'));
  assert.ok(r.factors.find(f => f.id === 'leverage').buckets.length >= 2);
});

test('your tags are compared apart, hidden under the minimum, and never reach the verdict', () => {
  const r = outcomeFactors(book(70, 3, (d, i) => ({ ...weekendLoses(d, i), tags: i === 0 ? ['revenge'] : d === 1 ? ['rare'] : [] })));
  const revenge = r.tags.buckets.find(b => b.bucket === 'revenge');
  assert.equal(revenge.n, 70);
  assert.equal(revenge.standsOut, false);
  assert.equal(r.tags.hiddenBuckets, 1, 'the rare tag is under the minimum');
  assert.ok(![...r.worse, ...r.better].some(v => v.bucket === 'revenge'));
});
