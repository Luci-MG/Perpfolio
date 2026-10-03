import test from 'node:test';
import assert from 'node:assert/strict';
import * as tc from './trip-context.js';
import { tripKey } from './trade-analytics.js';

const HOUR = 3_600_000;
const bar = (t, low, high, close = (low + high) / 2) => ({ t, open: close, high, low, close });
const trip = o => ({ symbol: 'XUSDT', positionSide: 'LONG', side: 'Long', openTime: 0, closeTime: 10 * HOUR,
                     avgEntry: 100, ...o });

test('sessions split the UTC day at 08, 14 and 22', () => {
  const at = h => Date.UTC(2026, 0, 5, h, 30);
  assert.deepEqual([7, 8, 13, 14, 21, 22, 23].map(h => tc.sessionOf(at(h))),
    ['Asia', 'Europe', 'Europe', 'US', 'US', 'Asia', 'Asia']);
});

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
  assert.deepEqual(out.get(tripKey(a)), { funding: -1, fundingSplit: false });
  assert.equal(out.get(tripKey(early)).funding, null);
});

test('a hedged settlement splits by size and rate and sums exactly to the net row', () => {
  const long = trip({ openTime: 0, closeTime: 20 * HOUR });
  const short = trip({ positionSide: 'SHORT', side: 'Short', openTime: HOUR, closeTime: 20 * HOUR });
  const sizeSteps = new Map([[tripKey(long), [[0, 3]]], [tripKey(short), [[HOUR, 1]]]]);
  const income = [{ incomeType: 'FUNDING_FEE', symbol: 'XUSDT', income: '-0.21', time: 8 * HOUR }];
  const rates = [{ symbol: 'XUSDT', fundingTime: 8 * HOUR, fundingRate: '0.001', markPrice: '100' }];
  const out = tc.attributeFunding({ trips: [long, short], sizeSteps, income, rates, incomeFrom: 0 });
  const l = out.get(tripKey(long)), s = out.get(tripKey(short));
  assert.ok(Math.abs(l.funding - (-0.3 - 0.005)) < 1e-9, `long ${l.funding}`);
  assert.ok(Math.abs(s.funding - (0.1 - 0.005)) < 1e-9, `short ${s.funding}`);
  assert.ok(Math.abs(l.funding + s.funding - -0.21) < 1e-9);
  assert.equal(l.fundingSplit && s.fundingSplit, true);
});

test('without a rate a hedged settlement splits evenly', () => {
  const long = trip({ closeTime: 20 * HOUR });
  const short = trip({ positionSide: 'SHORT', side: 'Short', openTime: HOUR, closeTime: 20 * HOUR });
  const income = [{ incomeType: 'FUNDING_FEE', symbol: 'XUSDT', income: '-1', time: 8 * HOUR }];
  const out = tc.attributeFunding({ trips: [long, short], income, incomeFrom: 0 });
  assert.equal(out.get(tripKey(long)).funding, -0.5);
  assert.equal(out.get(tripKey(short)).funding, -0.5);
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
