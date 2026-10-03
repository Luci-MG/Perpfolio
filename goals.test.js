import test from 'node:test';
import assert from 'node:assert/strict';
import { GOAL_TYPES, equityLookup, previewGoal, scoreGoal, suggestGoals, validateGoal } from './goals.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 8, 1);
const NOW = T0 + 20 * DAY + 12 * HOUR;
const ctx = { tzOffsetMin: 0, now: NOW, equityAt: () => ({ value: 1000, approx: false }) };

const trip = (openTime, o = {}) => ({
  symbol: 'BTCUSDT', side: 'Long', openTime, closeTime: openTime + HOUR, openNotional: 100,
  addsWhileUnderwater: 0, net: 5, netAfterFunding: null, session: 'Europe', entry: null, ...o
});
const goal = (type, params = {}, o = {}) => ({ id: 'g', ...validateGoal({ type, params }), setAt: T0, pauses: [], ...o });
const score = (g, trips, c = ctx) => scoreGoal(g, trips, c);

test('every goal type judges hand-built trips', () => {
  const at = h => T0 + 10 * DAY + h * HOUR;
  const entry = (leverage, yourStop) => ({ account: { leverage }, yourStop, stopLooked: true });
  const cases = [
    ['maxLeverage', { max: 10 }, [trip(at(1), { entry: entry(5) }), trip(at(2), { entry: entry(20) }), trip(at(3))], [1, 1]],
    ['stopWithin5m', {}, [trip(at(1), { entry: entry(5, { price: 1 }) }), trip(at(2), { entry: entry(5, null) }),
                          trip(at(3), { entry: entry(5, null), closeTime: at(3) + 60_000 })], [1, 1]],
    ['maxLossPct', { limit: 1 }, [trip(at(1), { net: -9 }), trip(at(2), { net: -11 })], [1, 1]],
    ['maxLossPct', { limit: 10, of: 'usd' }, [trip(at(1), { net: -9, netAfterFunding: -12 }), trip(at(2), { net: -9 })], [1, 1]],
    ['noUnderwaterAdds', {}, [trip(at(1), { addsWhileUnderwater: 2 }), trip(at(2))], [1, 1]],
    ['maxTradesPerDay', { max: 2 }, [trip(at(1)), trip(at(2)), trip(at(3)), trip(at(4))], [2, 2]],
    ['lossStreakStop', { losses: 2 }, [trip(at(0), { net: -1 }), trip(at(2), { net: -1 }), trip(at(4)), trip(at(6))], [3, 1]],
    ['noSessions', { sessions: ['Weekend'] }, [trip(at(1)), trip(at(2), { session: 'Weekend' })], [1, 1]]
  ];
  for (const [type, params, trips, [keptTrips, brokenTrips]] of cases) {
    const r = score(goal(type, params), trips);
    assert.deepEqual([r.keptTrips, r.brokenTrips], [keptTrips, brokenTrips], `${type} ${JSON.stringify(params)}`);
  }
});

test('max size compares with the median of earlier trips, and waits for enough of them', () => {
  const trips = Array.from({ length: 12 }, (_, i) => trip(T0 + i * DAY, { openNotional: i === 11 ? 500 : 100 }));
  const r = score(goal('maxSize', { multiple: 2 }), trips);
  assert.deepEqual([r.n, r.brokenTrips], [2, 1]);
  assert.equal(r.breaches[0].what, '5.0× median size');
});

test('a trade cap counts days, kept or broken, and only the trips past the cap cost', () => {
  const day = d => T0 + d * DAY;
  const trips = [trip(day(1) + HOUR, { net: 10 }), trip(day(1) + 2 * HOUR, { net: -30 }), trip(day(2) + HOUR, { net: 10 })];
  const r = score(goal('maxTradesPerDay', { max: 1 }), trips);
  assert.deepEqual([r.n, r.adherence, r.brokenTrips, r.keptTrips, r.cost], [2, 0.5, 1, 2, -40]);
});

test('days start at the reader\'s local midnight', () => {
  const trips = [trip(T0 + 5 * DAY + 22 * HOUR), trip(T0 + 5 * DAY + 23 * HOUR)];
  const g = goal('maxTradesPerDay', { max: 1 });
  assert.equal(score(g, trips).brokenTrips, 1, 'same UTC day');
  assert.equal(score(g, trips, { ...ctx, tzOffsetMin: 90 }).brokenTrips, 0, 'midnight falls between them at UTC+1:30');
});

test('a session scope scores only that session', () => {
  const g = { ...goal('noUnderwaterAdds'), session: 'Weekend' };
  const r = score(g, [trip(T0 + DAY, { addsWhileUnderwater: 1 }), trip(T0 + 2 * DAY, { session: 'Weekend' })]);
  assert.deepEqual([r.n, r.brokenTrips], [1, 0]);
  assert.match(r.label, /· Weekend$/);
});

test('scoring starts at setAt; earlier history is reported apart and never counts', () => {
  const setAt = T0 + 10 * DAY;
  const trips = [trip(T0 + DAY, { addsWhileUnderwater: 1 }), trip(setAt + DAY)];
  const r = score(goal('noUnderwaterAdds', {}, { setAt }), trips);
  assert.deepEqual([r.n, r.brokenTrips, r.status], [1, 0, 'kept']);
  assert.deepEqual([r.before.n, r.before.brokenTrips], [1, 1]);
  assert.equal(r.calendar.find(c => c.day === T0 + DAY).state, 'unset');
});

