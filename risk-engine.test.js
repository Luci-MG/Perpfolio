import test from 'node:test';
import assert from 'node:assert/strict';
import * as re from './risk-engine.js';

// Real-shaped BTCUSDT brackets: each tier's cum keeps maintenance margin continuous
// across the notional caps.
const TIERED = [
  { notionalFloor: 0,      notionalCap: 50_000,    maintMarginRatio: 0.004, cum: 0    },
  { notionalFloor: 50_000, notionalCap: 250_000,   maintMarginRatio: 0.005, cum: 50   },
  { notionalFloor: 250_000, notionalCap: 1_000_000, maintMarginRatio: 0.01,  cum: 1300 }
];
const FLAT = [{ notionalFloor: 0, notionalCap: 1e9, maintMarginRatio: 0.01, cum: 0 }];

function pos(over = {}) {
  return {
    key: over.key || 'A:LONG', asset: 'A', symbol: 'AUSDT', positionSide: 'LONG',
    q: 10, entry: 100, mark: 100, leverage: 10, brackets: FLAT, notionalCoef: 1, ...over
  };
}

test('pickTier resolves notional bands and clamps past the last cap', () => {
  assert.equal(re.pickTier(TIERED, 0).maintMarginRatio, 0.004);
  assert.equal(re.pickTier(TIERED, 49_999).maintMarginRatio, 0.004);
  assert.equal(re.pickTier(TIERED, 50_000).maintMarginRatio, 0.005);
  assert.equal(re.pickTier(TIERED, 5_000_000).maintMarginRatio, 0.01);
  assert.equal(re.pickTier([], 100), null);
});

test('maintenance margin is continuous across tier boundaries', () => {
  for (const cap of [50_000, 250_000]) {
    const below = re.maintMargin(cap - 1e-6, re.pickTier(TIERED, cap - 1e-6));
    const above = re.maintMargin(cap, re.pickTier(TIERED, cap));
    assert.ok(Math.abs(below - above) < 1e-6, `discontinuity at ${cap}: ${below} vs ${above}`);
  }
});

test('evalPool computes equity, maintenance margin and buffer', () => {
  const pool = { collateral: 1000, positions: [pos()], orders: [] };
  const s = re.evalPool(pool, { A: 110 });
  assert.equal(s.equity, 1000 + 10 * (110 - 100));
  assert.equal(s.mm, 10 * 110 * 0.01);
  assert.equal(s.buffer, s.equity - s.mm);
  assert.equal(s.liquidated, false);
});

test('hedge-mode legs each carry maintenance margin, tiered on combined notional', () => {
  const pool = {
    collateral: 1000,
    positions: [
      pos({ key: 'L', q: 300, entry: 100, brackets: TIERED }),
      pos({ key: 'S', q: -300, entry: 100, positionSide: 'SHORT', brackets: TIERED })
    ],
    orders: []
  };
  const s = re.evalPool(pool, { A: 100 });
  // Combined notional 60k → tier 2 (0.005 / cum 50), applied per leg.
  const perLeg = 30_000 * 0.005 - 50;
  assert.equal(s.mm, perLeg * 2);
  assert.equal(s.equity, 1000, 'a flat hedge leaves equity untouched');
});

test('kill price matches the analytic single-position solve', () => {
  const W = 500, q = 10, entry = 100, mmr = 0.01;
  const pool = { collateral: W, positions: [pos({ q, entry })], orders: [] };
  // buffer = 0  →  W + q(P − entry) = |q|·P·mmr  →  P = (W − q·entry) / (q·mmr − q)
  const analytic = (W - q * entry) / (q * mmr - q);
  const { down } = re.killPrices(pool, 'A', { A: 100 });
  assert.ok(Math.abs(down - analytic) / analytic < 1e-4, `${down} vs ${analytic}`);
  assert.ok(re.evalPool(pool, { A: down }).buffer <= 1e-6);
});

test('a flat same-symbol hedge cannot be killed downward, only upward', () => {
  const pool = {
    collateral: 22,
    positions: [pos({ key: 'L', q: 10 }), pos({ key: 'S', q: -10, positionSide: 'SHORT' })],
    orders: []
  };
  const k = re.killPrices(pool, 'A', { A: 100 });
  assert.equal(k.down, null, 'falling prices shrink notional, so the pool only gets safer');
  assert.ok(k.minBufferDown > 0, 'an unbreached ray reports the worst buffer it reached');
  // mm = 0.2·P, equity flat at 22 → breach at P = 110.
  assert.ok(Math.abs(k.up - 110) < 0.05, `up kill ${k.up}`);
});

test('scanRay returns the FIRST breach even when a firing stop lifts the pool back out', () => {
  const pool = {
    collateral: 22,
    positions: [pos({ key: 'L', q: 10 }), pos({ key: 'S', q: -10, positionSide: 'SHORT' })],
    orders: [{ asset: 'A', positionSide: 'LONG', side: 'Sell', q: 10, trigger: 115, reduceOnly: true }]
  };
  const opts = { honorStops: true };
  const r = re.scanRay(pool, { A: 100 }, { A: 1 }, opts);

  assert.ok(r.breachLambda != null, 'breach must be found');
  const breachPrice = 100 * (1 + r.breachLambda);
  assert.ok(Math.abs(breachPrice - 110) < 0.5, `first breach at ${breachPrice}, expected ~110`);

  // Past the trigger the realised gain puts the pool back in the black — a bisection
  // anchored at the end of the ray would have reported this later root, or none.
  const recovered = re.evalPool(re.applyStops(pool, { A: 100 }, { A: 116 }).pool, { A: 116 });
  assert.ok(recovered.buffer > 0, `expected recovery past the stop, got ${recovered.buffer}`);
});

test('applyStops realises PnL into collateral and drops the closed leg', () => {
  const pool = {
    collateral: 100,
    positions: [pos({ q: 10, entry: 100 })],
    orders: [{ asset: 'A', positionSide: 'LONG', side: 'Sell', q: 10, trigger: 90, reduceOnly: true }]
  };
  const raw       = re.evalPool(pool, { A: 70 });
  const protected_ = re.applyStops(pool, { A: 100 }, { A: 70 });
  const stopped   = re.evalPool(protected_.pool, { A: 70 });

  assert.equal(protected_.fired.length, 1);
  assert.equal(stopped.positions.length, 0);
  assert.equal(protected_.pool.collateral, 100 + 10 * (90 - 100));
  assert.ok(stopped.buffer > raw.buffer, 'honouring the stop must leave more buffer');
});

test('applyStops ignores triggers the path never reaches', () => {
  const pool = {
    collateral: 100,
    positions: [pos()],
    orders: [{ asset: 'A', positionSide: 'LONG', side: 'Sell', q: 10, trigger: 50, reduceOnly: true }]
  };
  const { fired } = re.applyStops(pool, { A: 100 }, { A: 80 });
  assert.equal(fired.length, 0);
});

test('cascade closes positions until the pool is solvent and terminates', () => {
  const pool = {
    collateral: 100,
    positions: [
      pos({ key: 'L1', q: 10, entry: 100 }),
      pos({ key: 'L2', q: 5, entry: 100, positionSide: 'LONG' })
    ],
    orders: []
  };
  const c = re.cascade(pool, { A: 85 });
  assert.ok(c.closed.length >= 1);
  assert.ok(c.closed.length + c.survivors.length === 2);
  assert.ok(c.finalBuffer > 0 || c.wipedOut);
});

test('netDeltas nets opposing legs on the same asset', () => {
  const pool = {
    collateral: 0,
    positions: [pos({ key: 'L', q: 10 }), pos({ key: 'S', q: -4, positionSide: 'SHORT' })],
    orders: []
  };
  assert.equal(re.netDeltas(pool, { A: 100 }).A, 600);
});

test('adverse scenario points every asset against the pool net delta', () => {
  const pool = {
    collateral: 0,
    positions: [pos({ key: 'L', q: 10 }), pos({ key: 'S', asset: 'B', symbol: 'BUSDT', q: -10 })],
    orders: []
  };
  const dir = re.scenarioDir(pool, 'adverse', { prices: { A: 100, B: 100 } });
  assert.equal(dir.A, -1, 'net long → adverse is down');
  assert.equal(dir.B, 1,  'net short → adverse is up');
});

