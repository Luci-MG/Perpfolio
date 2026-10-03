import test from 'node:test';
import assert from 'node:assert/strict';
import { fundingBook, perDay, perSettlement } from './funding.js';

const NOW = Date.UTC(2026, 9, 3, 12);
const HOUR = 3_600_000;
const leg = o => ({ exchange: 'binance', symbol: 'BTCUSDT', side: 'Long', sizeUsd: 10000, fundingRate: 0.01,
                    fundingIntervalHours: 8, nextFundingTime: NOW + 2 * HOUR, ...o });

test('a positive rate charges longs and pays shorts, per settlement and per day by interval', () => {
  assert.equal(perSettlement(leg()), -1);
  assert.equal(perSettlement(leg({ side: 'Short' })), 1);
  assert.deepEqual([1, 4, 8].map(h => perDay(leg({ fundingIntervalHours: h }))), [-24, -6, -3]);
});

test('a hedged pair is one row netting to the rate on the difference in size', () => {
  const book = fundingBook({ legs: [leg(), leg({ side: 'Short', sizeUsd: 8000 })], now: NOW });
  assert.equal(book.rows.length, 1);
  const pair = book.rows[0];
  assert.equal(pair.pair, true);
  assert.equal(pair.perDay, -0.6, 'rate × (short − long) × 3 a day');
  assert.deepEqual([pair.long.perDay, pair.short.perDay], [-3, 2.4]);
  assert.equal(book.totals.pairs, 1);
});

test('rows run worst first; totals give the rate on gross notional and the share of equity', () => {
  const book = fundingBook({ legs: [leg({ symbol: 'SOLUSDT', side: 'Short' }), leg({ symbol: 'ETHUSDT', fundingIntervalHours: 4 })],
                             equity: 20000, now: NOW });
  assert.deepEqual(book.rows.map(r => r.symbol), ['ETHUSDT', 'SOLUSDT']);
  assert.equal(book.totals.perDay, -3);
  assert.equal(book.totals.aprOnGrossPct, -5.475);
  assert.equal(book.totals.pctOfEquityPerDay, -0.015);
  assert.equal(book.rows[0].aprPct, 21.9);
});

test('a leg at half its cap or more is flagged, and reads positive when it is receiving', () => {
  const meta = { BTCUSDT: { capPct: 0.3, floorPct: -0.3 } };
  const flag = rate => fundingBook({ legs: [leg({ fundingRate: rate })], meta, now: NOW }).rows[0].nearCap;
  assert.equal(flag(0.147), null);
  assert.deepEqual(flag(0.153), { share: 0.51, receiving: false });
  assert.equal(fundingBook({ legs: [leg({ side: 'Short', fundingRate: 0.2 })], meta, now: NOW }).rows[0].nearCap.receiving, true);
  assert.equal(fundingBook({ legs: [leg({ fundingRate: 0.9 })], now: NOW }).rows[0].nearCap, null, 'unlisted symbols use the 2% default');
});

test('the usual rate is the last seven days, special settlements left out, with the last charged rate', () => {
  const history = { BTCUSDT: [
    { t: NOW - 9 * 24 * HOUR, ratePct: 1 },
    { t: NOW - 16 * HOUR, ratePct: 0.01 }, { t: NOW - 8 * HOUR, ratePct: 0.03 },
    { t: NOW - 4 * HOUR, ratePct: 5, rateType: 'Special' }] };
  const usual = fundingBook({ legs: [leg()], history, now: NOW }).rows[0].usual;
  assert.deepEqual(usual, { avgPct: 0.02, points: [0.01, 0.03], lastCharged: { at: NOW - 8 * HOUR, ratePct: 0.03 } });
});

test('realised funding comes from the ledger by window and per symbol, and a large gap from the estimate is flagged', () => {
  const income = [{ incomeType: 'FUNDING_FEE', symbol: 'BTCUSDT', income: '-10', time: NOW - 2 * HOUR },
                  { incomeType: 'FUNDING_FEE', symbol: 'BTCUSDT', income: '-25', time: NOW - 3 * 24 * HOUR },
                  { incomeType: 'FUNDING_FEE', symbol: 'ETHUSDT', income: '4', time: NOW - 20 * 24 * HOUR },
                  { incomeType: 'REALIZED_PNL', symbol: 'BTCUSDT', income: '99', time: NOW - HOUR }];
  const book = fundingBook({ legs: [leg()], income, now: NOW });
  assert.deepEqual([book.realised.d1, book.realised.d7, book.realised.d30], [-10, -35, -31]);
  assert.equal(book.rows[0].realised7d, -35);
  assert.equal(book.realised.differsFromEstimate, true, '−$5/day realised against −$3/day estimated');
});

test('the next settlement sums the legs that settle first', () => {
  const book = fundingBook({ legs: [leg(), leg({ symbol: 'ETHUSDT', nextFundingTime: NOW + HOUR }),
                                    leg({ symbol: 'SOLUSDT', nextFundingTime: NOW + HOUR, side: 'Short' })], now: NOW });
  assert.deepEqual(book.next, { at: NOW + HOUR, amount: 0 });
  assert.equal(fundingBook({ legs: [], now: NOW }).next, null);
});
