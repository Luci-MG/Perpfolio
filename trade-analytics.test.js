import test from 'node:test';
import assert from 'node:assert/strict';
import * as ta from './trade-analytics.js';

let seq = 1;
const fill = (o = {}) => ({
  symbol: 'AUSDT', id: seq++, side: 'BUY', positionSide: 'LONG',
  price: '100', qty: '1', realizedPnl: '0', commission: '0.05',
  commissionAsset: 'USDT', time: seq * 60_000, maker: false, ...o
});

test('one open and one close is one round trip', () => {
  const { trips, stillOpen } = ta.buildRoundTrips([
    fill({ side: 'BUY',  qty: '10', price: '100', time: 1000 }),
    fill({ side: 'SELL', qty: '10', price: '110', realizedPnl: '100', time: 2000 })
  ]);
  assert.equal(trips.length, 1);
  assert.equal(stillOpen.length, 0);
  assert.equal(trips[0].realized, 100);
  assert.equal(trips[0].commission, 0.1);
  assert.equal(trips[0].net, 99.9);
  assert.equal(trips[0].win, true);
  assert.equal(trips[0].fills, 2);
  assert.equal(trips[0].maxSize, 10);
});

test('a position is only closed when size returns to zero', () => {
  const { trips, stillOpen } = ta.buildRoundTrips([
    fill({ side: 'BUY',  qty: '10', time: 1000 }),
    fill({ side: 'SELL', qty: '4', realizedPnl: '20', time: 2000 }),
    fill({ side: 'SELL', qty: '3', realizedPnl: '15', time: 3000 })
  ]);
  assert.equal(trips.length, 0, 'still 3 units open');
  assert.equal(stillOpen.length, 1);
  assert.equal(stillOpen[0].size, 3);

  const done = ta.buildRoundTrips([
    fill({ side: 'BUY',  qty: '10', time: 1000 }),
    fill({ side: 'SELL', qty: '4', realizedPnl: '20', time: 2000 }),
    fill({ side: 'SELL', qty: '6', realizedPnl: '30', time: 3000 })
  ]);
  assert.equal(done.trips.length, 1);
  assert.equal(done.trips[0].realized, 50);
});

test('adding at a worse price than the running average is counted', () => {
  const { trips } = ta.buildRoundTrips([
    fill({ side: 'BUY',  qty: '10', price: '100', time: 1000 }),
    fill({ side: 'BUY',  qty: '10', price: '90',  time: 2000 }),   // underwater add
    fill({ side: 'BUY',  qty: '10', price: '80',  time: 3000 }),   // underwater add
    fill({ side: 'SELL', qty: '30', price: '85', realizedPnl: '-150', time: 4000 })
  ]);
  assert.equal(trips[0].addsWhileUnderwater, 2);
  assert.equal(trips[0].win, false);

  const up = ta.buildRoundTrips([
    fill({ side: 'BUY',  qty: '10', price: '100', time: 1000 }),
    fill({ side: 'BUY',  qty: '10', price: '110', time: 2000 }),   // adding into profit
    fill({ side: 'SELL', qty: '20', price: '120', realizedPnl: '250', time: 3000 })
  ]);
  assert.equal(up.trips[0].addsWhileUnderwater, 0, 'adding higher on a long is not underwater');
});

test('a short is underwater when it adds higher', () => {
  const { trips } = ta.buildRoundTrips([
    fill({ positionSide: 'SHORT', side: 'SELL', qty: '10', price: '100', time: 1000 }),
    fill({ positionSide: 'SHORT', side: 'SELL', qty: '10', price: '120', time: 2000 }),
    fill({ positionSide: 'SHORT', side: 'BUY',  qty: '20', price: '130', realizedPnl: '-400', time: 3000 })
  ]);
  assert.equal(trips[0].addsWhileUnderwater, 1);
  assert.equal(trips[0].positionSide, 'SHORT');
});