test('btcBeta scenario scales alt moves by beta', () => {
  const pool = { collateral: 0, positions: [pos({ asset: 'SOL', symbol: 'SOLUSDT' })], orders: [] };
  const dir = re.scenarioDir(pool, 'btcBeta', { betas: { SOL: 1.6 }, sign: -1 });
  assert.equal(dir.SOL, -1.6);
});

test('drainPer1Pct reports the buffer cost of a 1% move in each direction', () => {
  const pool = { collateral: 1000, positions: [pos({ q: 10, entry: 100 })], orders: [] };
  const d = re.drainPer1Pct(pool, 'A', { A: 100 });
  assert.ok(d.down < 0 && d.up > 0, 'a net long loses buffer when price falls');
  assert.ok(Math.abs(d.down + 10) < 0.2, `expected ≈ −$10 per −1%, got ${d.down}`);
});

test('beta and sigma behave on degenerate input', () => {
  const r = [0.01, -0.02, 0.03, -0.01];
  assert.ok(Math.abs(re.beta(r, r) - 1) < 1e-12);
  assert.equal(re.beta([], r), 1);
  assert.equal(re.stdev([1]), 0);
  assert.ok(re.dailySigmaPct(r) > 0);
});

test('evalPool falls back to each position mark when a price is missing', () => {
  const pool = { collateral: 100, positions: [pos()], orders: [] };
  assert.deepEqual(re.evalPool(pool, {}).positions[0].price, 100);
  assert.deepEqual(re.evalPool(pool, { A: 0 }).positions[0].price, 100);
});

test('free margin is equity minus initial margin and reserved holds', () => {
  const pool = { collateral: 1000, freeReserved: 50, positions: [pos({ q: 10, entry: 100, leverage: 10 })], orders: [] };
  const s = re.evalPool(pool, { A: 100 });
  assert.equal(s.im, 1000 / 10, 'notional 1000 at 10x');
  assert.equal(s.free, 1000 + 0 - 100 - 50);
  assert.equal(s.freeUsable, 850);
});

test('free margin floors at zero but the raw value stays negative for scanning', () => {
  const pool = { collateral: 100, freeReserved: 0, positions: [pos({ q: 10, entry: 100, leverage: 1 })], orders: [] };
  const s = re.evalPool(pool, { A: 100 });
  assert.ok(s.free < 0);
  assert.equal(s.freeUsable, 0);
});

test('the free-margin threshold is reached before liquidation', () => {
  const pool = { collateral: 800, freeReserved: 0, positions: [pos({ q: 10, entry: 100, leverage: 10 })], orders: [] };
  const liq  = re.killPrices(pool, 'A', { A: 100 });
  const free = re.killPrices(pool, 'A', { A: 100 }, { metric: 'free' });
  assert.ok(free.down > liq.down, `free margin should run out first: free ${free.down} vs liq ${liq.down}`);
  assert.ok(re.evalPool(pool, { A: free.down }).free <= 1e-6);
  assert.ok(re.evalPool(pool, { A: free.down }).buffer > 0, 'still solvent when capacity runs out');
});

test('drainPer1Pct reports free-margin sensitivity alongside buffer', () => {
  const pool = { collateral: 1000, freeReserved: 0, positions: [pos({ q: 10, entry: 100, leverage: 10 })], orders: [] };
  const d = re.drainPer1Pct(pool, 'A', { A: 100 });
  // +1%: uPnL +10, initial margin +1 → free +9
  assert.ok(Math.abs(d.freeUp - 9) < 0.01, `got ${d.freeUp}`);
  assert.ok(Math.abs(d.freeDown + 9) < 0.01, `got ${d.freeDown}`);
});

test('initialMargin falls back to 1x when leverage is missing', () => {
  assert.equal(re.initialMargin({ q: 2, leverage: 0 }, 50), 100);
});

test('killPricesBoth matches running each threshold separately', () => {
  const pool = { collateral: 900, freeReserved: 20,
                 positions: [pos({ q: 10, entry: 100, leverage: 10 }),
                             pos({ key: 'S', asset: 'B', symbol: 'BUSDT', q: -6, entry: 80, mark: 80, leverage: 5 })],
                 orders: [] };
  const base = { A: 100, B: 80 };
  const both = re.killPricesBoth(pool, 'A', base);
  const liq  = re.killPrices(pool, 'A', base);
  const free = re.killPrices(pool, 'A', base, { metric: 'free' });
  assert.equal(both.buffer.down, liq.down);
  assert.equal(both.buffer.up, liq.up);
  assert.equal(both.free.down, free.down);
  assert.equal(both.free.up, free.up);
  assert.ok(both.free.down > both.buffer.down, 'free margin runs out before liquidation');
});

test('a firing stop cannot hide a breach between grid samples', () => {
  // buffer = 22.02 − 0.2P crosses zero at 110.10; a take-profit at 110.20 realises +102
  // and lifts it to +11. The 0.25% grid lands on 110.00 and 110.25, straddling both.
  const hedged = {
    collateral: 22.02, freeReserved: 0,
    positions: [pos({ key: 'L', q: 10 }), pos({ key: 'S', q: -10, positionSide: 'SHORT' })],
    orders: [{ asset: 'A', positionSide: 'LONG', side: 'Sell', q: 10, trigger: 110.20, reduceOnly: true }]
  };
  const r = re.scanRay(hedged, { A: 100 }, { A: 1 }, { honorStops: true });
  const price = 100 * (1 + r.breachLambda);
  assert.ok(Math.abs(price - 110.10) < 0.01, `first breach ${price}, expected 110.10`);

  // the later naked-short breach exists too, and must not be the one reported
  assert.ok(price < 111, 'must not skip to the post-stop breach at 111.29');
});

test('a reduce-only order may only reduce the opposing side', () => {
  const longPool = {
    collateral: 1000, freeReserved: 0, positions: [pos({ q: 10 })],
    orders: [{ asset: 'A', positionSide: 'LONG', side: 'Buy', q: 10, trigger: 90, reduceOnly: true }]
  };
  assert.equal(re.applyStops(longPool, { A: 100 }, { A: 80 }).fired.length, 0,
    'a Buy cannot reduce a long');

  const ok = { ...longPool, orders: [{ ...longPool.orders[0], side: 'Sell' }] };
  assert.equal(re.applyStops(ok, { A: 100 }, { A: 80 }).fired.length, 1);
});

test('hedge-mode stops only touch their own leg', () => {
  const pool = {
    collateral: 1000, freeReserved: 0,
    positions: [pos({ key: 'L', q: 10, positionSide: 'LONG' }),
                pos({ key: 'S', q: -10, positionSide: 'SHORT' })],
    orders: [{ asset: 'A', positionSide: 'SHORT', side: 'Buy', q: 10, trigger: 120, reduceOnly: true }]
  };
  const r = re.applyStops(pool, { A: 100 }, { A: 130 });
  assert.equal(r.fired.length, 1);
  assert.equal(r.fired[0].positionSide, 'SHORT');
  assert.deepEqual(r.pool.positions.map(p => p.key), ['L']);
});

test('alignedReturns pairs candles by timestamp, not by recency', () => {
  const btc = Array.from({ length: 50 }, (_, i) => ({ t: i * 3600e3, close: 100 + i }));
  const alt = btc.map(c => ({ t: c.t, close: c.close * 2 }));
  const stale = alt.slice(0, 30);

  const full = re.alignedReturns(alt, btc);
  assert.equal(full.x.length, 49);
  assert.ok(Math.abs(re.beta(full.x, full.y) - 1) < 1e-9);

  const partial = re.alignedReturns(stale, btc);
  assert.equal(partial.x.length, 29, 'only the overlapping window is used');
  assert.ok(Math.abs(re.beta(partial.x, partial.y) - 1) < 1e-9, 'beta survives a stale tail');

  const gapped = re.alignedReturns([alt[0], alt[1], alt[2], alt[10], alt[11]], btc);
  assert.equal(gapped.x.length, 3, 'steps more than one candle apart are dropped');
});

test('alignedReturns tolerates junk input', () => {
  assert.deepEqual(re.alignedReturns(null, []), { x: [], y: [] });
  assert.deepEqual(re.alignedReturns([{ close: 1 }], [{ close: 1 }]), { x: [], y: [] });
});

