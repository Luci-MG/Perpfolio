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

test('summarise computes payoff, expectancy and profit factor', () => {
  const trips = [
    { net: 100, win: true,  commission: 1, holdHours: 1 },
    { net: 200, win: true,  commission: 1, holdHours: 2 },
    { net: -50, win: false, commission: 1, holdHours: 3 },
    { net: -50, win: false, commission: 1, holdHours: 4 }
  ];
  const s = ta.summarise(trips);
  assert.equal(s.trips, 4);
  assert.equal(s.winRate, 50);
  assert.equal(s.net, 200);
  assert.equal(s.avgWin, 150);
  assert.equal(s.avgLoss, -50);
  assert.equal(s.payoff, 3);
  assert.equal(s.expectancy, 50);
  assert.equal(s.profitFactor, 3);
  assert.equal(ta.summarise([]).trips, 0);
});

test('behaviourSplit separates the two populations exactly', () => {
  const trips = [
    { net: 10, win: true,  commission: 0, holdHours: 1, addsWhileUnderwater: 0 },
    { net: -80, win: false, commission: 0, holdHours: 1, addsWhileUnderwater: 3 },
    { net: 5,  win: true,  commission: 0, holdHours: 1, addsWhileUnderwater: 0 }
  ];
  const b = ta.behaviourSplit(trips);
  assert.equal(b.addedWhileUnderwater.trips, 1);
  assert.equal(b.addedWhileUnderwater.net, -80);
  assert.equal(b.clean.trips, 2);
  assert.equal(b.clean.net, 15);
});

test('equityCurve tracks cumulative PnL and the worst drawdown', () => {
  const day = d => Date.UTC(2026, 0, d);
  const eq = ta.equityCurve([
    { incomeType: 'REALIZED_PNL', income: '100', time: day(1) },
    { incomeType: 'COMMISSION',   income: '-10', time: day(1) },
    { incomeType: 'REALIZED_PNL', income: '-200', time: day(2) },
    { incomeType: 'REALIZED_PNL', income: '50',  time: day(3) },
    { incomeType: 'TRANSFER',     income: '9999', time: day(3) }   // must be excluded
  ]);
  assert.equal(eq.days, 3);
  assert.equal(eq.net, -60);
  assert.equal(eq.greenDays, 2);
  assert.equal(eq.redDays, 1);
  assert.equal(eq.maxDrawdown, -200, 'peak 90 then trough -110');
  assert.equal(eq.worstDay.pnl, -200);
});

test('incomeTotals reports fee drag against gross realised PnL', () => {
  const t = ta.incomeTotals([
    { incomeType: 'REALIZED_PNL', income: '1000', time: 1 },
    { incomeType: 'COMMISSION',   income: '-150', time: 1 }
  ]);
  assert.equal(t.totals.REALIZED_PNL, 1000);
  assert.equal(t.feeDragPct, 15);
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
  const few = [trip({ net: -9000, win: false })];
  const dow = ta.byDayOfWeek(few);
  const monday = dow.find(d => d.label === 'Monday');
  assert.equal(monday.trips, 1);
  assert.equal(monday.thin, true, 'one trip showing a five-figure number must be flagged');
  assert.equal(dow.find(d => d.label === 'Sunday').trips, 0);
  assert.equal(dow.length, 7);

  const many = Array.from({ length: 12 }, () => trip());
  assert.equal(ta.byDayOfWeek(many).find(d => d.label === 'Monday').thin, false);
});

test('hold-time buckets partition every trip exactly once', () => {
  const trips = [0.1, 0.5, 2, 10, 50, 300].map(h => trip({ holdHours: h }));
  const buckets = ta.byHoldTime(trips);
  assert.equal(buckets.reduce((s, b) => s + b.trips, 0), trips.length);
  assert.equal(buckets.find(b => b.label === 'under 15m').trips, 1);
  assert.equal(buckets.find(b => b.label === 'over 7d').trips, 1);
});

test('hour buckets cover the whole clock', () => {
  const hours = ta.byHourOfDay([trip({ openTime: Date.UTC(2026, 0, 5, 23) })]);
  assert.equal(hours.length, 24);
  assert.equal(hours[23].trips, 1);
  assert.equal(hours[23].label, '23:00');
});

test('streaks find the longest runs and the current one', () => {
  const seq = [1, 1, 1, 0, 0, 1, 1, 1, 1, 0].map((w, i) =>
    trip({ win: !!w, net: w ? 10 : -5, closeTime: Date.UTC(2026, 0, 1 + i) }));
  const s = ta.streaks(seq);
  assert.equal(s.longestWin, 4);
  assert.equal(s.longestLoss, 2);
  assert.equal(s.current, -1);
  assert.equal(s.currentIsWin, false);
  assert.equal(s.longestWinPnl, 40);
  assert.deepEqual(ta.streaks([]).longestWin, 0);
});

