import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_DAILY_RETURNS, btcBeta, dailySeries, dailyTripNet, drawdown, records, riskAdjusted, streaksVsChance,
         timeWeightedReturn, unitStats } from './performance.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const D0 = Date.UTC(2026, 5, 1);
const near = (actual, expected, tol, what) => assert.ok(Math.abs(actual - expected) <= tol, `${what}: ${actual} vs ${expected}`);
const income = (time, incomeType, amount) => ({ time, incomeType, income: String(amount), asset: 'USDT' });
const row = (date, ret, source = 'account') => ({ date, ret, source });
const day = i => new Date(D0 + i * DAY).toISOString().slice(0, 10);
const trip = (openTime, o = {}) => ({ symbol: 'SOLUSDT', side: 'Long', openTime, closeTime: openTime + HOUR, holdHours: 1,
  openNotional: 100, avgEntry: 100, net: 1, netAfterFunding: 1, ...o });

test('the wallet is rebuilt backwards from today, a transfer is a flow not a gain, and Modified Dietz weights it by time held', () => {
  const rows = [income(D0 + 12 * HOUR, 'REALIZED_PNL', 100), income(D0 + DAY + 18 * HOUR, 'TRANSFER', 1000),
                income(D0 + DAY + 20 * HOUR, 'REALIZED_PNL', 50)];
  const series = dailySeries({ income: rows, walletNow: 2150, now: D0 + DAY + 23 * HOUR });
  assert.deepEqual(series.map(r => [r.date, r.source, r.value, r.flow, r.pnl]),
    [[day(0), 'wallet', 1100, 0, null], [day(1), 'wallet', 2150, 1000, 50]]);
  near(series[1].ret, 50 / (1100 + 1000 * 0.25), 1e-6, 'the deposit counted for the quarter-day it was held');
});

test('account value takes over from the first snapshot day; the handoff day and a day without snapshots have no return', () => {
  const snapshots = [{ t: D0 + 2 * DAY + HOUR, accountValue: 1300 }, { t: D0 + 3 * DAY + HOUR, accountValue: 1350 },
                     { t: D0 + 5 * DAY + HOUR, accountValue: 1400 }];
  const series = dailySeries({ income: [income(D0, 'REALIZED_PNL', 10)], walletNow: 1000, snapshots, now: D0 + 5 * DAY + 2 * HOUR });
  assert.deepEqual(series.map(r => [r.source, r.value]),
    [['wallet', 1000], ['wallet', 1000], ['account', 1300], ['account', 1350], ['account', null], ['account', 1400]]);
  assert.deepEqual(series.map(r => r.ret), [null, 0, null, +(50 / 1300).toFixed(6), null, null]);
  const twr = timeWeightedReturn(series);
  assert.equal(twr.days, 2);
  assert.equal(twr.gaps, 3);
});

test('drawdown is depth from the peak, with how long it lasted, recovery, and a lower bound when the wallet is involved', () => {
  const series = [row(day(0), null), row(day(1), 0.1, 'wallet'), row(day(2), -0.2, 'wallet'), row(day(3), 0.1),
                  row(day(4), 0.2), row(day(5), -0.05)];
  const d = drawdown(series);
  assert.equal(d.maxPct, -20);
  assert.deepEqual([d.peakAt, d.troughAt, d.recoveredAt, d.days], [day(1), day(2), day(4), 3]);
  assert.equal(d.lowerBound, true, 'open losses are not in the wallet');
  assert.equal(d.current.pct, -5);
  assert.equal(d.current.since, day(4));
  assert.equal(d.zeroEdgePct, null, 'too few days to estimate volatility');
  assert.deepEqual(drawdown([row(day(0), null), row(day(1), 0.01)]).troughAt, null);
});

test('a no-edge book of the same volatility is expected to fall about 1.25·σ·√T', () => {
  const series = Array.from({ length: 100 }, (_, i) => row(day(i), i % 2 ? 0.01 : -0.01));
  near(drawdown(series).zeroEdgePct, -1.2533 * 0.01005 * 10 * 100, 0.05, 'expected max drawdown');
});