test('a downside ray scans until price approaches zero, not an arbitrary cap', () => {
  assert.ok(Math.abs(re.rayCap({ A: -1 }) - 0.999) < 1e-9);
  assert.equal(re.rayCap({ A: 1 }), 3);
  assert.ok(Math.abs(re.rayCap({ A: 1, B: -2 }) - 0.4995) < 1e-9, 'capped by the steepest faller');
  assert.equal(re.rayCap({ A: -1 }, { lambdaMax: 0.5 }), 0.5);
});

test('a threshold past -90% is still found', () => {
  // buffer = 93.07 + (P − 100) − 0.01P reaches zero at P ≈ 7.0, a −93% move that the
  // old fixed ±90% scan range could not reach.
  const pool = { collateral: 93.07, freeReserved: 0,
                 positions: [pos({ q: 1, entry: 100, mark: 100, leverage: 10 })], orders: [] };
  const k = re.killPrices(pool, 'A', { A: 100 });
  assert.ok(k.down != null, 'a −93% threshold must be found');
  assert.ok(Math.abs(k.down - 7.0) < 0.15, `down kill ${k.down}, expected ≈7.0`);
  assert.ok(Math.abs(re.evalPool(pool, { A: k.down }).buffer) < 1e-4);
  assert.ok(k.scannedDownPct > 99, 'downside scanned to the price floor');
  assert.ok(k.scannedUpPct >= 300, 'upside scanned to +300%');
});

test('freezeTiers reproduces the exchange-style frozen-tier threshold', () => {
  const tiered = [
    { notionalFloor: 0,      notionalCap: 10_000, maintMarginRatio: 0.004, cum: 0  },
    { notionalFloor: 10_000, notionalCap: 1e9,    maintMarginRatio: 0.010, cum: 20 }
  ];
  // net short via a hedge, so the pool dies on the way up and crosses 10k notional
  const pool = {
    collateral: 1342, freeReserved: 0,
    positions: [pos({ key: 'L', q: 30, entry: 100, mark: 100, brackets: tiered }),
                pos({ key: 'S', q: -40, entry: 80, mark: 100, positionSide: 'SHORT', brackets: tiered })],
    orders: []
  };
  const live   = re.killPrices(pool, 'A', { A: 100 }).up;
  const pinned = re.killPrices(re.freezeTiers(pool, { A: 100 }), 'A', { A: 100 }).up;

  assert.ok(live != null && pinned != null);
  assert.ok(re.crossesTier(pool, 'A', { A: 100 }, live), 'threshold crosses a bracket boundary');
  assert.ok(Math.abs(pinned - 150.0) < 0.2, `frozen reading ${pinned}, expected ≈150`);
  assert.ok(Math.abs(live - 147.85) < 0.2, `re-tiered reading ${live}, expected ≈147.85`);
  assert.ok(live < pinned, 're-tiering raises maintenance margin, so it breaches sooner');
});

test('with per-side tiers, the frozen pool, the frozen scan and the closed form all tier each leg on its own', () => {
  const tiered = [
    { notionalFloor: 0,      notionalCap: 25_000, maintMarginRatio: 0.005, cum: 0   },
    { notionalFloor: 25_000, notionalCap: 1e9,    maintMarginRatio: 0.020, cum: 375 }
  ];
  const pool = { collateral: 2_000, freeReserved: 0, positions: [
    pos({ key: 'L', q: 400, entry: 100, mark: 100, brackets: tiered }),
    pos({ key: 'S', q: -200, entry: 100, mark: 100, positionSide: 'SHORT', brackets: tiered })
  ], orders: [] };
  const prices = { A: 100 }, perSide = { perSideTiers: true };
  const frozen = re.freezeTiers(pool, prices, perSide);
  assert.equal(re.evalPool(frozen, prices).mm, re.evalPool(pool, prices, perSide).mm);
  assert.notEqual(re.evalPool(re.freezeTiers(pool, prices), prices).mm, re.evalPool(pool, prices, perSide).mm);
  const analytic = re.liquidationPriceAnalytic(pool, 'A', prices, perSide);
  const k = re.killPrices(frozen, 'A', prices, perSide);
  const scan = [k.up, k.down].filter(v => v != null);
  const nearest = scan.reduce((b, v) => (Math.abs(v - analytic) < Math.abs(b - analytic) ? v : b), scan[0]);
  assert.ok(Math.abs(analytic - nearest) / nearest < 1e-6, `analytic ${analytic} vs frozen scan ${nearest}`);
  assert.equal(re.crossesTier(pool, 'A', prices, 60, perSide), true, 'the long leg drops under 25k');
  assert.equal(re.crossesTier(pool, 'A', prices, 60), false, 'combined, 36k stays in the upper tier');
});

test('pickTier answers the same for brackets in any order, and caches nothing that changes the answer', () => {
  const shuffled = [TIERED[2], TIERED[0], TIERED[1]];
  for (const n of [0, 49_999, 50_000, 300_000, 5e7]) {
    assert.equal(re.pickTier(shuffled, n), re.pickTier(shuffled, n));
    assert.equal(re.pickTier(shuffled, n).maintMarginRatio, re.pickTier(TIERED, n).maintMarginRatio);
  }
});

test('crossesTier is false when the tier is unchanged', () => {
  const pool = { collateral: 300, freeReserved: 0, positions: [pos({ q: 1 })], orders: [] };
  assert.equal(re.crossesTier(pool, 'A', { A: 100 }, 105), false);
  assert.equal(re.crossesTier(pool, 'ZZZ', { A: 100 }, 105), false);
});

test('a closePosition order closes the whole leg despite carrying zero quantity', () => {
  const pool = {
    collateral: 100, freeReserved: 0,
    positions: [pos({ q: 10, entry: 100 })],
    orders: [{ asset: 'A', positionSide: 'LONG', side: 'Sell', q: 0, trigger: 90,
               reduceOnly: true, closePosition: true }]
  };
  const r = re.applyStops(pool, { A: 100 }, { A: 80 });
  assert.equal(r.fired.length, 1);
  assert.equal(r.fired[0].closed, 10, 'the entire position closes');
  assert.equal(r.pool.positions.length, 0);
  assert.equal(r.pool.collateral, 100 + 10 * (90 - 100));
});

test('a zero-quantity order that is not closePosition is ignored', () => {
  const pool = {
    collateral: 100, freeReserved: 0, positions: [pos({ q: 10 })],
    orders: [{ asset: 'A', positionSide: 'LONG', side: 'Sell', q: 0, trigger: 90, reduceOnly: true }]
  };
  assert.equal(re.applyStops(pool, { A: 100 }, { A: 80 }).fired.length, 0);
});

test('overlapping reduce orders never close more than the position holds', () => {
  const pool = {
    collateral: 1000, freeReserved: 0, positions: [pos({ q: 10, entry: 100 })],
    orders: [
      { asset: 'A', positionSide: 'LONG', side: 'Sell', q: 8, trigger: 110, reduceOnly: true },
      { asset: 'A', positionSide: 'LONG', side: 'Sell', q: 8, trigger: 120, reduceOnly: true }
    ]
  };
  const r = re.applyStops(pool, { A: 100 }, { A: 130 });
  assert.equal(r.fired.reduce((s, f) => s + f.closed, 0), 10, 'only 10 units exist');
  assert.equal(r.pool.positions.length, 0);
});

test('a ray always evaluates at least its own cap', () => {
  const pool = { collateral: 100, freeReserved: 0, positions: [], orders: [] };
  const r = re.scanRay(pool, {}, {}, {});
  assert.equal(r.breachLambda, null);
  assert.equal(r.scannedTo, 3);

  // a direction vector so small the fine stride overshoots the cap must still be scanned
  const tiny = re.scanRay({ ...pool, positions: [pos({ q: 10, entry: 100 })] },
                          { A: 100 }, { A: 1e-7 }, {});
  assert.ok(tiny.scannedTo > 0);
});