test('hedge legs on one symbol are separate round trips', () => {
  const { trips } = ta.buildRoundTrips([
    fill({ positionSide: 'LONG',  side: 'BUY',  qty: '5', time: 1000 }),
    fill({ positionSide: 'SHORT', side: 'SELL', qty: '5', time: 1100 }),
    fill({ positionSide: 'LONG',  side: 'SELL', qty: '5', realizedPnl: '10', time: 2000 }),
    fill({ positionSide: 'SHORT', side: 'BUY',  qty: '5', realizedPnl: '-8', time: 2100 })
  ]);
  assert.equal(trips.length, 2);
  assert.deepEqual(trips.map(t => t.positionSide).sort(), ['LONG', 'SHORT']);
});

test('a one-way fill that crosses zero closes one trip and opens the opposite', () => {
  const { trips, stillOpen } = ta.buildRoundTrips([
    fill({ positionSide: 'BOTH', side: 'BUY',  qty: '5',  price: '100', time: 1000 }),
    fill({ positionSide: 'BOTH', side: 'SELL', qty: '12', price: '110', realizedPnl: '50', time: 2000 })
  ]);
  assert.equal(trips.length, 1, 'the long leg is closed out');
  assert.equal(stillOpen.length, 1, 'and a short is left open');
  assert.equal(stillOpen[0].size, -7);
});

test('fees paid in BNB are not added to a dollar figure', () => {
  const { trips, nonQuoteFees } = ta.buildRoundTrips([
    fill({ side: 'BUY',  qty: '10', commission: '0.004', commissionAsset: 'BNB', time: 1000 }),
    fill({ side: 'SELL', qty: '10', realizedPnl: '100', commission: '0.004', commissionAsset: 'BNB', time: 2000 })
  ]);
  assert.equal(trips[0].commission, 0, 'BNB fees are excluded from the USD total');
  assert.equal(trips[0].net, 100);
  assert.ok(nonQuoteFees > 0, 'but they are reported separately, not silently dropped');
});

test('summarise reads net after fees and funding, counts a flat trip as neither, and takes the true median hold', () => {
  const trips = [
    { net: 100, funding: 0, netAfterFunding: 100, commission: 1, holdHours: 1 },
    { net: 210, funding: -10, netAfterFunding: 200, commission: 1, holdHours: 2 },
    { net: -50, funding: 0, netAfterFunding: -50, commission: 1, holdHours: 3 },
    { net: -50, commission: 1, holdHours: 4 },
    { net: 0.004, commission: 1, holdHours: 5 },
    { net: 0, commission: 1, holdHours: 6 }
  ];
  const s = ta.summarise(trips);
  assert.deepEqual([s.trips, s.wins, s.losses], [6, 2, 2]);
  assert.equal(s.net, 200);
  assert.equal(s.funding, -10);
  assert.deepEqual([s.avgWin, s.avgLoss, s.payoff], [150, -50, 3]);
  assert.equal(s.medianHoldHours, 3.5);
  assert.equal(ta.summarise([]).trips, 0);
});

test('funding interval is inferred from observed settlements', () => {
  const rows = (gapH, n) => Array.from({ length: n }, (_, i) => ({
    incomeType: 'FUNDING_FEE', symbol: 'AUSDT', income: '-1', time: i * gapH * 3_600_000
  }));
  assert.equal(ta.inferFundingInterval(rows(8, 20), 'AUSDT').inferredHours, 8);
  assert.equal(ta.inferFundingInterval(rows(4, 20), 'AUSDT').inferredHours, 4);
  assert.equal(ta.inferFundingInterval(rows(1, 20), 'AUSDT').inferredHours, 1);
  assert.equal(ta.inferFundingInterval(rows(8, 2), 'AUSDT').inferredHours, null, 'too few to judge');

  // hedge mode bills both legs at the same instant; that must not look like a shorter interval
  const hedged = rows(8, 20).flatMap(r => [r, { ...r, income: '+1' }]);
  assert.equal(ta.inferFundingInterval(hedged, 'AUSDT').inferredHours, 8);
});

const trip = (o = {}) => ({
  symbol: 'AUSDT', positionSide: 'LONG', openTime: Date.UTC(2026, 0, 5, 10),
  closeTime: Date.UTC(2026, 0, 5, 12), holdHours: 2, net: 100, win: true,
  commission: 1, fills: 3, addsWhileUnderwater: 0, peakNotional: 1000, ...o
});