test('Sharpe waits for 60 daily returns, then carries a standard error and the chance it is above zero', () => {
  assert.deepEqual(riskAdjusted(Array.from({ length: 59 }, (_, i) => row(day(i), 0.01))), { n: 59, needs: 1 });
  const twoPoint = Array.from({ length: MIN_DAILY_RETURNS }, (_, i) => row(day(i), i % 2 ? 0.03 : -0.01));
  const r = riskAdjusted(twoPoint);
  near(r.sharpe.value, 0.5 * Math.sqrt(365), 0.01, 'a daily Sharpe of 0.5, annualised');
  near(r.sharpe.se, Math.sqrt(365 / 59), 0.01, 'two-point returns: no skew, kurtosis 1');
  near(r.sharpe.probAboveZero, 0.99989, 1e-4, 'Φ(0.5·√59)');
  assert.ok(r.sortino.value > r.sharpe.value && r.sortino.ci.lo <= r.sortino.value);
});

test('beta and correlation to BTC pair each day with BTC\'s close-to-close', () => {
  const candles = Array.from({ length: 80 }, (_, i) => ({ t: D0 + i * DAY, close: 100 * (1 + (i % 2 ? 0.02 : -0.01)) ** i }));
  const btcRet = i => candles[i].close / candles[i - 1].close - 1;
  const series = Array.from({ length: 79 }, (_, k) => row(day(k + 1), 2 * btcRet(k + 1)));
  assert.deepEqual(btcBeta(series, candles), { n: 79, needs: 0, beta: 2, correlation: 1 });
  assert.deepEqual(btcBeta(series.slice(0, 10), candles), { n: 10, needs: 50 });
});

test('a hedged pair is one unit for win rate and expectancy; profit factor waits for 30 units; R only where a stop was set', () => {
  const pair = [trip(D0, { net: 5, netAfterFunding: 5, closeTime: D0 + 3 * HOUR }),
                trip(D0 + HOUR, { side: 'Short', net: -3, netAfterFunding: -3, entry: { yourStop: { price: 102 } } })];
  const s = unitStats([...pair, trip(D0 + DAY, { net: -1, netAfterFunding: -1 })]);
  assert.deepEqual([s.units, s.legs, s.wins, s.losses, s.net], [2, 3, 1, 1, 1]);
  assert.equal(s.winRate, 0.5);
  assert.ok(s.winCi.lo < 0.5 && s.winCi.hi > 0.5);
  assert.deepEqual(s.profitFactor, { needs: 28 });
  assert.deepEqual(s.r, { trips: 1, of: 3, avg: -1.5 }, 'lost $3 against $2 at risk');
  const many = Array.from({ length: 30 }, (_, i) => trip(D0 + i * DAY, { net: i % 3 ? 2 : -1, netAfterFunding: i % 3 ? 2 : -1 }));
  assert.deepEqual(unitStats(many).profitFactor, { needs: 0, value: 4 });
  assert.equal(unitStats([]).winRate, null);
});

test('a losing streak is judged against the same results shuffled', () => {
  const results = [...Array(20).fill(2), ...Array(12).fill(-1), ...Array(20).fill(2)];
  const s = streaksVsChance(results.map((net, i) => trip(D0 + i * DAY, { net, netAfterFunding: net })));
  assert.equal(s.longestLoss, 12);
  assert.equal(s.chance.loss.unusual, true);
  assert.deepEqual(s.current, { result: 'win', length: 20 });
  assert.deepEqual(streaksVsChance([]).current, null);
  const mixed = Array.from({ length: 40 }, (_, i) => (i % 2 ? 2 : -1));
  assert.equal(streaksVsChance(mixed.map((net, i) => trip(D0 + i * DAY, { net, netAfterFunding: net }))).chance.loss.unusual, false);
});

test('a curve from trips sums net by the local day each closed, with the fall from its peak in dollars', () => {
  const trips = [trip(D0 + 20 * HOUR, { net: 10, netAfterFunding: 10 }), trip(D0 + 22 * HOUR + 1800_000, { net: -4, netAfterFunding: -4 })];
  assert.deepEqual(dailyTripNet(trips, 60).map(r => [r.date, r.pnl, r.value, r.ddUsd]), [[day(0), 10, 10, 0], [day(1), -4, 6, -4]]);
});

test('records name the best and worst unit and day, and how many each was picked from', () => {
  const r = records([trip(D0, { net: 9, netAfterFunding: 9 }), trip(D0 + DAY, { symbol: 'BTCUSDT', net: -4, netAfterFunding: -4 })],
                    [{ date: day(0), pnl: 9 }, { date: day(1), pnl: -4 }, { date: day(2), pnl: 0 }]);
  assert.deepEqual([r.units, r.days, r.bestUnit.net, r.worstUnit.symbol, r.worstDay.date], [2, 2, 9, 'BTCUSDT', day(1)]);
});