test('closePositions credits realised PnL to collateral, leaving equity unchanged', () => {
  const pool = { collateral: 1000, freeReserved: 0,
    positions: [pos({ key: 'L', q: 10, entry: 100, mark: 80, leverage: 10 })], orders: [] };
  const before = re.evalPool(pool, { A: 80 });
  assert.equal(before.equity, 1000 + 10 * (80 - 100));   // 800

  const { pool: after, realized, notionalClosed, fees } = re.closePositions(pool, { A: 80 }, [{ key: 'L' }]);
  const st = re.evalPool(after, { A: 80 });
  assert.equal(realized, -200);
  assert.equal(notionalClosed, 800);
  assert.equal(fees, 0);
  assert.equal(st.equity, before.equity, 'equity must not move when a loss is realised');
  assert.equal(st.im, 0, 'initial margin is released');
  assert.equal(st.free - before.free, before.im, 'free margin rises by exactly the IM released');
});

test('closePositions handles partial closes and shorts', () => {
  const pool = { collateral: 1000, freeReserved: 0,
    positions: [pos({ key: 'S', q: -10, entry: 100, mark: 120, positionSide: 'SHORT', leverage: 10 })], orders: [] };
  const before = re.evalPool(pool, { A: 120 });
  const { pool: after, realized } = re.closePositions(pool, { A: 120 }, [{ key: 'S', qty: 4 }]);
  assert.equal(realized, -80, 'a short closed above entry realises a loss');
  assert.equal(after.positions[0].q, -6);
  assert.equal(re.evalPool(after, { A: 120 }).equity, before.equity);
});

test('closePositions charges fees against collateral and clamps oversized requests', () => {
  const pool = { collateral: 1000, freeReserved: 0,
    positions: [pos({ key: 'L', q: 10, entry: 100, mark: 100, leverage: 10 })], orders: [] };
  const { pool: after, fees, notionalClosed } = re.closePositions(pool, { A: 100 }, [{ key: 'L', qty: 999 }], 0.00045);
  assert.equal(notionalClosed, 1000, 'clamped to the position size');
  assert.equal(after.positions.length, 0);
  assert.ok(Math.abs(fees - 0.45) < 1e-9);
  assert.ok(Math.abs(re.evalPool(after, { A: 100 }).equity - (1000 - 0.45)) < 1e-9);
});

test('closing a matched same-symbol hedge frees margin without moving delta', () => {
  const pool = { collateral: 5000, freeReserved: 0, positions: [
    pos({ key: 'L', q: 10, entry: 90,  mark: 100, leverage: 10 }),
    pos({ key: 'S', q: -8, entry: 110, mark: 100, positionSide: 'SHORT', leverage: 10 })
  ], orders: [] };
  const before = re.evalPool(pool, { A: 100 });
  const grossBefore = re.grossNetDelta(pool, { A: 100 });

  const { pool: after } = re.closePositions(pool, { A: 100 }, [{ key: 'L', qty: 8 }, { key: 'S', qty: 8 }]);
  const st = re.evalPool(after, { A: 100 });

  assert.equal(st.equity, before.equity);
  assert.ok(Math.abs(re.grossNetDelta(after, { A: 100 }) - grossBefore) < 1e-9, 'net delta unchanged');
  assert.ok(Math.abs((st.free - before.free) - (before.im - st.im)) < 1e-9);
  assert.ok(st.im < before.im, 'both legs release margin');
});

test('grossNetDelta rises when a hedge leg is closed and falls when a naked leg is', () => {
  const pool = { collateral: 5000, freeReserved: 0, positions: [
    pos({ key: 'L', q: 10, entry: 100, mark: 100 }),
    pos({ key: 'S', q: -10, entry: 100, mark: 100, positionSide: 'SHORT' }),
    pos({ key: 'N', asset: 'B', symbol: 'BUSDT', q: 5, entry: 50, mark: 50 })
  ], orders: [] };
  const base = re.grossNetDelta(pool, { A: 100, B: 50 });
  const brokeHedge = re.grossNetDelta(re.closePositions(pool, { A: 100, B: 50 }, [{ key: 'S' }]).pool, { A: 100, B: 50 });
  const closedNaked = re.grossNetDelta(re.closePositions(pool, { A: 100, B: 50 }, [{ key: 'N' }]).pool, { A: 100, B: 50 });
  assert.ok(brokeHedge > base, 'breaking a hedge increases directional exposure');
  assert.ok(closedNaked < base, 'closing a naked leg reduces it');
});

test('deleverageCeiling bounds free margin by equity, whatever is closed', () => {
  const pool = { collateral: 10_000, freeReserved: 200, positions: [
    pos({ key: 'L', q: 100, entry: 150, mark: 100, leverage: 10 })   // −5,000 unrealised
  ], orders: [] };
  const c = re.deleverageCeiling(pool, { A: 100 }, { feeRate: 0 });
  assert.equal(c.equity, 5_000);
  assert.equal(c.maxFree, 5_000 - 200, 'equity minus reserved, regardless of position count');

  const closed = re.closePositions(pool, { A: 100 }, [{ key: 'L' }]).pool;
  assert.equal(re.evalPool(closed, { A: 100 }).freeUsable, c.maxFree, 'closing everything lands exactly on it');
});

test('deleveragePlan spends delta-neutral closes before trading exposure for margin', () => {
  const pool = { collateral: 20_000, freeReserved: 0, positions: [
    pos({ key: 'HL', q: 100, entry: 100, mark: 100, leverage: 10 }),
    pos({ key: 'HS', q: -100, entry: 100, mark: 100, positionSide: 'SHORT', leverage: 10 }),
    pos({ key: 'N', asset: 'B', symbol: 'BUSDT', q: 50, entry: 100, mark: 100, leverage: 10 })
  ], orders: [] };
  const plan = re.deleveragePlan(pool, { A: 100, B: 100 }, { objective: 'free', target: 1e9 });
  assert.equal(plan.steps[0].type, 'matched-hedge', 'the free lunch goes first');
  assert.equal(plan.steps[0].deltaShift, 0);
  assert.ok(plan.after.free > plan.before.free);
  assert.equal(plan.after.equity, plan.before.equity, 'equity is invariant across the plan');
});

test('deleveragePlan can be told not to break hedges', () => {
  const pool = { collateral: 5_000, freeReserved: 0, positions: [
    pos({ key: 'L', q: 100, entry: 100, mark: 100, leverage: 10 }),
    pos({ key: 'S', q: -60, entry: 100, mark: 100, positionSide: 'SHORT', leverage: 10 })
  ], orders: [] };
  const free = re.deleveragePlan(pool, { A: 100 }, { objective: 'free', target: 1e9 });
  assert.ok(free.steps.every(s => s.deltaShift <= 1), 'no step may increase gross exposure');
  assert.ok(free.steps.some(s => s.type === 'matched-hedge'));
});

test('deleveragePlan honours a realised-loss cap', () => {
  const pool = { collateral: 50_000, freeReserved: 0, positions: [
    pos({ key: 'A1', q: 100, entry: 200, mark: 100, leverage: 10 }),          // −10,000
    pos({ key: 'A2', asset: 'B', symbol: 'BUSDT', q: 100, entry: 150, mark: 100, leverage: 10 })  // −5,000
  ], orders: [] };
  const capped = re.deleveragePlan(pool, { A: 100, B: 100 },
    { objective: 'free', target: 1e9, maxRealizedLoss: 6_000, allowBreakingHedges: true });
  assert.ok(-capped.realized <= 6_000, `realised ${capped.realized} must stay within the cap`);
  assert.ok(capped.steps.length >= 1, 'the affordable close is still taken');

  const uncapped = re.deleveragePlan(pool, { A: 100, B: 100 }, { objective: 'free', target: 1e9, allowBreakingHedges: true });
  assert.ok(uncapped.steps.length > capped.steps.length, 'the cap genuinely restricts the plan');
  assert.ok(-uncapped.realized > 6_000);
});

test('a realised profit is never blocked by the loss cap', () => {
  const pool = { collateral: 1_000, freeReserved: 0, positions: [
    pos({ key: 'W', q: 100, entry: 50, mark: 100, leverage: 10 })   // +5,000 profit
  ], orders: [] };
  const plan = re.deleveragePlan(pool, { A: 100 }, { objective: 'free', target: 1e9, maxRealizedLoss: 0, allowBreakingHedges: true });
  assert.equal(plan.steps.length, 1, 'closing a winner must remain available under a zero loss cap');
  assert.ok(plan.realized > 0);
});