test('every bucket carries its count and flags a thin sample', () => {
  const [hold] = ta.byHoldTime([trip({ net: -9000, holdHours: 0.1 })]);
  assert.equal(hold.trips, 1);
  assert.equal(hold.thin, true, 'one trip showing a five-figure number must be flagged');
  assert.equal(ta.byHoldTime(Array.from({ length: 12 }, () => trip({ holdHours: 0.1 })))[0].thin, false);
});

test('hold-time buckets partition every trip exactly once', () => {
  const trips = [0.1, 0.5, 2, 10, 50, 300].map(h => trip({ holdHours: h }));
  const buckets = ta.byHoldTime(trips);
  assert.equal(buckets.reduce((s, b) => s + b.trips, 0), trips.length);
  assert.equal(buckets.find(b => b.label === 'under 15m').trips, 1);
  assert.equal(buckets.find(b => b.label === 'over 7d').trips, 1);
});

test('daily net is cut at local midnight, and transfers are not trading', () => {
  const days = ta.dailyIncomeNet([
    { incomeType: 'REALIZED_PNL', income: '100', time: Date.UTC(2026, 0, 7, 12) },
    { incomeType: 'COMMISSION', income: '-1', time: Date.UTC(2026, 0, 7, 23, 30) },
    { incomeType: 'TRANSFER', income: '500', time: Date.UTC(2026, 0, 8) },
    { incomeType: 'REALIZED_PNL', income: '-50', time: Date.UTC(2026, 0, 9, 12) }
  ], 60);
  assert.deepEqual(days, [{ date: '2026-01-07', pnl: 100 }, { date: '2026-01-08', pnl: -1 }, { date: '2026-01-09', pnl: -50 }]);
});

test('bySide groups on the side held, one-way trips included, and byMonth on the local month', () => {
  const trips = [
    trip({ positionSide: 'BOTH', side: 'Long', closeTime: Date.UTC(2026, 0, 31, 23, 30) }),
    trip({ positionSide: 'SHORT', side: 'Short', closeTime: Date.UTC(2026, 1, 5) }),
    trip({ positionSide: 'BOTH', side: 'Short', closeTime: Date.UTC(2026, 1, 6) })
  ];
  assert.deepEqual(ta.bySide(trips).map(b => [b.label, b.trips]), [['Long', 1], ['Short', 2]]);
  assert.deepEqual(ta.byMonth(trips).map(m => m.label), ['2026-01', '2026-02']);
  assert.deepEqual(ta.byMonth(trips, 60).map(m => [m.label, m.trips]), [['2026-02', 3]]);
});

test('float dust left by summed fill sizes still closes the trip', () => {
  const f = (id, side, qty, price, pnl = 0) => ({ symbol: 'X', id, side, positionSide: 'LONG', price: String(price),
    qty: String(qty), realizedPnl: String(pnl), commission: '0', commissionAsset: 'USDT', time: id * 1000 });
  const { trips, stillOpen } = ta.buildRoundTrips([
    f(1, 'BUY', 0.1 * 1e6, 10), f(2, 'BUY', 0.2 * 1e6, 10), f(3, 'SELL', 0.3 * 1e6, 11, 30000),
    f(4, 'BUY', 5, 12), f(5, 'SELL', 5, 13, 5)
  ]);
  assert.equal(trips.length, 2);
  assert.equal(stillOpen.length, 0);
  assert.equal(trips[1].addsWhileUnderwater, 0);
});

test('a hedge-mode close with nothing open is an orphan, not a negative trip', () => {
  const f = (id, side, qty, pnl) => ({ symbol: 'X', id, side, positionSide: 'LONG', price: '10',
    qty: String(qty), realizedPnl: String(pnl), commission: '0.1', commissionAsset: 'USDT', time: id * 1000 });
  const r = ta.buildRoundTrips([f(1, 'SELL', 2, -40), f(2, 'SELL', 1, -5), f(3, 'BUY', 1, 0), f(4, 'SELL', 1, 3)]);
  assert.equal(r.orphans.fills, 2);
  assert.equal(r.orphans.realized, -45);
  assert.equal(r.trips.length, 1);
  assert.equal(r.trips[0].realized, 3);
  assert.equal(r.stillOpen.length, 0);
});

