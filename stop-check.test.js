import test from 'node:test';
import assert from 'node:assert/strict';
import * as sc from './stop-check.js';

const order = x => ({ symbol: 'XUSDT', positionSide: 'LONG', side: 'Sell', type: 'Stop market', stopPrice: 90, ...x });
const long = { symbol: 'XUSDT', positionSide: 'LONG', side: 'Long' };

test('a leg\'s stop is its nearest closing stop order, never a take-profit, a limit or the other leg', () => {
  const orders = [
    order({ stopPrice: 85 }),
    order({ stopPrice: 95 }),
    order({ type: 'Take profit market', stopPrice: 99 }),
    order({ type: 'Limit', stopPrice: null, price: 99 }),
    order({ positionSide: 'SHORT', side: 'Buy', stopPrice: 98 }),
    order({ symbol: 'YUSDT', stopPrice: 99.5 })
  ];
  assert.deepEqual(sc.legStop(orders, long, 100), { price: 95, distancePct: 5 });
  assert.equal(sc.legStop(orders.slice(2), long, 100), null);
});

test('Hyperliquid orders match by pair, one-way', () => {
  const hl = [{ pair: 'SOL-PERP', side: 'Buy', type: 'Stop market', stopPrice: 220, exchange: 'hyperliquid' }];
  const leg = sc.legOf({ exchange: 'hyperliquid', pair: 'SOL-PERP', side: 'Short' });
  assert.deepEqual(sc.legStop(sc.stopOrders([], hl), leg, 200), { price: 220, distancePct: 10 });
});

test('the hit rate counts windows whose adverse move reached the distance', () => {
  const flat = Array.from({ length: 48 }, () => ({ close: 100, high: 101, low: 99 }));
  assert.deepEqual(sc.adverseHitRate(flat, 0.5, 'Long'), { rate: 1, windows: 24, independent: 1, days: 2 });
  assert.equal(sc.adverseHitRate(flat, 2, 'Long').rate, 0);
  const dip = flat.map((c, i) => (i === 30 ? { ...c, low: 95 } : c));
  const r = sc.adverseHitRate(dip, 3, 'Long');
  assert.equal(r.rate, 0.75, 'the dip at bar 30 sits in the windows opening at bars 6–23');
  assert.equal(sc.adverseHitRate(dip, 3, 'Short').rate, 0);
  assert.equal(sc.adverseHitRate(flat.slice(0, 10), 1, 'Long'), null);
});

test('verdicts: none, hedged, locks profit, tight by ratio or by hit rate, wide, ok', () => {
  const v = x => sc.stopVerdict({ suggestedPct: 2, entry: 100, side: 'Long', hedged: false, ...x }).verdict;
  assert.equal(v({ stop: null }), 'none');
  assert.equal(v({ stop: null, hedged: true }), 'hedged');
  assert.equal(v({ stop: { price: 103, distancePct: 1 } }), 'locks');
  assert.equal(v({ stop: { price: 99.2, distancePct: 0.8 } }), 'tight');
  assert.equal(v({ stop: { price: 98, distancePct: 2 }, hit: { rate: 0.7 } }), 'tight');
  assert.equal(v({ stop: { price: 95, distancePct: 5 } }), 'wide');
  assert.equal(v({ stop: { price: 97.5, distancePct: 2.5 } }), 'ok');
  assert.equal(sc.stopVerdict({ stop: { price: 97, distancePct: 1 }, suggestedPct: 2, entry: 100, side: 'Short' }).lockedPct, 3);
  assert.equal(sc.stopVsSuggested({ distancePct: 5 }, { distancePct: 2 }), 2.5);
  assert.equal(sc.stopVsSuggested(null, { distancePct: 2 }), null);
});

test('a stop at entry is breakeven, never too tight, even when its hit rate passes the tight line', () => {
  const atEntry = { stop: { price: 100, distancePct: 2.142 }, suggestedPct: 2.365, hit: { rate: 0.602 },
                 entry: 100, side: 'Short', hedged: false };
  assert.deepEqual(sc.stopVerdict(atEntry), { verdict: 'breakeven', ratio: 0.91, lockedPct: 0 });
});

test('the breakeven band is ±0.05% of entry on either side, and a stop beyond it is judged as usual', () => {
  const v = (price, side = 'Long') => sc.stopVerdict({ stop: { price, distancePct: 1 }, suggestedPct: 4,
    hit: { rate: 0.9 }, entry: 100, side }).verdict;
  assert.equal(v(99.96), 'breakeven', 'rounded to tick just under a long entry');
  assert.equal(v(100.04), 'breakeven');
  assert.equal(v(100.06), 'locks');
  assert.equal(v(99.94), 'tight', 'a long stop 0.06% under entry risks a loss');
  assert.equal(v(100.04, 'Short'), 'breakeven');
  assert.equal(v(99.94, 'Short'), 'locks');
  assert.equal(v(100.06, 'Short'), 'tight');
});