test('the buffer objective ranks by maintenance margin released', () => {
  const pool = { collateral: 3_000, freeReserved: 0, positions: [
    pos({ key: 'big', q: 200, entry: 100, mark: 100, leverage: 50,
          brackets: [{ notionalFloor: 0, notionalCap: 1e9, maintMarginRatio: 0.05, cum: 0 }] }),
    pos({ key: 'small', asset: 'B', symbol: 'BUSDT', q: 10, entry: 100, mark: 100, leverage: 2,
          brackets: [{ notionalFloor: 0, notionalCap: 1e9, maintMarginRatio: 0.004, cum: 0 }] })
  ], orders: [] };
  const plan = re.deleveragePlan(pool, { A: 100, B: 100 }, { objective: 'buffer', target: 1e9, maxSteps: 1, allowBreakingHedges: true });
  assert.equal(plan.steps[0].closes[0].key, 'big', 'the position carrying the most maintenance margin goes first');
  assert.ok(plan.steps[0].bufferGain > 0);
});

test('the planner refuses to break a hedge unless asked, and says why it stopped', () => {
  // the shape that matters: the matched pair realises a loss (short entered below the
  // long), while the long leg alone is in profit — so the only affordable close is the
  // one that shatters the hedge.
  const pool = { collateral: 60_000, freeReserved: 0, positions: [
    pos({ key: 'L', q: 100, entry: 50,  mark: 100, leverage: 10 }),                        // +5,000
    pos({ key: 'S', q: -100, entry: 10, mark: 100, positionSide: 'SHORT', leverage: 10 })  // −9,000
  ], orders: [] };                                                    // matched pair: −4,000

  const capped = re.deleveragePlan(pool, { A: 100 },
    { objective: 'buffer', target: 1e9, maxRealizedLoss: 100, feeRate: 0.001 });
  assert.equal(capped.steps.length, 0, 'no step may be taken');
  assert.ok(capped.blocked, 'it must report being blocked rather than act unsafely');
  assert.match(capped.blocked.reason, /realised-loss cap/);
  assert.ok(capped.blocked.unsafeGainAvailable > 0, 'and admit that an unsafe step existed');
  assert.ok(Math.abs(capped.blocked.capNeededForNextSafeStep - 4_020) < 1,
    `the cap must be raised to ${capped.blocked.capNeededForNextSafeStep}: the pair's loss plus its fees`);
  assert.equal(capped.allowBreakingHedges, false);

  // the same request, with hedge-breaking explicitly permitted
  const allowed = re.deleveragePlan(pool, { A: 100 },
    { objective: 'buffer', target: 1e9, maxRealizedLoss: 100, allowBreakingHedges: true });
  assert.ok(allowed.steps.length > 0);
  assert.ok(allowed.steps[0].deltaShift > 0, 'it now trades exposure for margin, as instructed');
});

test('exposure is never traded for margin by default', () => {
  const pool = { collateral: 30_000, freeReserved: 0, positions: [
    pos({ key: 'L', q: 100, entry: 100, mark: 100, leverage: 10 }),
    pos({ key: 'S', q: -100, entry: 100, mark: 100, positionSide: 'SHORT', leverage: 10 }),
    pos({ key: 'N', asset: 'B', symbol: 'BUSDT', q: 20, entry: 100, mark: 100, leverage: 10 })
  ], orders: [] };
  const plan = re.deleveragePlan(pool, { A: 100, B: 100 }, { objective: 'free', target: 1e9 });
  assert.ok(plan.steps.every(s => s.deltaShift <= 1), plan.steps.map(s => s.label + ' Δ' + s.deltaShift).join('; '));
});

test('liquidationPriceAnalytic solves the liquidation condition exactly', () => {
  const pool = { collateral: 1000, freeReserved: 0,
    positions: [pos({ key: 'L', q: 10, entry: 100, mark: 100, leverage: 10 })], orders: [] };
  const p = re.liquidationPriceAnalytic(pool, 'A', { A: 100 });
  // WB + q(P − E) = |q|·P·mmr  →  1000 + 10P − 1000 = 0.1P  →  P = 0
  // so with a 1000 cushion on a 1000 notional the long is liquidated at zero; add leverage
  const tight = { ...pool, collateral: 100 };
  const q = re.liquidationPriceAnalytic(tight, 'A', { A: 100 });
  const st = re.evalPool(tight, { A: q });
  assert.ok(Math.abs(st.equity - st.mm) < 1e-9, `equity ${st.equity} vs mm ${st.mm}`);
  assert.ok(q > 0 && q < 100, `a long liquidates below the mark, got ${q}`);
  assert.ok(p >= 0);
});

test('liquidationPriceAnalytic agrees with the ray scan over frozen tiers', () => {
  const tiered = [
    { notionalFloor: 0,      notionalCap: 10_000, maintMarginRatio: 0.004, cum: 0  },
    { notionalFloor: 10_000, notionalCap: 1e9,    maintMarginRatio: 0.010, cum: 20 }
  ];
  const pool = { collateral: 900, freeReserved: 0, positions: [
    pos({ key: 'L', q: 50, entry: 100, mark: 100, leverage: 10, brackets: tiered }),
    pos({ key: 'S', asset: 'B', symbol: 'BUSDT', q: -30, entry: 90, mark: 80, leverage: 5, brackets: tiered })
  ], orders: [] };
  const prices = { A: 100, B: 80 };

  for (const asset of ['A', 'B']) {
    const analytic = re.liquidationPriceAnalytic(pool, asset, prices);
    const k = re.killPricesBoth(re.freezeTiers(pool, prices), asset, prices).buffer;
    const scan = [k.up, k.down].filter(v => v != null);
    assert.ok(analytic != null, `${asset} must solve`);
    const nearest = scan.reduce((b, v) => Math.abs(v - analytic) < Math.abs(b - analytic) ? v : b, scan[0]);
    assert.ok(Math.abs(analytic - nearest) / nearest < 1e-6,
      `${asset}: analytic ${analytic} vs scan ${nearest}`);
  }
});

test('both legs of a same-symbol hedge share one liquidation price, as the exchange reports', () => {
  const pool = { collateral: 300, freeReserved: 0, positions: [
    pos({ key: 'L', q: 40, entry: 95,  mark: 100, leverage: 20 }),
    pos({ key: 'S', q: -30, entry: 110, mark: 100, positionSide: 'SHORT', leverage: 20 })
  ], orders: [] };
  const p = re.liquidationPriceAnalytic(pool, 'A', { A: 100 });
  assert.ok(p != null);
  const st = re.evalPool(re.freezeTiers(pool, { A: 100 }), { A: p });
  assert.ok(Math.abs(st.equity - st.mm) < 1e-9, 'one price satisfies the pool for both legs');
});

test('liquidationPriceAnalytic returns null when no price can liquidate the book', () => {
  // a flat hedge with zero maintenance rate has no solution: A = Σq − Σ|q|·mmr = 0
  const flat = [{ notionalFloor: 0, notionalCap: 1e9, maintMarginRatio: 0, cum: 0 }];
  const pool = { collateral: 500, freeReserved: 0, positions: [
    pos({ key: 'L', q: 10, entry: 100, mark: 100, brackets: flat }),
    pos({ key: 'S', q: -10, entry: 100, mark: 100, positionSide: 'SHORT', brackets: flat })
  ], orders: [] };
  assert.equal(re.liquidationPriceAnalytic(pool, 'A', { A: 100 }), null);
  assert.equal(re.liquidationPriceAnalytic(pool, 'NOPE', { A: 100 }), null);

  // a solve at or below zero means the same thing: no positive price liquidates the book
  const overFunded = { collateral: 100_000, freeReserved: 0,
    positions: [pos({ key: 'L', q: 10, entry: 100, mark: 100, leverage: 10 })], orders: [] };
  assert.equal(re.liquidationPriceAnalytic(overFunded, 'A', { A: 100 }), null,
    'collateral far above the notional cannot be liquidated at a positive price');
});