test('a leg opened before history, added to and then closed past zero is an orphan, and later trips survive', () => {
  for (const [positionSide, open, shut] of [['LONG', 'BUY', 'SELL'], ['SHORT', 'SELL', 'BUY']]) {
    const f = (id, side, qty, pnl) => ({ symbol: 'X', id, side, positionSide, price: '10', qty: String(qty),
      realizedPnl: String(pnl), commission: '0.1', commissionAsset: 'USDT', time: id * 1000 });
    const r = ta.buildRoundTrips([f(1, open, 5, 0), f(2, shut, 15, -30), f(3, open, 1, 0), f(4, shut, 1, 2),
                                  f(5, open, 1, 0), f(6, shut, 1, 4)]);
    assert.deepEqual([r.orphans.fills, r.orphans.realized, r.orphans.commission], [2, -30, 0.2], positionSide);
    assert.deepEqual(r.preHistoryUntil, { X: 2000 }, 'the pre-history position was open until its last close');
    assert.deepEqual(r.trips.map(t => t.realized), [2, 4]);
    assert.equal(r.stillOpen.length, 0);
    const realised = r.trips.reduce((s, t) => s + t.realized, 0) + r.orphans.realized;
    assert.equal(realised, -24, 'every fill\'s realised PnL lands in exactly one bucket');
  }
});

test('a trip records its side, opening lot, quantity entered, adds, partial closes and average exit', () => {
  const { trips, sizeSteps } = ta.buildRoundTrips([
    fill({ side: 'SELL', positionSide: 'SHORT', qty: '2', price: '100', time: 1000 }),
    fill({ side: 'SELL', positionSide: 'SHORT', qty: '1', price: '106', time: 2000 }),
    fill({ side: 'BUY',  positionSide: 'SHORT', qty: '1', price: '95', time: 3000 }),
    fill({ side: 'BUY',  positionSide: 'SHORT', qty: '2', price: '92', time: 4000 })
  ]);
  const [t] = trips;
  assert.equal(t.side, 'Short');
  assert.equal(t.openNotional, 200);
  assert.deepEqual([t.openQty, t.enteredQty], [2, 3]);
  assert.equal(t.adds, 1);
  assert.equal(t.partialCloses, 1);
  assert.ok(Math.abs(t.avgExit - (95 + 2 * 92) / 3) < 1e-12);
  assert.deepEqual(sizeSteps.get(ta.tripKey(t)), [[1000, 2], [2000, 3], [3000, 2], [4000, 0]]);
});

test('a one-way flip closes at the old size and opens the new side at the remainder', () => {
  const { trips, stillOpen } = ta.buildRoundTrips([
    fill({ positionSide: 'BOTH', side: 'BUY', qty: '1', price: '100', time: 1000 }),
    fill({ positionSide: 'BOTH', side: 'SELL', qty: '3', price: '110', time: 2000 })
  ]);
  assert.equal(trips[0].side, 'Long');
  assert.equal(trips[0].avgExit, 110);
  assert.equal(trips[0].partialCloses, 0);
  assert.equal(stillOpen[0].side, 'Short');
});

test('periods start at local midnight, Monday and the 1st, for the reader\'s timezone', () => {
  const now = Date.UTC(2026, 9, 1, 23, 30);
  const berlin = ta.periodStarts(now, 120);
  assert.equal(berlin.today, Date.UTC(2026, 9, 1, 22, 0), 'already 2 October in Berlin');
  assert.equal(berlin.week, Date.UTC(2026, 8, 27, 22, 0), 'Monday 28 September, local');
  assert.equal(berlin.month, Date.UTC(2026, 8, 30, 22, 0));
  assert.equal(ta.periodStarts(now, 0).today, Date.UTC(2026, 9, 1));
});

test('period net sums realised, fees and funding, and counts closed trips', () => {
  const income = [
    { incomeType: 'REALIZED_PNL', income: '50', time: 200 }, { incomeType: 'COMMISSION', income: '-2', time: 210 },
    { incomeType: 'FUNDING_FEE', income: '-1', time: 220 }, { incomeType: 'TRANSFER', income: '1000', time: 230 },
    { incomeType: 'REALIZED_PNL', income: '-30', time: 50 }];
  const trips = [{ closeTime: 205, win: true }, { closeTime: 40, win: false }];
  assert.deepEqual(ta.periodNet(income, trips, { today: 100 }).today,
    { from: 100, realized: 50, fees: -2, funding: -1, net: 47, transfers: 1000, trips: 1, wins: 1 });
});

