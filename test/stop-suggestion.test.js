import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestStop } from '../lib/stop-suggestion.js';

const HOUR = 3_600_000;
const candles = Array.from({ length: 60 }, (_, i) => {
  const close = 100 + Math.sin(i / 3);
  return { t: i * HOUR, open: close, high: close + 1, low: close - 1, close, volume: 1 };
});
const position = o => ({ exchange: 'binance', pair: 'X/USDT', side: 'Long', entry: 100, mark: 100, sizeUsd: 1000, ...o });
const fundingAdj = p => suggestStop(position(p), { candles, candlesBackfilled: false, btcCandles: null, btcAtrHistory: [],
                                                   totalEquity: 10_000, riskPct: 0.01, k: 1.5 }).result.layers.fundingAdj;

test('the funding layer reads every rate as its 8-hour equivalent, whatever the settlement interval', () => {
  const same = [[0.04, 8], [0.02, 4], [0.005, 1]].map(([fundingRate, fundingIntervalHours]) => fundingAdj({ fundingRate, fundingIntervalHours }));
  assert.deepEqual(same, [1.25, 1.25, 1.25]);
  assert.equal(fundingAdj({ fundingRate: 0.04 }), 1.25, 'no interval reads as 8 hours');
});
