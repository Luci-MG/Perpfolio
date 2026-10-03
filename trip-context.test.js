import test from 'node:test';
import assert from 'node:assert/strict';
import * as tc from './trip-context.js';
import { tripKey } from './trade-analytics.js';

const HOUR = 3_600_000;
const bar = (t, low, high, close = (low + high) / 2) => ({ t, open: close, high, low, close });
const trip = o => ({ symbol: 'XUSDT', positionSide: 'LONG', side: 'Long', openTime: 0, closeTime: 10 * HOUR,
                     avgEntry: 100, ...o });

test('the path interval is the finest that fits 1,500 bars', () => {
  for (const [hours, interval] of [[0.5, '1m'], [24, '1m'], [48, '5m'], [24 * 10, '15m'], [24 * 40, '1h'], [24 * 200, '4h']]) {
    assert.equal(tc.pathInterval(0, hours * HOUR).interval, interval, `${hours}h`);
  }
});

test('excursion measures against average entry, in the trip\'s direction', () => {
  const candles = [bar(0, 97, 104), bar(HOUR, 95, 108)];
  assert.deepEqual(tc.excursion(trip({}), candles), { mae: -5, mfe: 8 });
  assert.deepEqual(tc.excursion(trip({ side: 'Short', positionSide: 'SHORT' }), candles), { mae: -8, mfe: 5 });
  assert.deepEqual(tc.excursion(trip({}), [bar(0, 101, 103)]), { mae: 0, mfe: 3 });
  assert.equal(tc.excursion(trip({}), []), null);
});

test('hedged at entry needs the opposite leg already open on the same symbol', () => {
  const long = trip({ openTime: 5 * HOUR });
  const shortBefore = trip({ positionSide: 'SHORT', side: 'Short', openTime: 1 * HOUR, closeTime: 9 * HOUR });
  const shortClosed = trip({ positionSide: 'SHORT', side: 'Short', openTime: 1 * HOUR, closeTime: 4 * HOUR });
  const otherSymbol = trip({ symbol: 'YUSDT', positionSide: 'SHORT', side: 'Short', openTime: 1 * HOUR });
  assert.equal(tc.hedgedAtEntry(long, [long, shortBefore]), true);
  assert.equal(tc.hedgedAtEntry(long, [long, shortClosed, otherSymbol]), false);
  assert.equal(tc.hedgedAtEntry(shortBefore, [long, shortBefore]), false, 'the leg opened second is the hedge');
});

test('BTC trend compares EMA50 with EMA200 on bars closed before entry', () => {
  const rising = Array.from({ length: 260 }, (_, i) => bar(i * HOUR, 0, 0, 100 * 1.002 ** i));
  const flat = Array.from({ length: 260 }, (_, i) => bar(i * HOUR, 0, 0, 100));
  assert.equal(tc.btcTrendAt(rising, 260 * HOUR), 'up');
  assert.equal(tc.btcTrendAt(rising.map(c => ({ ...c, close: 1e4 / c.close })), 260 * HOUR), 'down');
  assert.equal(tc.btcTrendAt(flat, 260 * HOUR), 'flat');
  assert.equal(tc.btcTrendAt(rising, 100 * HOUR), null, 'fewer than 200 closed bars');
});

test('funding with one open leg belongs to it; before the ledger starts it is unknown', () => {
  const a = trip({ openTime: 2 * HOUR, closeTime: 20 * HOUR });
  const early = trip({ symbol: 'ZUSDT', openTime: 0, closeTime: 5 * HOUR });
  const income = [
    { incomeType: 'FUNDING_FEE', symbol: 'XUSDT', income: '-1.5', time: 8 * HOUR },
    { incomeType: 'FUNDING_FEE', symbol: 'XUSDT', income: '0.5', time: 16 * HOUR },
    { incomeType: 'FUNDING_FEE', symbol: 'XUSDT', income: '9', time: 24 * HOUR },
    { incomeType: 'FUNDING_FEE', symbol: 'ZUSDT', income: '-2', time: 4 * HOUR }
  ];
  const out = tc.attributeFunding({ trips: [a, early], income, incomeFrom: 1 * HOUR });
  assert.deepEqual(out.get(tripKey(a)), { funding: -1, fundingSplit: false, fundingIncomplete: false });
  assert.equal(out.get(tripKey(early)).funding, null);
});