test('editing re-scores from the same set date; pausing freezes the record', () => {
  const trips = [trip(T0 + DAY, { net: -50 }), trip(NOW - HOUR, { net: -50 })];
  assert.equal(score(goal('maxLossPct', { limit: 1 }), trips).brokenTrips, 2);
  assert.equal(score(goal('maxLossPct', { limit: 10 }), trips).brokenTrips, 0);
  const paused = score(goal('maxLossPct', { limit: 1 }, { pauses: [{ from: T0 + 2 * DAY, to: null }] }), trips);
  assert.deepEqual([paused.status, paused.n, paused.pausedAt], ['paused', 1, T0 + 2 * DAY]);
  const resumed = score(goal('maxLossPct', { limit: 1 }, { pauses: [{ from: T0 + 2 * DAY, to: NOW - 2 * HOUR }] }), trips);
  assert.deepEqual([resumed.status, resumed.n], ['broken', 2]);
});

test('status reads today: broken, in progress under a cap, kept, or waiting for a first trip', () => {
  const today = NOW - 2 * HOUR;
  assert.equal(score(goal('noUnderwaterAdds'), [trip(today, { addsWhileUnderwater: 1 })]).status, 'broken');
  const cap = score(goal('maxTradesPerDay', { max: 6 }), [trip(today), trip(today + 1)]);
  assert.deepEqual([cap.status, cap.today.trips, cap.today.limit], ['progress', 2, 6]);
  assert.equal(score(goal('noUnderwaterAdds'), [trip(T0 + DAY)]).status, 'kept');
  const lev = score(goal('maxLeverage', { max: 5 }), [trip(T0 + DAY)]);
  assert.deepEqual([lev.status, lev.waiting], ['idle', true]);
});

test('streak counts the latest kept periods; strip and calendar end today', () => {
  const trips = [trip(T0 + DAY, { addsWhileUnderwater: 1 }), trip(T0 + 2 * DAY), trip(NOW - HOUR)];
  const r = score(goal('noUnderwaterAdds'), trips);
  assert.equal(r.streak, 2);
  assert.equal(r.strip.length, 7);
  assert.equal(r.calendar.length, 56);
  assert.deepEqual(r.strip.at(-1), { day: T0 + 20 * DAY, state: 'kept' });
});

test('cost is broken against kept, signed, and thin under ten on either side', () => {
  const r = score(goal('noUnderwaterAdds'), [trip(T0 + DAY, { addsWhileUnderwater: 1, net: -20 }), trip(T0 + 2 * DAY, { net: 10 })]);
  assert.deepEqual([r.cost, r.avgBroken, r.avgKept, r.thin], [-30, -20, 10, true]);
});

test('a loss cap uses equity at entry, from a snapshot or else the wallet curve', () => {
  const equityAt = equityLookup([{ t: T0 + DAY, accountValue: 2000 }], [{ t: T0, wallet: 500 }]);
  assert.deepEqual(equityAt(T0 + DAY + 10 * 60_000), { value: 2000, approx: false });
  assert.deepEqual(equityAt(T0 + 5 * DAY), { value: 500, approx: true });
  const r = score(goal('maxLossPct', { limit: 1 }), [trip(T0 + 5 * DAY, { net: -10 })], { ...ctx, equityAt });
  assert.equal(r.breaches[0].what, 'lost 2.00% of equity (≈ wallet)');
});

test('validation takes defaults, rejects out-of-range and unknown input', () => {
  assert.deepEqual(validateGoal({ type: 'maxTradesPerDay' }).params, { max: 6 });
  assert.throws(() => validateGoal({ type: 'maxTradesPerDay', params: { max: 2.5 } }), /whole number/);
  assert.throws(() => validateGoal({ type: 'maxLeverage', params: { max: 0 } }), /1–125/);
  assert.throws(() => validateGoal({ type: 'noSessions', params: { sessions: ['Mars'] } }), /pick from/);
  assert.throws(() => validateGoal({ type: 'noSessions', session: 'Weekend' }), /scope/);
  assert.throws(() => validateGoal({ type: 'nope' }), /unknown/);
  for (const def of GOAL_TYPES) assert.ok(validateGoal({ type: def.id }), def.id);
});

test('suggestions keep only goals whose breaches lost money', () => {
  const trips = Array.from({ length: 30 }, (_, i) => trip(T0 + i * 12 * HOUR, i % 3
    ? { net: 10 }
    : { addsWhileUnderwater: 1, net: -40, openNotional: 50 }));
  const types = suggestGoals(trips, ctx).map(s => s.type);
  assert.ok(types.includes('noUnderwaterAdds'));
  assert.ok(!types.includes('maxSize'), 'big trips here were the winners');
  assert.ok(suggestGoals(trips, ctx, ['noUnderwaterAdds']).every(s => s.type !== 'noUnderwaterAdds'));
});

test('the preview scores all history with no set date', () => {
  const p = previewGoal(validateGoal({ type: 'noUnderwaterAdds' }), [trip(T0, { addsWhileUnderwater: 1 }), trip(NOW - HOUR)], ctx);
  assert.deepEqual([p.n, p.brokenTrips, p.strip.length], [2, 1, 14]);
});
