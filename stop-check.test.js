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
  const stop = sc.legStop(orders, long, 100);
  assert.deepEqual([stop.price, stop.distancePct, stop.takeProfit], [95, 5, 99]);
  assert.equal(sc.legStop(orders.slice(2), long, 100), null);
});

test('Hyperliquid orders match by pair, one-way', () => {
  const hl = [{ pair: 'SOL-PERP', side: 'Buy', type: 'Stop market', stopPrice: 220, exchange: 'hyperliquid' }];
  const leg = sc.legOf({ exchange: 'hyperliquid', pair: 'SOL-PERP', side: 'Short' });
  const stop = sc.legStop(sc.stopOrders([], hl), leg, 200);
  assert.deepEqual([stop.price, stop.distancePct, stop.coverage], [220, 10, null], 'HL sizes are unknown');
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

test('a trailing stop and a stop-limit protect; a reduce-only limit is a take-profit, not a stop', () => {
  const long = { symbol: 'XUSDT', positionSide: 'LONG', side: 'Long', qty: 2 };
  const trail = order({ type: 'Trailing stop market', stopPrice: null, callbackRate: 1.5, activatePrice: 104 });
  const onlyTrail = sc.legStop([trail], long, 100);
  assert.deepEqual([onlyTrail.price, onlyTrail.trailing], [null, { callbackRate: 1.5, activatePrice: 104 }]);
  assert.equal(sc.stopVerdict({ stop: onlyTrail, entry: 100, side: 'Long' }).verdict, 'trailing');
  assert.equal(sc.legStop([order({ type: 'Stop', stopPrice: 94 })], long, 100).price, 94, 'stop-limit');
  const tpOnly = [order({ type: 'Limit', stopPrice: null, price: 110, reduceOnly: true })];
  assert.equal(sc.legStop(tpOnly, long, 100), null);
});

test('coverage sums the leg\'s stops, a closePosition stop covers all, and under 95% is partial', () => {
  const long = { symbol: 'XUSDT', positionSide: 'LONG', side: 'Long', qty: 2 };
  const verdict = orders => sc.stopVerdict({ stop: sc.legStop(orders, long, 100), entry: 100, side: 'Long' }).verdict;
  assert.equal(sc.legStop([order({ sizeRaw: 0.6 })], long, 100).coverage, 0.3);
  assert.equal(verdict([order({ sizeRaw: 0.6 })]), 'partial');
  assert.equal(verdict([order({ sizeRaw: 1 }), order({ sizeRaw: 1, stopPrice: 85 })]), 'set');
  assert.equal(sc.legStop([order({ sizeRaw: 0, closePosition: true })], long, 100).coverage, 1);
});

test('judged from orders alone, a fixed stop is set, breakeven or locks — never tight or wide', () => {
  const pos = { exchange: 'binance', symbol: 'XUSDT', positionSide: 'LONG', side: 'Long', sizeRaw: 1, entry: 100, mark: 110 };
  const at = stopPrice => sc.legProtection(pos, [order({ stopPrice, sizeRaw: 1 })]);
  assert.equal(at(99.2).verdict, 'set', 'a 0.8% stop would be too tight against any suggestion, but there is none');
  assert.equal(at(100).verdict, 'breakeven');
  assert.deepEqual([at(105).verdict, at(105).lockedPct], ['locks', 5]);
  assert.equal(sc.legProtection(pos, []), null);
});