test('liquidationAfterCloses reports the survivors and flags what got closed', () => {
  const pool = { collateral: 800, freeReserved: 0, positions: [
    pos({ key: 'AL', q: 20, entry: 100, mark: 100, leverage: 10 }),
    pos({ key: 'AS', q: -20, entry: 100, mark: 100, positionSide: 'SHORT', leverage: 10 }),
    pos({ key: 'BL', asset: 'B', symbol: 'BUSDT', q: 30, entry: 50, mark: 50, leverage: 10 })
  ], orders: [] };
  const prices = { A: 100, B: 50 };

  const r = re.unwindOutcome(pool, prices, [{ key: 'AS', qty: 20 }], {});
  const rowA = r.rows.find(x => x.asset === 'A');
  const rowB = r.rows.find(x => x.asset === 'B');

  assert.equal(rowA.closed, false, 'the long leg survives, so A is still live');
  assert.ok(rowA.liqAfter != null && rowA.liqAfter !== rowA.liqBefore,
    'losing its hedge must move the survivor\'s liquidation price');
  assert.ok(rowB.liqAfter != null);
  assert.ok(Math.abs(rowB.pctAfter) > Math.abs(rowB.pctBefore),
    'an unrelated asset gains room from the maintenance margin released');

  const gone = re.unwindOutcome(pool, prices, [{ key: 'BL', qty: 30 }], {});
  assert.equal(gone.rows.find(x => x.asset === 'B').closed, true);
  assert.equal(gone.rows.find(x => x.asset === 'B').liqAfter, null);
});

test('closing a position never reduces an unrelated asset\'s room', () => {
  const pool = { collateral: 5000, freeReserved: 0, positions: [
    pos({ key: 'A1', q: 30, entry: 120, mark: 100, leverage: 10 }),
    pos({ key: 'B1', asset: 'B', symbol: 'BUSDT', q: 40, entry: 40, mark: 50, leverage: 10 }),
    pos({ key: 'C1', asset: 'C', symbol: 'CUSDT', q: -10, entry: 200, mark: 180, leverage: 10 })
  ], orders: [] };
  const prices = { A: 100, B: 50, C: 180 };
  for (const key of ['A1', 'B1', 'C1']) {
    const r = re.unwindOutcome(pool, prices, [{ key, qty: 1e9 }], {});
    for (const row of r.rows) {
      if (row.closed || row.roomGained == null) continue;
      assert.ok(row.roomGained > -1e-9,
        `closing ${key} must not cost ${row.asset} room (got ${row.roomGained})`);
    }
  }
});

test('the exact solve agrees with Binance\'s documented approximation', () => {
  // Binance publishes liqPrice ≈ Entry × (1 − 1/leverage + mmr) for a long whose collateral
  // is its own initial margin. The exact solve is Entry × (1 − 1/lev) / (1 − mmr); the two
  // agree to first order, which is an independent check on the algebra.
  for (const [entry, lev, mmr] of [[100, 10, 0.005], [62_400, 20, 0.004], [0.65, 5, 0.01]]) {
    const q = 10;
    const brackets = [{ notionalFloor: 0, notionalCap: 1e12, maintMarginRatio: mmr, cum: 0 }];
    const pool = { collateral: q * entry / lev, freeReserved: 0,
      positions: [pos({ key: 'L', q, entry, mark: entry, leverage: lev, brackets })], orders: [] };

    const exact  = re.liquidationPriceAnalytic(pool, 'A', { A: entry });
    const closed = entry * (1 - 1 / lev) / (1 - mmr);
    const approx = entry * (1 - 1 / lev + mmr);

    assert.ok(Math.abs(exact - closed) / closed < 1e-9, `exact ${exact} vs closed form ${closed}`);

    // The published form drops a second-order term, so the gap must be that term's size and
    // nothing more. This is also why the approximation is not what the tool reports: at
    // 5× leverage it is already 0.24% off, while the exact solve matches the exchange's own
    // reported price to 2e-8%.
    const predicted = mmr * (1 / lev) / (1 - 1 / lev + mmr);
    const actual    = Math.abs(exact - approx) / approx;
    assert.ok(actual < predicted * 1.1,
      `gap ${actual.toExponential(2)} exceeds the second-order term ${predicted.toExponential(2)}`);
    assert.ok(actual > predicted * 0.5,
      `gap ${actual.toExponential(2)} is smaller than the second-order term should allow`);
  }
});

test('a short liquidates above its entry, a long below', () => {
  const mk = (q, lev) => ({ collateral: Math.abs(q) * 100 / lev, freeReserved: 0,
    positions: [pos({ key: 'P', q, entry: 100, mark: 100, leverage: lev,
      positionSide: q > 0 ? 'LONG' : 'SHORT' })], orders: [] });
  assert.ok(re.liquidationPriceAnalytic(mk(10, 10), 'A', { A: 100 }) < 100);
  assert.ok(re.liquidationPriceAnalytic(mk(-10, 10), 'A', { A: 100 }) > 100);
});

test('walkBook averages across levels and reports what it could not fill', () => {
  const bids = [['100', '2'], ['99', '3'], ['98', '5']];
  const one = re.walkBook(bids, 2);
  assert.equal(one.vwap, 100);
  assert.equal(one.levelsUsed, 1);
  assert.equal(one.exhausted, false);

  const three = re.walkBook(bids, 4);
  assert.ok(Math.abs(three.vwap - (2 * 100 + 2 * 99) / 4) < 1e-9);
  assert.equal(three.levelsUsed, 2);

  const past = re.walkBook(bids, 20);
  assert.equal(past.filled, 10);
  assert.equal(past.remaining, 10);
  assert.equal(past.exhausted, true, 'must not invent a price for depth that is absent');
  assert.ok(past.vwap < 100 && past.vwap > 98);
});

test('walkBook is safe on junk input', () => {
  assert.equal(re.walkBook([], 5).vwap, null);
  assert.equal(re.walkBook(null, 5).vwap, null);
  assert.equal(re.walkBook([['100', '1']], 0).vwap, null);
  assert.equal(re.walkBook([['0', '1'], ['100', '2']], 1).vwap, 100, 'zero-priced levels ignored');
});

test('slippage grows with size and never shrinks', () => {
  const bids = [['100', '1'], ['99', '1'], ['98', '1'], ['97', '1']];
  let prev = 0;
  for (const qty of [1, 2, 3, 4]) {
    const c = re.exitCost(bids, qty, 100, 0);
    assert.ok(Math.abs(c.slipPct) >= prev - 1e-9, `slippage must be monotone in size at qty ${qty}`);
    prev = Math.abs(c.slipPct);
  }
  assert.ok(Math.abs(re.exitCost(bids, 4, 100, 0).slipPct) > 0);
});

test('exitCost separates slippage from commission', () => {
  const bids = [['99', '10']];
  const c = re.exitCost(bids, 10, 100, 0.0005);
  assert.ok(Math.abs(c.slipUsd - 10) < 1e-6, '1 point below mark on 10 units');
  assert.ok(Math.abs(c.feeUsd - 99 * 10 * 0.0005) < 1e-6);
  assert.ok(Math.abs(c.totalUsd - (c.slipUsd + c.feeUsd)) < 1e-9);
  assert.ok(c.slipPct < 0, 'selling into bids fills below the mark');
});

test('slippage is signed: a fill better than the mark lowers the cost, on either side', () => {
  assert.equal(re.exitCost([['101', '10']], 1, 100, 0, 'sell').slipUsd, -1);
  assert.equal(re.exitCost([['99', '10']], 1, 100, 0, 'buy').slipUsd, -1);
  assert.equal(re.exitCost([['102', '10']], 1, 100, 0, 'buy').slipUsd, 2);
  assert.equal(re.exitCost([['101', '10']], 1, 100, 0.001, 'sell').totalUsd, -0.899);
});

test('a zero-delta hedge keeps its PnL but not its margin footprint', () => {
  const pool = { collateral: 50_000, freeReserved: 0, positions: [
    pos({ key: 'L', q: 100, entry: 80,  mark: 100, leverage: 10 }),
    pos({ key: 'S', q: -100, entry: 120, mark: 100, positionSide: 'SHORT', leverage: 10 })
  ], orders: [] };

  const r = re.marginUnderMove(pool, { A: 100 }, [0, 100, 200]);
  const pnl = m => m.legs.reduce((s, l) => s + l.upnl, 0);

  // the pair's PnL is pinned at (E_short − E_long) × qty = 100 × (120 − 80) = 4,000
  for (const step of r.steps) {
    assert.ok(Math.abs(pnl(step) - 4000) < 1e-6, `PnL must not move at +${step.movePct}%`);
  }
  assert.equal(r.steps[0].equityChange, 0);
  assert.ok(Math.abs(r.steps[2].equityChange) < 1e-6, 'equity is untouched by the move');

  // margin, however, tracks notional and therefore price
  assert.ok(Math.abs(r.steps[1].imGrowth - 2) < 1e-6, 'double the price, double the margin');
  assert.ok(Math.abs(r.steps[2].imGrowth - 3) < 1e-6);
  assert.ok(r.steps[2].free < r.steps[0].free, 'free margin is consumed by the inflation alone');
});

