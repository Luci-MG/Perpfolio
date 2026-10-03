import test from 'node:test';
import assert from 'node:assert/strict';
import { costSummary, feeCheck, makerTrend, symbolCosts, walletLedger, weeklyCosts } from './costs.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MON = Date.UTC(2026, 5, 1);
const trip = (closeTime, o = {}) => ({ symbol: 'SOLUSDT', closeTime, commission: 1, funding: -2, realized: 100, tradedNotional: 10_000,
  makerNotional: 4000, bnbFee: 0, ...o });
const row = (time, incomeType, amount) => ({ time, incomeType, income: String(amount), asset: 'USDT' });

test('costs are in dollars and basis points of notional; funding paid and received stay apart; maker share is by notional', () => {
  const s = costSummary([trip(MON), trip(MON + DAY, { funding: 3, makerNotional: 6000 }), trip(MON + 2 * DAY, { funding: null })]);
  assert.deepEqual([s.trips, s.traded, s.fees, s.fundingPaid, s.fundingReceived, s.fundingUnknown], [3, 30_000, 3, -2, 3, 1]);
  assert.deepEqual([s.feesBp, s.fundingBp, s.makerShare], [1, 0.33, 0.4667]);
  assert.equal(s.feeDragPct, 1, '3 of 300 gross');
});

test('fee drag is left out when gross is under twice the costs', () => {
  assert.equal(costSummary([trip(MON, { realized: 5, commission: 3, funding: 0 })]).feeDragPct, null);
  assert.equal(costSummary([trip(MON, { realized: -50 })]).feeDragPct, null);
});

test('BNB fees are priced at the day\'s close and never mixed into dollar fees; unpriced they stay null', () => {
  const t = trip(MON, { commission: 0, bnbFee: 0.01 });
  const priced = costSummary([t], { bnbPrice: () => 600 });
  assert.deepEqual([priced.fees, priced.bnb.fee, priced.bnb.usd, priced.feesBp], [0, 0.01, 6, 6]);
  assert.equal(costSummary([t]).bnb.usd, null);
});

test('the fee rate paid is compared with what the account\'s maker and taker rates imply for its maker share', () => {
  const f = feeCheck([trip(MON, { commission: 3.5 }), trip(MON, { symbol: 'XUSDT' })], { SOLUSDT: { maker: 0.0002, taker: 0.0005 } });
  assert.deepEqual([f.effectiveBp, f.expectedBp, f.pricedShare, f.assumed], [3.5, 3.8, 0.5, false]);
  assert.deepEqual(f.rates.SOLUSDT, { makerBp: 2, takerBp: 5 });
});

test('weekly costs fall in local weeks starting Monday; maker share trends over eight weeks', () => {
  const weeks = weeklyCosts([trip(MON + 6 * DAY + 23.5 * HOUR), trip(MON + 2 * DAY, { funding: 4 })], 60);
  assert.deepEqual(weeks, [{ week: '2026-06-01', fees: 1, paid: 0, received: 4 }, { week: '2026-06-08', fees: 1, paid: -2, received: 0 }]);
  const trend = makerTrend([trip(MON - 3 * DAY)], MON);
  assert.equal(trend.length, 8);
  assert.deepEqual(trend.at(-1), { share: 0.4, trips: 1 });
  assert.equal(trend[0], null);
});

test('by symbol, receipts survive beside payments, and everything past the top ten is one total', () => {
  const trips = Array.from({ length: 12 }, (_, i) => trip(MON, { symbol: `S${i}`, commission: i + 1, funding: i % 2 ? 1 : -1 }));
  const c = symbolCosts(trips);
  assert.deepEqual([c.fees.top.length, c.fees.others], [10, { symbols: 2, value: 3 }]);
  assert.deepEqual([c.paid.top.length, c.received.top.length], [6, 6]);
  assert.ok(c.received.top.every(e => e.value > 0));
});

test('the wallet ledger walks back from the last sync, lists other income, and its checks reconcile or say by how much', () => {
  const income = [row(MON, 'TRANSFER', 1000), row(MON + HOUR, 'REALIZED_PNL', 50), row(MON + HOUR, 'COMMISSION', -2),
                  row(MON + 2 * HOUR, 'FUNDING_FEE', -1), row(MON + 3 * HOUR, 'COMMISSION_REBATE', 0.5), row(MON + 5 * DAY, 'REALIZED_PNL', 9)];
  const l = walletLedger({ income, from: 0, walletAtSync: { wallet: 1547.5, at: MON + DAY }, walletLive: 1550,
                           fills: [[MON - DAY, 999, 9], [MON + HOUR, 50, 2]], unmatched: { rows: 1, amount: -1 },
                           snapshots: [{ t: MON + 60_000, binance: { wallet: 1500 } }] });
  assert.deepEqual([l.start, l.transfers, l.realised, l.fees, l.funding, l.wallet, l.sinceSync], [500, 1000, 50, -2, -1, 1547.5, 2.5]);
  assert.deepEqual(l.other, [{ type: 'COMMISSION_REBATE', amount: 0.5 }]);
  assert.deepEqual(l.checks.map(c => [c.id, c.checked, c.diff]), [['start', true, 0], ['realised', true, 0], ['fees', true, 0], ['funding', true, -1]],
    'fills from before the ledger begins are left out');
  assert.equal(walletLedger({ income }), null, 'nothing to walk back from before the first sync');
});