test('the wallet curve walks back from today exactly, one point per day closed', () => {
  const day = 86_400_000;
  const income = [
    { incomeType: 'TRANSFER', income: '1000', time: 0.5 * day, asset: 'USDT' },
    { incomeType: 'REALIZED_PNL', income: '200', time: 1.5 * day, asset: 'USDT' },
    { incomeType: 'COMMISSION', income: '-0.01', time: 1.6 * day, asset: 'BNB' },
    { incomeType: 'FUNDING_FEE', income: '-50', time: 2.5 * day, asset: 'USDC' }];
  const curve = ta.walletCurve(income, 1150, 3 * day);
  assert.deepEqual(curve.map(p => p.wallet), [0, 1000, 1200, 1150, 1150], 'start, the close of days 0–2, now');
  assert.equal(curve.at(-1).t, 3 * day);
});

test('account change removes transfers and says when snapshots began after the period', () => {
  const snaps = [{ t: 300, accountValue: 1000 }, { t: 400, accountValue: 2100 }, { t: 500, accountValue: 2050 }];
  const income = [{ incomeType: 'TRANSFER', income: '1000', time: 350 }];
  assert.deepEqual(ta.accountChange(snaps, income, { a: 250 }).a, { change: 50, since: 300, partial: false });
  assert.equal(ta.accountChange(snaps, income, { b: 600 }).b, null);
  assert.equal(ta.accountChange(snaps, income, { c: -1e7 }).c.partial, true);
});

test('previous periods are cut at the same elapsed time, and a short month ends at its own end', () => {
  const tue = Date.UTC(2026, 9, 6, 14);
  const p = ta.previousPeriodStarts(tue, 0);
  assert.deepEqual(p.today, { from: Date.UTC(2026, 9, 5), to: Date.UTC(2026, 9, 5, 14) });
  assert.deepEqual(p.week, { from: Date.UTC(2026, 8, 28), to: Date.UTC(2026, 8, 29, 14) });
  assert.deepEqual(p.month, { from: Date.UTC(2026, 8, 1), to: Date.UTC(2026, 8, 6, 14) });
  const oct31 = Date.UTC(2026, 9, 31, 12);
  assert.equal(ta.previousPeriodStarts(oct31, 0).month.to, Date.UTC(2026, 9, 1), 'September has no 31st');
  const jan = ta.previousPeriodStarts(Date.UTC(2027, 0, 10), 120);
  assert.equal(jan.month.from, Date.UTC(2026, 11, 1) - 120 * 60_000, 'December of the year before, local midnight');
});

test('a bounded period counts net income and trips closed inside it only', () => {
  const income = [{ incomeType: 'REALIZED_PNL', income: '10', time: 5 }, { incomeType: 'COMMISSION', income: '-1', time: 6 },
                  { incomeType: 'TRANSFER', income: '500', time: 6 }, { incomeType: 'REALIZED_PNL', income: '99', time: 20 }];
  const trips = [{ closeTime: 5, win: true }, { closeTime: 9, win: false }, { closeTime: 10, win: true }];
  assert.deepEqual(ta.periodNetBetween(income, trips, 0, 10), { from: 0, to: 10, net: 9, trips: 2, wins: 1 });
});

test('open legs are checked against Binance: a size, a missing leg or an extra leg is a mismatch; float dust is not', () => {
  const leg = (symbol, positionSide, size) => ({ symbol, positionSide, size });
  const m = ta.openLegMismatches([leg('A', 'LONG', 3.0000000001), leg('B', 'SHORT', -2), leg('C', 'LONG', 1)],
                                 [leg('A', 'LONG', 3), leg('B', 'SHORT', -5), leg('D', 'SHORT', -1)]);
  assert.deepEqual(m.map(x => [x.symbol, x.rebuilt, x.live]), [['B', -2, -5], ['C', 1, 0], ['D', 0, -1]]);
});
