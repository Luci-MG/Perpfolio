import test from 'node:test';
import assert from 'node:assert/strict';
import * as cf from './confluence.js';

function rng(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

// deterministic OHLCV: `path(i)` gives the close, noise widens the wicks
function candles(n, path, { seed = 1, wick = 0.004, buyShare = () => 0.5, step = 3600e3 } = {}) {
  const r = rng(seed);
  const out = [];
  let prev = path(0);
  for (let i = 0; i < n; i++) {
    const close = path(i);
    const open = prev;
    const high = Math.max(open, close) * (1 + wick * r());
    const low = Math.min(open, close) * (1 - wick * r());
    const volume = 100 + 50 * r();
    out.push({ t: i * step, open, high, low, close, volume, takerBuy: volume * buyShare(i) });
    prev = close;
  }
  return out;
}

const uptrend = n => candles(n, i => 100 * Math.exp(0.004 * i), { buyShare: i => 0.5 + 0.1 * Math.sin(i / 5) + (i > n - 25 ? 0.15 : 0) });
const downtrend = n => candles(n, i => 100 * Math.exp(-0.004 * i), { buyShare: i => 0.5 + 0.1 * Math.sin(i / 5) - (i > n - 25 ? 0.15 : 0) });
const range = n => candles(n, i => 100 + 3 * Math.sin(i / 2), { seed: 3 });
const walk = (n, seed) => {
  const r = rng(seed);
  const closes = [100];
  for (let i = 1; i < n; i++) closes.push(closes[i - 1] * (1 + (r() - 0.5) * 0.02));
  return candles(n, i => closes[i], { seed });
};

test('ema seeds with the SMA and tracks a constant exactly', () => {
  const e = cf.ema([1, 2, 3, 4, 5, 6], 3);
  assert.deepEqual(e.slice(0, 2), [null, null]);
  assert.equal(e[2], 2);
  assert.equal(e[3], 3);
  assert.ok(cf.ema(new Array(50).fill(7), 10).slice(9).every(v => Math.abs(v - 7) < 1e-12));
});

test('ema skips leading nulls, so MACD signal lines up behind its line', () => {
  const e = cf.ema([null, null, 2, 4, 6], 2);
  assert.deepEqual(e, [null, null, null, 3, 5]);
});

test('rsi is 100 on a monotonic rise, 0 on a fall, 50 when flat', () => {
  const up = cf.rsi(Array.from({ length: 30 }, (_, i) => 100 + i));
  const down = cf.rsi(Array.from({ length: 30 }, (_, i) => 100 - i));
  const flat = cf.rsi(new Array(30).fill(100));
  assert.equal(up.at(-1), 100);
  assert.equal(down.at(-1), 0);
  assert.equal(flat.at(-1), 50);
  assert.equal(up[13], null);
});

test('rsi matches Wilder\'s textbook series', () => {
  const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03,
    45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64];
  const r = cf.rsi(closes);
  assert.ok(Math.abs(r[14] - 70.46) < 0.05, `rsi[14] = ${r[14]}`);
  assert.ok(Math.abs(r[19] - 57.92) < 0.6, `rsi[19] = ${r[19]}`);
});

test('adx is high on a clean trend and low on a sine range', () => {
  const trend = cf.adx(uptrend(300)).adx.at(-1);
  const flat = cf.adx(range(300)).adx.at(-1);
  assert.ok(trend > 25, `trend adx ${trend}`);
  assert.ok(flat < 25, `range adx ${flat}`);
  assert.ok(trend > flat);
});

test('supertrend points up in an uptrend and down in a downtrend', () => {
  assert.equal(cf.supertrend(uptrend(200)).dir.at(-1), 1);
  assert.equal(cf.supertrend(downtrend(200)).dir.at(-1), -1);
});

test('donchian excludes the current bar', () => {
  const c = uptrend(40);
  const d = cf.donchian(c, 20);
  assert.equal(d.hi[19], null);
  assert.equal(d.hi[30], Math.max(...c.slice(10, 30).map(k => k.high)));
});

test('anchored vwap restarts at each UTC day', () => {
  const c = candles(48, i => 100 + i, { step: 3600e3 });
  const v = cf.anchoredVwap(c, 'day');
  const tp = k => (k.high + k.low + k.close) / 3;
  assert.ok(Math.abs(v[24] - tp(c[24])) < 1e-9);
  assert.ok(Math.abs(v[23] - tp(c[23])) > 1);
});

