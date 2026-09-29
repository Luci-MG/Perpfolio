import test from 'node:test';
import assert from 'node:assert/strict';
import * as vol from './vol-estimator.js';

// deterministic correlated return series
function series(n, seed, { beta = 1, noise = 0, base = null } = {}) {
  const out = [];
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const r = base ? base[i] * beta : ((s / 2147483648) - 0.5) * 0.02;
    s = (s * 1103515245 + 12345) % 2147483648;
    out.push(r + (noise ? ((s / 2147483648) - 0.5) * noise : 0));
  }
  return out;
}

test('assessHedgePair recovers beta and calls a tight pair intact', () => {
  const x = series(300, 7);
  const y = series(300, 7, { beta: 1.5, base: x });
  const h = vol.assessHedgePair({ x, y, longAsset: 'BTC', shortAsset: 'ETH' });
  assert.equal(h.status, 'intact');
  assert.equal(h.warning, null);
  assert.ok(Math.abs(h.beta - 1.5) < 0.01, `beta ${h.beta}`);
  assert.ok(h.corrRecent > 0.99);
  assert.equal(h.impliedShort, undefined, 'notional-derived fields belong at book level');
  assert.equal(h.residualDelta, undefined);
});

test('assessHedgePair flags a broken hedge', () => {
  const x = series(300, 11);
  const y = series(300, 99);                       // unrelated
  const h = vol.assessHedgePair({ x, y, longAsset: 'BTC', shortAsset: 'DOGE' });
  assert.equal(h.status, 'broken');
  assert.match(h.warning, /no longer hedging/);
});

test('assessHedgePair flags a decaying hedge', () => {
  const base = series(500, 3);
  const tight = base.map(v => v * 1.2);
  const x = base;
  //  correlated for the first 428 bars, decoupled over the most recent 72
  const y = tight.slice(0, 428).concat(series(72, 555));
  const h = vol.assessHedgePair({ x, y, longAsset: 'BTC', shortAsset: 'ETH' });
  assert.ok(['broken', 'degrading'].includes(h.status), `status ${h.status}`);
  assert.ok(h.corrRecent < h.corrBaseline, 'recent correlation must be the weaker one');
});

test('assessHedgePair refuses to judge on too little history', () => {
  const h = vol.assessHedgePair({ x: [0.01, 0.02], y: [0.01, 0.02], longAsset: 'A', shortAsset: 'B' });
  assert.equal(h.status, 'unknown');
  assert.match(h.warning, /Not enough paired history/);
});

test('assessHedgePair reports correlation only — sizing is a book-level question', () => {
  const x = series(300, 7);
  const y = series(300, 7, { beta: 1, base: x });
  const h = vol.assessHedgePair({ x, y, longAsset: 'A', shortAsset: 'B' });
  assert.equal(h.status, 'intact', 'a correlated pair is intact regardless of leg sizes');
  assert.deepEqual(Object.keys(h).sort(),
    ['beta','corrBaseline','corrRecent','flags','longAsset','samples','shortAsset','status','warning']);
});

test('matchHedgeLegs partitions exposure so every dollar is hedged once', () => {
  const { pairs, unmatchedLong, unmatchedShort } = vol.matchHedgeLegs(
    [['BTC', 10_000], ['VIRTUAL', 700]],
    [['ETH', -11_300], ['HYPE', -2_000]]
  );
  const matchedTotal = pairs.reduce((s, p) => s + p.matched, 0);
  assert.equal(matchedTotal + unmatchedLong, 10_700, 'longs fully accounted for');
  assert.equal(matchedTotal + unmatchedShort, 13_300, 'shorts fully accounted for');
  assert.equal(unmatchedLong, 0);
  assert.equal(unmatchedShort, 2_600);
  // largest legs pair first
  assert.deepEqual(pairs[0], { longAsset: 'BTC', shortAsset: 'ETH', matched: 10_000 });
});

test('matchHedgeLegs residual equals the signed net exposure', () => {
  for (const [longs, shorts] of [
    [[['A', 5000]], [['B', -3000]]],
    [[['A', 1000], ['C', 2000]], [['B', -9000]]],
    [[], [['B', -500]]],
    [[['A', 400]], []]
  ]) {
    const net = longs.reduce((s, [, v]) => s + v, 0) + shorts.reduce((s, [, v]) => s + v, 0);
    const m = vol.matchHedgeLegs(longs, shorts);
    assert.ok(Math.abs((m.unmatchedLong - m.unmatchedShort) - net) < 1e-6,
      `residual ${m.unmatchedLong - m.unmatchedShort} vs net ${net}`);
  }
});

test('matchHedgeLegs ignores dust legs', () => {
  const { pairs } = vol.matchHedgeLegs([['A', 10_000]], [['B', -10_000], ['C', -10]]);
  assert.equal(pairs.length, 1);
});

test('weightedSeriesMean aligns from the most recent element', () => {
  const out = vol.weightedSeriesMean([
    { series: [1, 1, 1, 1], weight: 1 },
    { series: [3, 3],       weight: 1 }
  ]);
  assert.deepEqual(out, [2, 2], 'truncated to the shortest series, taken from the tail');

  const weighted = vol.weightedSeriesMean([
    { series: [0, 0], weight: 3 },
    { series: [4, 4], weight: 1 }
  ]);
  assert.deepEqual(weighted, [1, 1]);
  assert.deepEqual(vol.weightedSeriesMean([]), []);
  assert.deepEqual(vol.weightedSeriesMean([{ series: [], weight: 1 }]), []);
});

test('classifyRegime moves once it has real history', () => {
  const history = Array.from({ length: 200 }, (_, i) => 0.005 + i * 0.0001);  // 0.005 → 0.0249
  assert.equal(vol.classifyRegime(0.006, history), 'low');
  assert.equal(vol.classifyRegime(0.015, history), 'medium');
  assert.equal(vol.classifyRegime(0.023, history), 'high');
  assert.equal(vol.classifyRegime(0.030, history), 'extreme');
  assert.equal(vol.classifyRegime(0.015, []), 'medium', 'no history is reported as medium');
});

test('stop and target survive sub-dollar and micro-cap prices', () => {
  for (const [entry, minDecimals] of [[0.6493, 4], [0.152, 4], [0.0000123, 8]]) {
    const s = vol.computeDynamicStop({ entryPrice: entry, accountSize: 10_000, riskPct: 0.01,
                                       compositeVolPct: 0.018, k: 1.5, regimeLabel: 'medium',
                                       direction: 'long' });
    assert.ok(s.stopPrice > 0, `stop for ${entry} must not round to zero`);
    assert.ok(s.targetPrice > s.stopPrice);
    assert.ok(Math.abs(s.stopPrice - entry * (1 - 0.027)) / entry < 0.001,
      `stop ${s.stopPrice} should sit ~2.7% below ${entry}`);
  }
});