test('sequenceEffect compares size after a loss with size after a win', () => {
  const seq = [
    trip({ win: true,  net: 10,  closeTime: 1, peakNotional: 100 }),
    trip({ win: false, net: -10, closeTime: 2, peakNotional: 5000 }),  // after a win
    trip({ win: true,  net: 10,  closeTime: 3, peakNotional: 200 })    // after a loss
  ];
  const e = ta.sequenceEffect(seq);
  assert.equal(e.afterWin.trips, 1);
  assert.equal(e.afterWin.avgSize, 5000);
  assert.equal(e.afterLoss.trips, 1);
  assert.equal(e.afterLoss.avgSize, 200, 'sizing down after a loss is the opposite of revenge');
});

test('sizeDistribution reports the spread of position sizes', () => {
  const d = ta.sizeDistribution(Array.from({ length: 100 }, (_, i) => trip({ peakNotional: i + 1 })));
  assert.equal(d.count, 100);
  assert.equal(d.max, 100);
  assert.ok(d.median > d.p10 && d.p90 > d.median);
  assert.equal(ta.sizeDistribution([]), null);
});

test('makerTaker splits fills and their fees', () => {
  const m = ta.makerTaker([
    { maker: true,  commission: '0.02' },
    { maker: false, commission: '0.05' },
    { maker: false, commission: '0.05' }
  ]);
  assert.equal(m.maker, 1);
  assert.equal(m.taker, 2);
  assert.ok(Math.abs(m.makerPct - 33.3) < 0.1);
  assert.equal(m.makerFee, 0.02);
  assert.equal(m.takerFee, 0.1);
  assert.equal(m.totalFee, 0.12);
});

test('records surface the extremes', () => {
  const trips = [
    trip({ net: 500, symbol: 'BEST' }),
    trip({ net: -900, win: false, symbol: 'WORST' }),
    trip({ net: 1, holdHours: 900, symbol: 'SLOW' }),
    trip({ net: 2, fills: 999, symbol: 'BUSY' })
  ];
  const r = ta.records(trips, { bestDay: { date: 'x', pnl: 1 }, worstDay: { date: 'y', pnl: -1 } });
  assert.equal(r.bestTrip.symbol, 'BEST');
  assert.equal(r.worstTrip.symbol, 'WORST');
  assert.equal(r.longestHeld.symbol, 'SLOW');
  assert.equal(r.mostFills.symbol, 'BUSY');
  assert.equal(r.bestDay.pnl, 1);
});

test('calendar lays days into Monday-first weeks with gaps preserved', () => {
  const d = (y, m, day) => Date.UTC(y, m, day);
  const cal = ta.calendar([
    { incomeType: 'REALIZED_PNL', income: '100', time: d(2026, 0, 7) },   // Wed
    { incomeType: 'REALIZED_PNL', income: '-50', time: d(2026, 0, 9) }    // Fri
  ]);
  assert.equal(cal.days.length, 2);
  assert.equal(cal.maxAbs, 100);
  assert.equal(cal.weeks[0].length, 7);
  assert.equal(cal.weeks[0][0].date, '2026-01-05', 'week starts on the Monday');
  assert.equal(cal.weeks[0][2].pnl, 100, 'Wednesday holds the value');
  assert.equal(cal.weeks[0][3].pnl, null, 'a day with no trading is null, not zero');
  assert.deepEqual(ta.calendar([]).weeks, []);
});

test('bySide and byMonth group without dropping trips', () => {
  const trips = [
    trip({ positionSide: 'LONG',  closeTime: Date.UTC(2026, 0, 5) }),
    trip({ positionSide: 'SHORT', closeTime: Date.UTC(2026, 1, 5) }),
    trip({ positionSide: 'SHORT', closeTime: Date.UTC(2026, 1, 6) })
  ];
  assert.equal(ta.bySide(trips).reduce((s, b) => s + b.trips, 0), 3);
  assert.equal(ta.bySide(trips).find(b => b.side === 'SHORT').trips, 2);
  const months = ta.byMonth(trips);
  assert.deepEqual(months.map(m => m.month), ['2026-01', '2026-02']);
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

test('a trip records its side, opening notional, adds, partial closes and average exit', () => {
  const { trips, sizeSteps } = ta.buildRoundTrips([
    fill({ side: 'SELL', positionSide: 'SHORT', qty: '2', price: '100', time: 1000 }),
    fill({ side: 'SELL', positionSide: 'SHORT', qty: '1', price: '106', time: 2000 }),
    fill({ side: 'BUY',  positionSide: 'SHORT', qty: '1', price: '95', time: 3000 }),
    fill({ side: 'BUY',  positionSide: 'SHORT', qty: '2', price: '92', time: 4000 })
  ]);
  const [t] = trips;
  assert.equal(t.side, 'Short');
  assert.equal(t.openNotional, 200);
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