test('marginUnderMove finds where free margin runs out before liquidation', () => {
  const pool = { collateral: 4_000, freeReserved: 0, positions: [
    pos({ key: 'L', q: 100, entry: 100, mark: 100, leverage: 10 }),
    pos({ key: 'S', q: -100, entry: 100, mark: 100, positionSide: 'SHORT', leverage: 10 })
  ], orders: [] };
  const r = re.marginUnderMove(pool, { A: 100 });
  assert.ok(r.freeGoneAtPct != null, 'a flat hedge still exhausts free margin on a big move');
  assert.ok(r.liquidatedAtPct == null || r.freeGoneAtPct < r.liquidatedAtPct,
    'free margin always goes first');
});

test('per-leg attribution adds up to the pool total', () => {
  const pool = { collateral: 20_000, freeReserved: 0, positions: [
    pos({ key: 'L', q: 50, entry: 100, mark: 100, leverage: 10 }),
    pos({ key: 'S', q: -30, entry: 110, mark: 100, positionSide: 'SHORT', leverage: 10 }),
    pos({ key: 'B', asset: 'B', symbol: 'BUSDT', q: 20, entry: 50, mark: 50, leverage: 5 })
  ], orders: [] };
  for (const step of re.marginUnderMove(pool, { A: 100, B: 50 }, [0, 50]).steps) {
    const legIm = step.legs.reduce((s, l) => s + l.im, 0);
    const legMm = step.legs.reduce((s, l) => s + l.mm, 0);
    assert.ok(Math.abs(legIm - step.im) < 0.02, 'leg IM must sum to pool IM');
    assert.ok(Math.abs(legMm - step.mm) < 0.02, 'leg MM must sum to pool MM');
  }
});

test('liquidationDetail reports how sensitive the solve is to equity', () => {
  // a lopsided book: plenty of net delta, so the coefficient is large and the price stable
  const directional = { collateral: 500, freeReserved: 0,
    positions: [pos({ key: 'L', q: 10, entry: 100, mark: 100, leverage: 10 })], orders: [] };
  const d1 = re.liquidationDetail(directional, 'A', { A: 100 });
  assert.ok(d1.price > 0);
  assert.equal(d1.illConditioned, false);

  assert.ok(d1.multipleOfMark < 3);

  // a near-flat hedge pushes the solve far outside any observed price: an extrapolation,
  // not a forecast, and it has to be labelled as one
  const flat = { collateral: 5000, freeReserved: 0, positions: [
    pos({ key: 'L', q: 100.0, entry: 100, mark: 100, leverage: 10 }),
    pos({ key: 'S', q: -99.9, entry: 100, mark: 100, positionSide: 'SHORT', leverage: 10 })
  ], orders: [] };
  const d2 = re.liquidationDetail(flat, 'A', { A: 100 });
  assert.ok(Math.abs(d2.coefficient) < Math.abs(d1.coefficient), 'the coefficient collapses');
  assert.ok(d2.sensitivityPerDollar > d1.sensitivityPerDollar, 'and sensitivity rises');
  assert.ok(d2.multipleOfMark > 3, `solve sits at ${d2.multipleOfMark}x the mark`);
  assert.equal(d2.farAway, true);
  assert.equal(d2.illConditioned, true, 'which has to be admitted, not hidden');
  assert.ok(d2.movePerOnePctEquity > 0);
});

test('a solve close to the mark is reported as trustworthy', () => {
  const pool = { collateral: 150, freeReserved: 0,
    positions: [pos({ key: 'L', q: 10, entry: 100, mark: 100, leverage: 10 })], orders: [] };
  const d = re.liquidationDetail(pool, 'A', { A: 100 });
  assert.ok(d.multipleOfMark > 0.33 && d.multipleOfMark < 3);
  assert.equal(d.farAway, false);
  assert.equal(d.illConditioned, false);
});

test('liquidationPriceAnalytic still returns just the price', () => {
  const pool = { collateral: 500, freeReserved: 0,
    positions: [pos({ key: 'L', q: 10, entry: 100, mark: 100, leverage: 10 })], orders: [] };
  const p = re.liquidationPriceAnalytic(pool, 'A', { A: 100 });
  assert.equal(p, re.liquidationDetail(pool, 'A', { A: 100 }).price);
  assert.equal(re.liquidationPriceAnalytic(pool, 'NOPE', { A: 100 }), null);
});

test('a hedge crossing a bracket floor cannot hide a breach just below it', () => {
  const tiers = [
    { notionalFloor: 0, notionalCap: 50000, maintMarginRatio: 0.004, cum: 0 },
    { notionalFloor: 50000, notionalCap: 250000, maintMarginRatio: 0.005, cum: 50 },
    { notionalFloor: 250000, notionalCap: 1e6, maintMarginRatio: 0.01, cum: 1300 }
  ];
  const leg = (key, q, positionSide) => ({ key, asset: 'A', symbol: 'AUSDT', positionSide, q,
    entry: 100, mark: 100, leverage: 10, brackets: tiers });
  const pool = { collateral: 282.968, positions: [leg('L', 230, 'LONG'), leg('S', -250, 'SHORT')], orders: [] };
  assert.ok(re.evalPool(pool, { A: 104.16 }).buffer < 0);
  assert.ok(re.evalPool(pool, { A: 104.17 }).buffer > 0);
  const k = re.killPrices(pool, 'A', { A: 100 });
  assert.ok(Math.abs(k.up - 104.15) < 0.01, `up ${k.up}`);
});

test('adding to a position averages its entry and grows it in its own direction', () => {
  const pool = { collateral: 1000, positions: [
    { key: 'X:LONG', q: 2, entry: 100 }, { key: 'X:SHORT', q: -1, entry: 120 }] };
  const long = re.addToPosition(pool, 'X:LONG', 2, 80).positions[0];
  assert.equal(long.q, 4);
  assert.equal(long.entry, 90);
  const short = re.addToPosition(pool, 'X:SHORT', 1, 100).positions[1];
  assert.equal(short.q, -2);
  assert.equal(short.entry, 110);
  assert.deepEqual(re.addToPosition(pool, 'Y:LONG', 1, 1), pool);
  assert.equal(pool.positions[0].q, 2, 'the input pool is not mutated');
});

const hedge = (asset, q, over = {}) => [
  pos({ key: `${asset}L`, asset, symbol: `${asset}USDT`, q, entry: 100, mark: 100, leverage: 10, ...over }),
  pos({ key: `${asset}S`, asset, symbol: `${asset}USDT`, q: -q, entry: 100, mark: 100, positionSide: 'SHORT', leverage: 10, ...over })
];
const flatBook = (bid, ask, size = 1e6) => ({ bids: [[String(bid), String(size)]], asks: [[String(ask), String(size)]] });

test('the last step is cut to the size that lands on the target', () => {
  const pool = { collateral: 20_000, freeReserved: 0, positions: hedge('A', 100), orders: [] };
  const plan = re.deleveragePlan(pool, { A: 100 }, { objective: 'free', target: 18_500 });
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].partial, true);
  assert.ok(Math.abs(plan.after.free - 18_500) < 0.5, `landed at ${plan.after.free}`);
  assert.ok(Math.abs(plan.steps[0].closes[0].qty - 25) < 0.01, 'a pair frees 20 per unit, so 25 units');
  assert.deepEqual(plan.closes.map(c => c.key), ['AL', 'AS']);
});