test('flow imbalance reads the aggressor share and is null without taker data', () => {
  const buy = cf.flowImbalance(candles(30, () => 100, { buyShare: () => 0.75 }), 20).at(-1);
  assert.ok(Math.abs(buy - 0.5) < 1e-12);
  const bare = uptrend(30).map(({ takerBuy, ...k }) => k);
  assert.equal(cf.flowImbalance(bare).at(-1), null);
});

test('alignToCandles never hands a bar a row stamped after its close', () => {
  const c = candles(10, () => 100);
  const rows = c.map(k => ({ t: k.t + 3600e3 + 1, v: k.t }));
  const a = cf.alignToCandles(c, 3600e3, rows);
  for (let i = 1; i < c.length; i++) assert.ok(a[i] < c[i].t, `bar ${i} saw ${a[i]}`);
  assert.equal(a[0], null);
});

test('a clean uptrend scores strongly bullish in a trend regime', () => {
  const x = cf.buildIndicators(uptrend(400), { tf: '1h' });
  const r = cf.scoreTimeframe(x);
  assert.equal(r.regime.label, 'trend');
  assert.ok(r.score > 0.5, `score ${r.score}`);
  assert.equal(r.state, 'bull');
  assert.equal(r.signals.find(s => s.id === 'bbPctB').state, 'gated');
});

test('a clean downtrend mirrors it', () => {
  const r = cf.scoreTimeframe(cf.buildIndicators(downtrend(400), { tf: '1h' }));
  assert.ok(r.score < -0.5, `score ${r.score}`);
});

test('a contracting range is flagged as a squeeze and switches mean reversion off', () => {
  const c = candles(300, i => 100 + 4 * (1 - i / 300) ** 2 * Math.sin(i / 3), { wick: 0.0005 });
  const x = cf.buildIndicators(c, { tf: '1h' });
  const r = cf.scoreTimeframe(x);
  assert.equal(r.regime.squeeze, true);
  assert.equal(r.sources.find(s => s.id === 'meanrev').weight, 0);
});

test('missing positioning data is n/a and drops out of the weights, not neutral', () => {
  const x = cf.buildIndicators(uptrend(400), { tf: '1h' });
  const r = cf.scoreTimeframe(x);
  for (const id of ['oiQuadrant', 'crowding', 'lsGap']) {
    const s = r.signals.find(v => v.id === id);
    assert.equal(s.state, 'n/a');
    assert.equal(s.reason, 'no data from Binance');
  }
  assert.equal(r.counts.na, 2);
  const lev = r.sources.find(s => s.id === 'leverage');
  assert.equal(lev.score, null);
});

test('collinear signals share one source vote', () => {
  const x = cf.buildIndicators(uptrend(400), { tf: '1h' });
  const r = cf.scoreTimeframe(x);
  const flow = r.signals.filter(s => s.source === 'flow');
  assert.equal(flow.length, 2);
  const src = r.sources.find(s => s.id === 'flow');
  assert.equal(src.score, (flow[0].score + flow[1].score) / 2);
});

test('informational sources are shown but carry no weight', () => {
  const x = cf.buildIndicators(uptrend(400), { tf: '1d' });
  const r = cf.scoreTimeframe(x, { informational: ['trend'] });
  const trend = r.sources.find(s => s.id === 'trend');
  assert.equal(trend.weight, 0);
  assert.ok(trend.score > 0);
});

test('crowded funding caps a bullish score', () => {
  const c = uptrend(400);
  const funding = c.map((k, i) => ({ t: k.t, v: i < 390 ? 0.0001 + 0.00001 * Math.sin(i) : 0.003 }));
  const x = cf.buildIndicators(c, { tf: '1h', deriv: { funding }, fundingIntervalMs: 3600e3 });
  const r = cf.scoreTimeframe(x);
  const crowd = r.signals.find(s => s.id === 'crowding');
  assert.ok(crowd.value > 2, `z ${crowd.value}`);
  assert.equal(r.crowded, 'longs');
  assert.equal(r.score, 0.3);
});

test('rising open interest with rising price reads as new longs', () => {
  const c = uptrend(400);
  const oi = c.map((k, i) => ({ t: k.t, v: 1000 * (1 + (i > 380 ? 0.05 * (i - 380) : 0.001 * Math.sin(i))) }));
  const r = cf.scoreTimeframe(cf.buildIndicators(c, { tf: '1h', deriv: { oi } }));
  const s = r.signals.find(v => v.id === 'oiQuadrant');
  assert.equal(s.note, 'new longs');
  assert.equal(s.score, 1);
});