const hedge = () => {
  const long = trip({ openTime: 0, closeTime: 20 * HOUR });
  const short = trip({ positionSide: 'SHORT', side: 'Short', openTime: HOUR, closeTime: 20 * HOUR });
  const sizeSteps = new Map([[tripKey(long), [[0, 3]]], [tripKey(short), [[HOUR, 1]]]]);
  const rates = [{ symbol: 'XUSDT', fundingTime: 8 * HOUR, fundingRate: '0.001', markPrice: '100' }];
  return { long, short, sizeSteps, rates };
};
const row = (income, tranId = 7) => ({ incomeType: 'FUNDING_FEE', symbol: 'XUSDT', income, time: 8 * HOUR, tranId });

test('a hedged settlement books one row per leg, and each leg gets its own row whatever the order', () => {
  const { long, short, sizeSteps, rates } = hedge();
  for (const income of [[row('-0.301'), row('0.1002')], [row('0.1002'), row('-0.301')]]) {
    const out = tc.attributeFunding({ trips: [long, short], sizeSteps, income, rates, incomeFrom: 0 });
    assert.deepEqual([out.get(tripKey(long)).funding, out.get(tripKey(short)).funding], [-0.301, 0.1002]);
    assert.equal(out.get(tripKey(long)).fundingSplit, false);
  }
});

test('a hedged settlement missing a leg\'s row leaves both trips unknown, never a guess', () => {
  const { long, short, sizeSteps, rates } = hedge();
  const out = tc.attributeFunding({ trips: [long, short], sizeSteps, income: [row('-0.301')], rates, incomeFrom: 0 });
  assert.deepEqual(out.get(tripKey(long)), { funding: null, fundingSplit: false, fundingIncomplete: true });
  assert.equal(out.get(tripKey(short)).fundingIncomplete, true);
});

test('once the ledger is complete, a leg with no row of its own paid nothing', () => {
  const { long, short, sizeSteps, rates } = hedge();
  const out = tc.attributeFunding({ trips: [long, short], sizeSteps, income: [row('-0.301')], rates, incomeFrom: 0, completeFrom: 0 });
  assert.deepEqual([out.get(tripKey(long)).funding, out.get(tripKey(short)).funding], [-0.301, 0]);
  assert.equal(out.get(tripKey(long)).fundingIncomplete, false);
});

test('without a rate a hedged settlement is shared evenly and marked split', () => {
  const { long, short, sizeSteps } = hedge();
  const out = tc.attributeFunding({ trips: [long, short], sizeSteps, income: [row('-0.3'), row('0.1')], incomeFrom: 0 });
  assert.equal(out.get(tripKey(long)).funding, -0.1);
  assert.equal(out.get(tripKey(short)).fundingSplit, true);
});
test('ATR at entry is a percent of price, and needs fifteen bars', () => {
  const candles = Array.from({ length: 20 }, (_, i) => bar(i * HOUR, 99, 101, 100));
  assert.equal(tc.atrPctAtEntry(candles), 2);
  assert.equal(tc.atrPctAtEntry(candles.slice(0, 10)), null);
});

test('only settlements with both legs open need a funding rate', () => {
  const long = trip({ closeTime: 20 * HOUR });
  const short = trip({ positionSide: 'SHORT', side: 'Short', openTime: 10 * HOUR, closeTime: 20 * HOUR });
  const income = [8, 16].map(h => ({ incomeType: 'FUNDING_FEE', symbol: 'XUSDT', income: '-1', time: h * HOUR }));
  assert.deepEqual([...tc.hedgedSettlements({ trips: [long, short], income })], [['XUSDT', [16 * HOUR]]]);
});

test('only a fill that grows its leg starts a capture', () => {
  const o = x => ({ x: 'TRADE', R: false, ...x });
  assert.equal(tc.isIncreasingFill(o({ ps: 'LONG', S: 'BUY' })), true);
  assert.equal(tc.isIncreasingFill(o({ ps: 'LONG', S: 'SELL' })), false);
  assert.equal(tc.isIncreasingFill(o({ ps: 'SHORT', S: 'SELL' })), true);
  assert.equal(tc.isIncreasingFill(o({ ps: 'BOTH', S: 'SELL' })), true, 'one-way: any non-reduce fill');
  assert.equal(tc.isIncreasingFill(o({ ps: 'BOTH', S: 'SELL', R: true })), false);
  assert.equal(tc.isIncreasingFill(o({ ps: 'LONG', S: 'BUY', x: 'NEW' })), false);
});