test('steps are ranked by gain per dollar of exit cost at the live book', () => {
  const pool = { collateral: 40_000, freeReserved: 0, positions: [...hedge('A', 100), ...hedge('B', 100)], orders: [] };
  const books = { A: flatBook(95, 105), B: flatBook(100, 100) };
  const plan = re.deleveragePlan(pool, { A: 100, B: 100 },
    { objective: 'free', target: 38_500, books, fees: { A: 0.0005, B: 0.0005 } });
  assert.deepEqual(plan.steps[0].closes.map(c => c.key), ['BL', 'BS'], 'the deep book is the cheaper exit');
  assert.ok(plan.steps[0].slip === 0 && plan.steps[0].fees > 0);
  assert.ok(Math.abs(plan.cost - plan.steps.reduce((a, x) => a + x.cost, 0)) < 1e-9);
  assert.deepEqual(plan.steps[1].closes.map(c => c.key), ['AL', 'AS'], 'the dearer hedge only for what is still missing');
  assert.equal(plan.steps[1].partial, true);
});

test('a close the book cannot fill is taken only when nothing else qualifies', () => {
  const pool = { collateral: 40_000, freeReserved: 0, positions: [...hedge('A', 100), ...hedge('B', 100)], orders: [] };
  const books = { A: flatBook(99, 101), B: flatBook(100, 100, 5) };
  const both = re.deleveragePlan(pool, { A: 100, B: 100 }, { objective: 'free', target: 39_000, books, feeRate: 0.0005 });
  assert.deepEqual(both.steps[0].closes.map(c => c.key), ['AL', 'AS'], 'the thin book loses despite costing less');

  const only = { ...pool, positions: hedge('B', 100) };
  const plan = re.deleveragePlan(only, { B: 100 }, { objective: 'free', target: 1e9, books, feeRate: 0.0005 });
  assert.equal(plan.steps[0].thin, true);
});

test('closing one side of a cross-coin hedge is refused on its BTC-beta exposure', () => {
  const pool = { collateral: 20_000, freeReserved: 0, positions: [
    pos({ key: 'AL', q: 100, entry: 100, mark: 100, leverage: 10 }),
    pos({ key: 'BS', asset: 'B', symbol: 'BUSDT', q: -100, entry: 100, mark: 100, positionSide: 'SHORT', leverage: 10 })
  ], orders: [] };
  const prices = { A: 100, B: 100 }, betas = { A: 1, B: 1 };
  const plan = re.deleveragePlan(pool, prices, { objective: 'free', target: 1e9, betas });
  assert.equal(plan.steps.length, 0);
  assert.match(plan.blocked.reason, /naked exposure/);
  assert.equal(plan.before.betaNet, 0);

  const allowed = re.deleveragePlan(pool, prices, { objective: 'free', target: 1e9, betas, allowBreakingHedges: true });
  assert.ok(allowed.steps[0].betaShift > 0 && allowed.steps[0].deltaShift < 0, 'per coin it reads as de-risking');
});

test('the liquidation objective closes until the nearest liquidation clears the target', () => {
  const pool = { collateral: 300, freeReserved: 0, positions: [pos({ key: 'L', q: 10, entry: 100, mark: 100, leverage: 10 })], orders: [] };
  const plan = re.deleveragePlan(pool, { A: 100 }, { objective: 'liq', target: 40 });
  assert.ok(plan.before.nearestLiqPct < 40);
  assert.equal(plan.targetMet, true);
  assert.ok(Math.abs(plan.after.nearestLiqPct - 40) < 0.01, `landed at ${plan.after.nearestLiqPct}`);
  assert.equal(plan.steps[0].partial, true);
});

test('the exposure tolerance is half a percent of gross notional', () => {
  const pool = { collateral: 30_000, freeReserved: 0, positions: [
    ...hedge('A', 100), pos({ key: 'N', asset: 'B', symbol: 'BUSDT', q: 20, entry: 100, mark: 100, leverage: 10 })
  ], orders: [] };
  assert.equal(re.deleveragePlan(pool, { A: 100, B: 100 }, { target: 1e9 }).deltaTolerance, 110);
});

test('unwindOutcome prices the exit at the book and reports BTC-beta exposure', () => {
  const pool = { collateral: 20_000, freeReserved: 0, positions: [
    pos({ key: 'AL', q: 100, entry: 100, mark: 100, leverage: 10 }),
    pos({ key: 'BS', asset: 'B', symbol: 'BUSDT', q: -50, entry: 100, mark: 100, positionSide: 'SHORT', leverage: 10 })
  ], orders: [] };
  const prices = { A: 100, B: 100 };
  const r = re.unwindOutcome(pool, prices, [{ key: 'AL', qty: 100 }],
    { books: { A: flatBook(99, 101) }, fees: { A: 0.001 }, betas: { A: 1, B: 2 } });
  assert.equal(r.cost.slip, 100);
  assert.ok(Math.abs(r.cost.fee - 9.9) < 1e-9);
  assert.ok(Math.abs(r.after.equity - (r.before.equity - 109.9)) < 1e-9, 'equity pays the exit cost and nothing else');
  assert.equal(r.betaBefore, 0);
  assert.equal(r.betaAfter, -10_000);
  assert.equal(r.rows.find(x => x.asset === 'A').closed, true);
});

const twoLongs = (collateral = 400) => ({ collateral, freeReserved: 0, positions: [
  pos({ key: 'AL', q: 10, entry: 100, mark: 100, leverage: 10 }),
  pos({ key: 'BL', asset: 'B', symbol: 'BUSDT', q: 10, entry: 100, mark: 100, leverage: 10 })
], orders: [] });

test('marginGrid meets killPrices on each axis', () => {
  const pool = twoLongs(), marks = { A: 100, B: 100 };
  const g = re.marginGrid(pool, marks, marks, 'A', 'B', { range: 50, steps: 41 });
  const zero = g.ys.indexOf(0);
  assert.equal(g.xs[zero], 0);
  const kill = re.killPrices(pool, 'A', marks).downPct;
  const firstLiquidated = g.xs.filter((x, i) => g.cells[zero][i].liquidated).reduce((m, x) => Math.max(m, x), -Infinity);
  assert.ok(firstLiquidated <= kill && kill - firstLiquidated < 2.5 + 1e-9, `grid edge ${firstLiquidated} vs kill ${kill}`);
  assert.ok(g.cells.every(row => row.every(c => isFinite(c.usedPct))));
});

test('marginGrid finds the closest joint move to liquidation on the edge', () => {
  const pool = twoLongs(), marks = { A: 100, B: 100 };
  const { nearest } = re.marginGrid(pool, marks, marks, 'A', 'B', { range: 30, steps: 41 });
  assert.ok(Math.abs(nearest.xPct - nearest.yPct) < 1e-6, 'two equal longs fail together, on the diagonal');
  const s = re.evalPool(pool, { A: 100 * (1 + nearest.xPct / 100), B: 100 * (1 + nearest.yPct / 100) });
  assert.ok(Math.abs(s.buffer) < 1e-6, `buffer at the point ${s.buffer}`);
  const alone = re.killPrices(pool, 'A', marks).downPct;
  assert.ok(Math.hypot(nearest.xPct, nearest.yPct) < Math.abs(alone), 'the joint move is closer than either coin alone');
});

test('a book of same-symbol hedges has no liquidation on the map', () => {
  const pool = { collateral: 2_000, freeReserved: 0, positions: [...hedge('A', 10), ...hedge('B', 10)], orders: [] };
  const g = re.marginGrid(pool, { A: 100, B: 100 }, { A: 100, B: 100 }, 'A', 'B', { range: 30, steps: 21 });
  assert.equal(g.nearest, null);
  assert.ok(g.cells.every(row => row.every(c => !c.liquidated)));
});

test('marginGrid honours reduce-only stops when asked, and never moves a price below −99%', () => {
  const pool = { ...twoLongs(2_000), orders: [{ asset: 'A', positionSide: 'LONG', side: 'Sell', q: 10, trigger: 90, reduceOnly: true }] };
  const marks = { A: 100, B: 100 };
  const plain = re.marginGrid(pool, marks, marks, 'A', 'B', { range: 120, steps: 11 });
  const stopped = re.marginGrid(pool, marks, marks, 'A', 'B', { range: 120, steps: 11, honorStops: true });
  assert.equal(plain.xs[0], -99);
  assert.ok(stopped.cells[5][0].buffer > plain.cells[5][0].buffer, 'the stop caps the long\'s loss');
});