test('calibration: a trend every signal agrees with hits every time', () => {
  const x = cf.buildIndicators(uptrend(400), { tf: '1h' });
  const cal = cf.calibrate(x, { horizon: 6 });
  assert.equal(cal.baseUp, 1);
  assert.equal(cal.signals.emaStack.hitRate, 1);
  assert.equal(cal.signals.emaStack.edge, 0);
  assert.ok(cal.composite.n > 100);
});

test('calibration on a random walk shows no edge and reports its sample size', () => {
  const x = cf.buildIndicators(walk(1000, 11), { tf: '1h' });
  const cal = cf.calibrate(x, { horizon: 6 });
  const c = cal.composite;
  assert.ok(c.n >= 30, `n ${c.n}`);
  assert.ok(Math.abs(c.edge) < 0.15, `edge ${c.edge}`);
  assert.equal(cal.signals.oiQuadrant.n, 0);
  assert.equal(cal.signals.oiQuadrant.thin, true);
});

test('combineTimeframes weights by timeframe and reports alignment', () => {
  const byTf = { '15m': { score: -0.2 }, '1h': { score: 0.5 }, '4h': { score: 0.6 }, '1d': { score: 0.4 } };
  const r = cf.combineTimeframes(byTf);
  const expect = (0.15 * -0.2 + 0.25 * 0.5 + 0.35 * 0.6 + 0.25 * 0.4) / 1;
  assert.ok(Math.abs(r.score - expect) < 1e-12);
  assert.equal(r.aligned, true);
  assert.equal(cf.combineTimeframes({ '1h': { score: 0.5 } }).aligned, null);
  assert.equal(cf.combineTimeframes({ ...byTf, '1d': { score: -0.4 } }).aligned, false);
});

test('btcAlignment halves only a correlated disagreement with a clear BTC read', () => {
  assert.deepEqual(cf.btcAlignment(0.6, -0.5, 0.9), { score: 0.3, discounted: true });
  assert.equal(cf.btcAlignment(0.6, -0.5, 0.4).discounted, false);
  assert.equal(cf.btcAlignment(0.6, -0.1, 0.9).discounted, false);
  assert.equal(cf.btcAlignment(0.6, 0.5, 0.9).discounted, false);
});

test('btcCorrelation pairs on timestamps', () => {
  const a = walk(200, 5);
  assert.ok(cf.btcCorrelation(a, a) > 0.999);
  assert.equal(cf.btcCorrelation(a.slice(0, 10), a), null);
});

test('wilson interval matches the textbook value and narrows with n', () => {
  const [lo, hi] = cf.wilson(0.5, 100);
  assert.ok(Math.abs(lo - 0.4038) < 1e-3 && Math.abs(hi - 0.5962) < 1e-3, `${lo} ${hi}`);
  const [lo2, hi2] = cf.wilson(0.5, 1000);
  assert.ok(hi2 - lo2 < hi - lo);
  assert.equal(cf.wilson(0.5, 0), null);
});

test('calibration uses an effective sample for overlapping windows and rarely calls noise significant', () => {
  let significant = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const cal = cf.calibrate(cf.buildIndicators(walk(1000, seed), { tf: '1h' }), { horizon: 6 });
    assert.equal(cal.composite.nEff, Math.floor(cal.composite.n / 6));
    if (cal.composite.significant) significant++;
  }
  assert.ok(significant <= 3, `${significant} of 20 random walks flagged significant`);
});

test('no signal sees the future: scoring bar k on the full series equals scoring a series cut at k', () => {
  const c = walk(400, 21);
  const oi = c.map((k, i) => ({ t: k.t + 3600e3 - 1, v: 1000 + 10 * Math.sin(i / 7) + i }));
  const funding = c.filter((_, i) => i % 8 === 0).map((k, i) => ({ t: k.t, v: 0.0001 * Math.sin(i) }));
  const full = cf.buildIndicators(c, { tf: '1h', deriv: { oi, funding } });
  for (const k of [260, 300, 350, 399]) {
    const cut = cf.buildIndicators(c.slice(0, k + 1), { tf: '1h', deriv: { oi, funding } });
    const a = cf.scoreTimeframe(full, { i: k }), b = cf.scoreTimeframe(cut);
    for (const s of a.signals) {
      const t = b.signals.find(v => v.id === s.id);
      assert.equal(s.score, t.score, `${s.id} at bar ${k}`);
    }
  }
});

test('anchored vwap slope is not compared across an anchor reset', () => {
  const c = candles(60, i => 100 + i, { step: 3600e3 });
  const x = cf.buildIndicators(c, { tf: '15m' });
  const resetBar = c.findIndex((k, i) => i > 0 && Math.floor(k.t / 86400e3) !== Math.floor(c[i - 1].t / 86400e3));
  assert.notEqual(x.vwapPeriod[resetBar], x.vwapPeriod[resetBar - 1]);
});

test('regime buckets and the early/recent split each account for every scored reading once', () => {
  const x = cf.buildIndicators(walk(1000, 11), { tf: '1h' });
  const cal = cf.calibrate(x, { horizon: 6 });
  for (const rec of [cal.composite, ...Object.values(cal.signals)]) {
    const regimes = Object.values(rec.byRegime).reduce((a, r) => a + r.n, 0);
    assert.equal(regimes, rec.n);
    assert.equal(rec.early.n + rec.recent.n, rec.n);
    assert.ok(['holds', 'fades', 'thin'].includes(rec.stability));
  }
  assert.ok(Object.keys(cal.composite.byRegime).every(k => ['trend', 'range', 'transition', 'squeeze', 'unknown'].includes(k)));
});

test('stability: holds on the same sign, fades on a flip, thin without enough recent samples', () => {
  const r = (edge, nEff) => ({ edge, nEff });
  assert.equal(cf.stabilityOf(r(0.05, 60), r(0.02, 25)), 'holds');
  assert.equal(cf.stabilityOf(r(0.05, 60), r(-0.03, 25)), 'fades');
  assert.equal(cf.stabilityOf(r(0.05, 60), r(-0.03, 10)), 'thin');
  assert.equal(cf.stabilityOf(r(null, 0), r(0.01, 40)), 'thin');
});

function verdictInput() {
  const hit = (overall, inTrend) => ({ hitRate: overall, expected: 0.5, edge: overall - 0.5, nEff: 80, thin: false,
    significant: false, byRegime: { trend: { hitRate: inTrend, expected: 0.5, edge: inTrend - 0.5, nEff: inTrend ? 40 : 5,
      thin: !inTrend, significant: false } } });
  const tf = (signals) => ({
    regime: { label: 'trend', squeeze: false },
    sources: [{ id: 'trend', weight: 0.3 }, { id: 'flow', weight: 0.2 }, { id: 'meanrev', weight: 0 }],
    signals,
    calibration: { composite: { ...hit(0.55, 0.58), stability: 'holds' } }
  });
  return {
    '1h': tf([{ id: 'ema', name: 'EMA', source: 'trend', score: 0.8, hit: hit(0.54, 0.6) },
              { id: 'cvd', name: 'CVD', source: 'flow', score: -0.9, hit: hit(0.51, 0) },
              { id: 'bb', name: 'Bollinger', source: 'meanrev', score: -1, hit: hit(0.5, 0) }]),
    '4h': tf([{ id: 'ema', name: 'EMA', source: 'trend', score: 0.6, hit: hit(0.56, 0) },
              { id: 'cvd', name: 'CVD', source: 'flow', score: 0.4, hit: hit(0.5, 0.52) }])
  };
}

test('the verdict leads with the signals pulling its way, names the strongest against, and ignores switched-off sources', () => {
  const v = cf.explainVerdict(verdictInput(), { score: 0.45, state: 'bull', aligned: true });
  assert.equal(v.strength, 'moderate');
  assert.deepEqual(v.reasons.map(r => `${r.tf}:${r.id}`), ['4h:ema', '1h:ema', '4h:cvd']);
  assert.equal(`${v.against.tf}:${v.against.id}`, '1h:cvd', 'the switched-off Bollinger never appears');
  assert.equal(v.reasons[1].record.scope, 'regime');
  assert.equal(v.reasons[0].record.scope, 'overall', 'too thin in the regime, so the overall record');
  assert.deepEqual([v.trust.tf, v.trust.regime, v.trust.record.scope, v.trust.stability], ['4h', 'trend', 'regime', 'holds']);
});

test('a neutral verdict lists the strongest pulls either way and has no "against"', () => {
  const v = cf.explainVerdict(verdictInput(), { score: 0.1, state: 'neutral', aligned: false });
  assert.equal(v.direction, 0);
  assert.equal(v.against, null);
  assert.equal(v.reasons.length, 3);
});

test('a signal record trimmed for a reading keeps its overall record, stability and only the current regime', () => {
  const rec = { n: 10, hitRate: 0.6, stability: 'holds', early: { n: 7 }, recent: { n: 3 },
                byRegime: { trend: { n: 6 }, range: { n: 4 } } };
  assert.deepEqual(cf.forRegime(rec, 'trend'), { n: 10, hitRate: 0.6, stability: 'holds', byRegime: { trend: { n: 6 } } });
  assert.deepEqual(cf.forRegime(rec, 'squeeze').byRegime, {});
});
