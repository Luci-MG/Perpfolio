// confluence.js — independent market signals for one symbol, scored per timeframe (ESM)
//
// Pure functions, no I/O. Candles are { t, open, high, low, close, volume, takerBuy }
// oldest→newest, closed bars only. Every signal is a registry entry scored bar by bar, so
// the same code that produces today's reading also replays it over history and reports how
// often it has actually been right.

import { percentileRank, pearsonCorr } from './vol-estimator.js';
import { alignedReturns } from './risk-engine.js';

export const TIMEFRAMES = { '15m': 15 * 60e3, '1h': 3600e3, '4h': 4 * 3600e3, '1d': 86400e3 };
export const TF_WEIGHTS = { '15m': 0.15, '1h': 0.25, '4h': 0.35, '1d': 0.25 };
export const VWAP_ANCHOR = { '15m': 'day', '1h': 'week', '4h': 'month', '1d': 'year' };

export const SOURCES = [
  { id: 'trend',       name: 'Trend',          weight: 0.20 },
  { id: 'momentum',    name: 'Momentum',       weight: 0.12 },
  { id: 'meanrev',     name: 'Mean reversion', weight: 0.10 },
  { id: 'flow',        name: 'Flow',           weight: 0.18 },
  { id: 'structure',   name: 'Structure',      weight: 0.15 },
  { id: 'leverage',    name: 'Leverage',       weight: 0.18 },
  { id: 'positioning', name: 'Positioning',    weight: 0.07 }
];

const clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
const band = (z, lo, hi) => Math.sign(z) * clamp((Math.abs(z) - lo) / (hi - lo), 0, 1);
const blank = n => new Array(n).fill(null);

// ─── INDICATORS ──────────────────────────────────────────────────────────────

function smoothed(values, period, k) {
  const out = blank(values.length);
  const start = values.findIndex(v => v != null);
  if (start < 0 || values.length - start < period) return out;
  let prev = 0;
  for (let i = start; i < start + period; i++) prev += values[i];
  prev /= period;
  out[start + period - 1] = prev;
  for (let i = start + period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Exponential moving average seeded with the SMA of the first `period` values. */
export function ema(values, period) {
  return smoothed(values, period, 2 / (period + 1));
}

/** Wilder's smoothing (RMA), as used by RSI, ATR and ADX. */
export function rma(values, period) {
  return smoothed(values, period, 1 / period);
}

/** Wilder RSI; 100 on a series that only rises, 50 on a flat one. */
export function rsi(closes, period = 14) {
  const out = blank(closes.length);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= period;
  loss /= period;
  const value = () => loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  out[period] = value();
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = value();
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signal = 9) {
  const f = ema(closes, fast), s = ema(closes, slow);
  const line = f.map((v, i) => v == null || s[i] == null ? null : v - s[i]);
  const sig = ema(line, signal);
  const hist = line.map((v, i) => v == null || sig[i] == null ? null : v - sig[i]);
  return { line, signal: sig, hist };
}

export function trueRange(candles) {
  return candles.map((c, i) => i === 0
    ? c.high - c.low
    : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close)));
}

export function atrSeries(candles, period = 14) {
  return rma(trueRange(candles), period);
}

/** Supertrend: `dir` is +1 while price holds above the lower band, −1 below the upper. */
export function supertrend(candles, period = 10, mult = 3) {
  const atr = atrSeries(candles, period);
  const line = blank(candles.length), dir = blank(candles.length);
  let upper = null, lower = null, d = 1;
  for (let i = 0; i < candles.length; i++) {
    if (atr[i] == null) continue;
    const c = candles[i], pc = candles[i - 1]?.close ?? c.close;
    const hl2 = (c.high + c.low) / 2;
    const bu = hl2 + mult * atr[i], bl = hl2 - mult * atr[i];
    upper = upper == null || bu < upper || pc > upper ? bu : upper;
    lower = lower == null || bl > lower || pc < lower ? bl : lower;
    if (d === 1 && c.close < lower) d = -1;
    else if (d === -1 && c.close > upper) d = 1;
    dir[i] = d;
    line[i] = d === 1 ? lower : upper;
  }
  return { line, dir };
}

/** ADX with +DI/−DI, Wilder-smoothed. */
export function adx(candles, period = 14) {
  const n = candles.length;
  const tr = blank(n), plus = blank(n), minus = blank(n);
  for (let i = 1; i < n; i++) {
    const c = candles[i], p = candles[i - 1];
    const up = c.high - p.high, down = p.low - c.low;
    plus[i] = up > down && up > 0 ? up : 0;
    minus[i] = down > up && down > 0 ? down : 0;
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  const sTr = rma(tr, period), sPlus = rma(plus, period), sMinus = rma(minus, period);
  const plusDI = blank(n), minusDI = blank(n), dx = blank(n);
  for (let i = 0; i < n; i++) {
    if (sTr[i] == null) continue;
    plusDI[i] = sTr[i] ? 100 * sPlus[i] / sTr[i] : 0;
    minusDI[i] = sTr[i] ? 100 * sMinus[i] / sTr[i] : 0;
    const sum = plusDI[i] + minusDI[i];
    dx[i] = sum ? 100 * Math.abs(plusDI[i] - minusDI[i]) / sum : 0;
  }
  return { adx: rma(dx, period), plusDI, minusDI };
}

export function bollinger(closes, period = 20, mult = 2) {
  const n = closes.length;
  const mid = blank(n), upper = blank(n), lower = blank(n), pctB = blank(n), bw = blank(n);
  for (let i = period - 1; i < n; i++) {
    const w = closes.slice(i - period + 1, i + 1);
    const m = w.reduce((a, b) => a + b, 0) / period;
    const sd = Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / period);
    mid[i] = m;
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
    pctB[i] = sd ? (closes[i] - lower[i]) / (upper[i] - lower[i]) : 0.5;
    bw[i] = m ? (upper[i] - lower[i]) / m : null;
  }
  return { mid, upper, lower, pctB, bw };
}

/** Highest high and lowest low of the `period` bars before each bar, excluding it. */
export function donchian(candles, period = 20) {
  const hi = blank(candles.length), lo = blank(candles.length);
  for (let i = period; i < candles.length; i++) {
    let h = -Infinity, l = Infinity;
    for (let j = i - period; j < i; j++) {
      h = Math.max(h, candles[j].high);
      l = Math.min(l, candles[j].low);
    }
    hi[i] = h;
    lo[i] = l;
  }
  return { hi, lo };
}

/**
 * Swing structure from Williams fractals (`k` bars each side), using only pivots already
 * confirmed at each bar: +1 higher high and higher low, −1 lower high and lower low, 0 mixed.
 */
export function swingStructure(candles, k = 2) {
  const out = blank(candles.length);
  const highs = [], lows = [];
  const isPivot = (j, key, better) => {
    for (let o = 1; o <= k; o++) {
      if (!better(candles[j][key], candles[j - o][key], true)) return false;
      if (!better(candles[j][key], candles[j + o][key], false)) return false;
    }
    return true;
  };
  const above = (a, b, strict) => strict ? a > b : a >= b;
  const below = (a, b, strict) => strict ? a < b : a <= b;
  for (let i = 2 * k; i < candles.length; i++) {
    const j = i - k;
    if (isPivot(j, 'high', above)) highs.push(candles[j].high);
    if (isPivot(j, 'low', below)) lows.push(candles[j].low);
    if (highs.length < 2 || lows.length < 2) continue;
    const hh = highs.at(-1) > highs.at(-2), hl = lows.at(-1) > lows.at(-2);
    const lh = highs.at(-1) < highs.at(-2), ll = lows.at(-1) < lows.at(-2);
    out[i] = hh && hl ? 1 : lh && ll ? -1 : 0;
  }
  return out;
}

const WEEK_OFFSET = 4 * 86400e3;
const ANCHOR_KEYS = {
  day:   t => Math.floor(t / 86400e3),
  week:  t => Math.floor((t - WEEK_OFFSET) / (7 * 86400e3)),
  month: t => { const d = new Date(t); return d.getUTCFullYear() * 12 + d.getUTCMonth(); },
  year:  t => new Date(t).getUTCFullYear()
};

/** VWAP restarted at each UTC `anchor` period: day | week | month | year. */
export function anchoredVwap(candles, anchor = 'week') {
  return anchoredVwapWithPeriods(candles, anchor).vwap;
}

function anchoredVwapWithPeriods(candles, anchor) {
  const keyOf = ANCHOR_KEYS[anchor];
  const out = blank(candles.length);
  const periods = blank(candles.length);
  let key = null, pv = 0, v = 0;
  candles.forEach((c, i) => {
    const k = keyOf(c.t);
    if (k !== key) { key = k; pv = 0; v = 0; }
    const tp = (c.high + c.low + c.close) / 3;
    pv += tp * c.volume;
    v += c.volume;
    out[i] = v ? pv / v : tp;
    periods[i] = k;
  });
  return { vwap: out, periods };
}

/** Net aggressor share over `window` bars: Σ(2·takerBuy − volume) / Σvolume, in [−1, 1]. */
export function flowImbalance(candles, window = 20) {
  const out = blank(candles.length);
  if (!candles.every(c => Number.isFinite(c.takerBuy))) return out;
  for (let i = window - 1; i < candles.length; i++) {
    let delta = 0, total = 0;
    for (let j = i - window + 1; j <= i; j++) {
      delta += 2 * candles[j].takerBuy - candles[j].volume;
      total += candles[j].volume;
    }
    out[i] = total ? delta / total : 0;
  }
  return out;
}

/** Z-score of each value against the trailing `window` values including itself. */
export function rollingZ(values, window = 100, minSamples = 20) {
  const out = blank(values.length);
  for (let i = 0; i < values.length; i++) {
    if (values[i] == null) continue;
    const w = values.slice(Math.max(0, i - window + 1), i + 1).filter(v => v != null);
    if (w.length < minSamples) continue;
    const m = w.reduce((a, b) => a + b, 0) / w.length;
    const sd = Math.sqrt(w.reduce((s, v) => s + (v - m) ** 2, 0) / (w.length - 1));
    out[i] = sd ? (values[i] - m) / sd : 0;
  }
  return out;
}

/**
 * Maps timestamped rows `{t, v}` onto candles: each bar takes the latest row stamped at or
 * before its close, and nothing older than `maxAgeMs`, so a bar never sees a later row.
 */
export function alignToCandles(candles, intervalMs, rows, maxAgeMs = 2 * intervalMs) {
  const out = blank(candles.length);
  if (!rows?.length) return out;
  const sorted = [...rows].filter(r => r.v != null && Number.isFinite(r.v)).sort((a, b) => a.t - b.t);
  let j = -1;
  candles.forEach((c, i) => {
    const close = c.t + intervalMs - 1;
    while (j + 1 < sorted.length && sorted[j + 1].t <= close) j++;
    if (j >= 0 && close - sorted[j].t <= maxAgeMs) out[i] = sorted[j].v;
  });
  return out;
}

function changeOver(values, lag) {
  return values.map((v, i) => i < lag || v == null || !values[i - lag] ? null : v / values[i - lag] - 1);
}

// ─── INDICATOR BUNDLE ────────────────────────────────────────────────────────

function regimeOf(adxValue, bbwPct) {
  const label = adxValue == null ? 'unknown' : adxValue > 25 ? 'trend' : adxValue < 20 ? 'range' : 'transition';
  return { label, adx: adxValue, squeeze: bbwPct != null && bbwPct < 0.10, bbwPctile: bbwPct };
}

/**
 * Everything the registry reads, computed once per timeframe. `deriv` holds the optional
 * Binance positioning series, each an array of `{t, v}`: oi, funding, basis, topLS, globalLS.
 * `fundingIntervalMs` bounds how stale a funding settlement may be.
 */
export function buildIndicators(candles, { tf = '1h', deriv = {}, fundingIntervalMs = 8 * 3600e3 } = {}) {
  const intervalMs = TIMEFRAMES[tf] ?? 3600e3;
  const close = candles.map(c => c.close);
  const bb = bollinger(close);
  const bbwPct = bb.bw.map((w, i) => {
    if (w == null) return null;
    const hist = bb.bw.slice(Math.max(0, i - 120), i).filter(v => v != null);
    return hist.length >= 60 ? percentileRank(w, hist) : null;
  });
  const dmi = adx(candles);
  const flow20 = flowImbalance(candles, 20), flow3 = flowImbalance(candles, 3);

  const fundingZ = alignToCandles(candles, intervalMs,
    zRows(deriv.funding, 90), Math.max(2 * intervalMs, 2 * fundingIntervalMs));
  const basisZ = alignToCandles(candles, intervalMs, zRows(deriv.basis, 100));
  const topLS = alignToCandles(candles, intervalMs, deriv.topLS);
  const globalLS = alignToCandles(candles, intervalMs, deriv.globalLS);
  const lsGap = topLS.map((t, i) => t > 0 && globalLS[i] > 0 ? Math.log(t) - Math.log(globalLS[i]) : null);
  const oi = alignToCandles(candles, intervalMs, deriv.oi);
  const oiChg = changeOver(oi, 6);

  return {
    tf, intervalMs, n: candles.length, candles, close,
    ema20: ema(close, 20), ema50: ema(close, 50), ema200: ema(close, 200),
    st: supertrend(candles),
    rsi: rsi(close),
    macd: macd(close),
    atr: atrSeries(candles),
    adx: dmi.adx,
    bb, bbwPct,
    don: donchian(candles),
    structure: swingStructure(candles),
    ...(({ vwap, periods }) => ({ vwap, vwapPeriod: periods }))(anchoredVwapWithPeriods(candles, VWAP_ANCHOR[tf] ?? 'week')),
    anchor: VWAP_ANCHOR[tf] ?? 'week',
    flow20, flow3,
    flow20Z: rollingZ(flow20, 200, 50),
    flow3Z: rollingZ(flow3, 200, 50),
    priceChg6: changeOver(close, 6),
    priceChg20: changeOver(close, 20),
    oiChg,
    oiChgZ: rollingZ(oiChg, 100),
    fundingZ, basisZ,
    fundingRate: alignToCandles(candles, intervalMs, deriv.funding, Math.max(2 * intervalMs, 2 * fundingIntervalMs)),
    basisRate: alignToCandles(candles, intervalMs, deriv.basis),
    lsZ: rollingZ(lsGap, 200, 30),
    has: {
      klines: candles.length > 0,
      flow: candles.length > 0 && candles.every(c => Number.isFinite(c.takerBuy)),
      oi: !!deriv.oi?.length,
      funding: !!deriv.funding?.length || !!deriv.basis?.length,
      ls: !!deriv.topLS?.length && !!deriv.globalLS?.length
    },
    regimeAt(i) { return regimeOf(this.adx[i], this.bbwPct[i]); }
  };
}

function zRows(rows, window) {
  if (!rows?.length) return [];
  const sorted = [...rows].sort((a, b) => a.t - b.t);
  const z = rollingZ(sorted.map(r => r.v), window);
  return sorted.map((r, i) => ({ t: r.t, v: z[i] }));
}

// ─── REGISTRY ────────────────────────────────────────────────────────────────
// scoreAt(x, i, regime) returns { score ∈ [−1, 1], value, unit, note } or null when the
// inputs at bar i do not exist. `gated(regime)` switches a signal off without voting.

export const CONFLUENCES = [
  {
    id: 'emaStack', name: 'EMA 20/50/200 stack', source: 'trend', needs: 'klines',
    scoreAt(x, i) {
      const c = x.close[i], a = x.ema20[i], b = x.ema50[i], d = x.ema200[i];
      if (d == null) return null;
      const score = (Math.sign(c - a) + Math.sign(a - b) + Math.sign(b - d)) / 3;
      return { score, value: (c / d - 1) * 100, unit: 'pct',
        note: score === 1 ? 'bull stack' : score === -1 ? 'bear stack' : 'mixed stack' };
    }
  },
  {
    id: 'supertrend', name: 'Supertrend 10 × 3', source: 'trend', needs: 'klines',
    scoreAt(x, i) {
      const d = x.st.dir[i];
      if (d == null || x.st.dir[i - 2] == null) return null;
      const fresh = x.st.dir[i - 1] !== d || x.st.dir[i - 2] !== d;
      return { score: fresh ? d * 0.5 : d, value: (x.close[i] / x.st.line[i] - 1) * 100, unit: 'pct',
        note: `${d > 0 ? 'up' : 'down'}${fresh ? ', just flipped' : ''}` };
    }
  },
  {
    id: 'rsi', name: 'RSI 14', source: 'momentum', needs: 'klines',
    scoreAt(x, i, regime) {
      const r = x.rsi[i];
      if (r == null) return null;
      if (regime.label === 'range') {
        return { score: r < 30 ? 1 : r > 70 ? -1 : 0, value: r, unit: 'num', note: 'range: fade 30/70' };
      }
      const s = r > 55 ? 1 : r < 45 ? -1 : 0;
      return { score: regime.label === 'trend' ? s : s * 0.5, value: r, unit: 'num', note: 'trend: 55/45' };
    }
  },
  {
    id: 'macd', name: 'MACD 12/26/9', source: 'momentum', needs: 'klines',
    scoreAt(x, i) {
      const h = x.macd.hist[i], p = x.macd.hist[i - 1];
      if (h == null || p == null) return null;
      const score = h > 0 && h > p ? 1 : h < 0 && h < p ? -1 : 0;
      return { score, value: h / x.close[i] * 100, unit: 'pct',
        note: score ? `histogram ${h > 0 ? 'rising above' : 'falling below'} zero` : 'sign and slope disagree' };
    }
  },
  {
    id: 'bbPctB', name: 'Bollinger %B 20 × 2σ', source: 'meanrev', needs: 'klines',
    gated: regime => regime.label === 'trend' || regime.squeeze,
    scoreAt(x, i) {
      const b = x.bb.pctB[i];
      if (b == null) return null;
      const score = b < 0 ? 1 : b > 1 ? -1 : b < 0.1 ? 0.5 : b > 0.9 ? -0.5 : 0;
      return { score, value: b, unit: 'num', note: b < 0.1 ? 'at lower band' : b > 0.9 ? 'at upper band' : 'inside bands' };
    }
  },
  {
    id: 'cvd', name: 'CVD 20-bar imbalance (z)', source: 'flow', needs: 'flow',
    scoreAt(x, i) {
      const f = x.flow20[i], z = x.flow20Z[i], pc = x.priceChg20[i];
      if (z == null || pc == null) return null;
      const diverging = Math.abs(z) >= 1 && Math.sign(z) !== Math.sign(pc) && pc !== 0;
      return { score: band(z, 0.5, 2), value: f * 100, unit: 'pct',
        note: diverging ? `diverging from price (${f > 0 ? 'absorption of sells' : 'distribution into strength'})` : 'confirms price' };
    }
  },
  {
    id: 'taker', name: 'Taker buy/sell, 3 bars (z)', source: 'flow', needs: 'flow',
    scoreAt(x, i) {
      const f = x.flow3[i], z = x.flow3Z[i];
      if (z == null) return null;
      return { score: band(z, 0.5, 2), value: f < 1 ? (1 + f) / (1 - f) : null, unit: 'ratio',
        note: `buy ÷ sell volume, ${Math.abs(z) < 0.5 ? 'usual' : z > 0 ? 'unusually buy-heavy' : 'unusually sell-heavy'}` };
    }
  },
  {
    id: 'avwap', name: 'Anchored VWAP', source: 'structure', needs: 'klines',
    scoreAt(x, i) {
      const v = x.vwap[i], a = x.atr[i];
      if (v == null || a == null) return null;
      const p = x.vwapPeriod[i - 3] === x.vwapPeriod[i] ? x.vwap[i - 3] : null;
      const d = x.close[i] - v;
      const rising = p != null && v > p, falling = p != null && v < p;
      const score = Math.abs(d) <= 0.25 * a ? 0
        : d > 0 ? (rising ? 1 : 0.5)
        : (falling ? -1 : -0.5);
      return { score, value: (x.close[i] / v - 1) * 100, unit: 'pct', note: `anchored at the UTC ${x.anchor} open` };
    }
  },
  {
    id: 'structure', name: 'Donchian 20 + swing structure', source: 'structure', needs: 'klines',
    scoreAt(x, i) {
      const hi = x.don.hi[i], lo = x.don.lo[i], s = x.structure[i], c = x.close[i];
      if (hi == null || s == null) return null;
      const pos = hi > lo ? (c - lo) / (hi - lo) : 0.5;
      if (c > hi) return { score: 1, value: pos, unit: 'num', note: 'closed above the 20-bar high' };
      if (c < lo) return { score: -1, value: pos, unit: 'num', note: 'closed below the 20-bar low' };
      return { score: s * 0.6, value: pos, unit: 'num',
        note: s > 0 ? 'higher highs, higher lows' : s < 0 ? 'lower highs, lower lows' : 'mixed swings' };
    }
  },
  {
    id: 'oiQuadrant', name: 'Open interest × price', source: 'leverage', needs: 'oi',
    scoreAt(x, i) {
      const oi = x.oiChg[i], z = x.oiChgZ[i], pc = x.priceChg6[i];
      if (oi == null || z == null || pc == null) return null;
      if (Math.abs(z) < 0.5 || pc === 0) return { score: 0, value: oi * 100, unit: 'pct', note: 'open interest flat' };
      const up = pc > 0;
      if (oi > 0) return { score: up ? 1 : -1, value: oi * 100, unit: 'pct', note: up ? 'new longs' : 'new shorts' };
      return { score: up ? -0.3 : 0.3, value: oi * 100, unit: 'pct', note: up ? 'short covering' : 'long flush' };
    }
  },
  {
    id: 'crowding', name: 'Funding + basis crowding', source: 'leverage', needs: 'funding',
    scoreAt(x, i) {
      const zs = [x.fundingZ[i], x.basisZ[i]].filter(v => v != null);
      if (!zs.length) return null;
      const z = zs.reduce((a, b) => a + b, 0) / zs.length;
      return { score: -band(z, 1, 2), value: z, unit: 'z',
        note: z > 1 ? 'longs paying up, contrarian bearish' : z < -1 ? 'shorts paying up, contrarian bullish' : 'normal' };
    }
  },
  {
    id: 'lsGap', name: 'Top traders vs all accounts L/S', source: 'positioning', needs: 'ls',
    scoreAt(x, i) {
      const z = x.lsZ[i];
      if (z == null) return null;
      return { score: band(z, 0.75, 1.5), value: z, unit: 'z',
        note: z > 0 ? 'top traders longer than the crowd' : 'top traders shorter than the crowd' };
    }
  }
];

// ─── SCORING ─────────────────────────────────────────────────────────────────

export function stateOf(score) {
  return score >= 0.25 ? 'bull' : score <= -0.25 ? 'bear' : 'neutral';
}

function sourceWeight(src, regime, informational) {
  if (informational.includes(src.id)) return 0;
  let w = src.weight;
  if (src.id === 'trend') w *= regime.label === 'trend' ? 1.5 : regime.label === 'range' ? 0.5 : 1;
  if (src.id === 'meanrev') w *= regime.label === 'trend' || regime.squeeze ? 0 : regime.label === 'range' ? 1.5 : 1;
  return w;
}

function evaluate(def, x, i, regime) {
  const base = { id: def.id, name: def.name, source: def.source };
  if (!x.has[def.needs]) return { ...base, score: null, state: 'n/a', reason: 'no data from Binance' };
  const r = def.scoreAt(x, i, regime);
  if (!r) return { ...base, score: null, state: 'n/a', reason: 'not enough history' };
  if (def.gated?.(regime)) return { ...base, ...r, score: null, raw: r.score, state: 'gated', reason: `off in ${regime.squeeze ? 'a squeeze' : 'a trend'}` };
  return { ...base, ...r, state: stateOf(r.score) };
}

/**
 * Scores bar `i` (default: the last closed bar). Collinear signals share their source's
 * single vote; a missing input drops out of the weights rather than counting as neutral.
 * `informational` lists sources shown but excluded from the score.
 */
export function scoreTimeframe(x, { i = x.n - 1, informational = [] } = {}) {
  const regime = x.regimeAt(i);
  const signals = CONFLUENCES.map(def => evaluate(def, x, i, regime));
  let num = 0, den = 0;
  const counts = { bull: 0, bear: 0, neutral: 0, na: 0 };
  const sources = SOURCES.map(src => {
    const live = signals.filter(s => s.source === src.id && s.score != null);
    const weight = sourceWeight(src, regime, informational);
    const score = live.length ? live.reduce((a, s) => a + s.score, 0) / live.length : null;
    if (weight > 0) {
      if (score == null) counts.na++;
      else { counts[stateOf(score)]++; num += weight * score; den += weight; }
    }
    return { id: src.id, name: src.name, weight, score, state: score == null ? 'n/a' : stateOf(score),
      informational: informational.includes(src.id) };
  });

  let score = den ? num / den : null;
  let crowded = null;
  const crowd = signals.find(s => s.id === 'crowding');
  if (score != null && crowd?.value != null && crowd.state !== 'n/a') {
    if (crowd.value > 2 && score > 0.5) { score = 0.3; crowded = 'longs'; }
    else if (crowd.value < -2 && score < -0.5) { score = -0.3; crowded = 'shorts'; }
  }
  return { regime, score, state: score == null ? 'n/a' : stateOf(score), crowded, counts, sources, signals };
}

/** 95% Wilson score interval for a hit rate of `p` over `n` independent trials. */
export function wilson(p, n, z = 1.96) {
  if (!(n > 0)) return null;
  const d = 1 + z * z / n;
  const centre = (p + z * z / (2 * n)) / d;
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [centre - half, centre + half];
}

/** The calibration bucket for a regime: squeeze wins over the ADX label. */
export function regimeKey(regime) {
  return regime?.squeeze ? 'squeeze' : regime?.label ?? 'unknown';
}

export const STABILITY_MIN_NEFF = 20;

function blankStat() { return { n: 0, hits: 0, longs: 0, shorts: 0 }; }

function tally(st, score, up) {
  st.n++;
  if (score > 0) st.longs++; else st.shorts++;
  if ((score > 0) === up) st.hits++;
}

function finish(st, base, horizon) {
  const nEff = Math.floor(st.n / horizon);
  if (!st.n || base.total === 0) {
    return { n: st.n, nEff, hitRate: null, expected: null, edge: null, ci: null, significant: false, thin: true };
  }
  const baseUp = base.ups / base.total;
  const hitRate = st.hits / st.n;
  const expected = (st.longs * baseUp + st.shorts * (1 - baseUp)) / st.n;
  const ci = wilson(hitRate, nEff);
  const significant = !!ci && (ci[0] > expected || ci[1] < expected);
  return { n: st.n, nEff, hitRate, expected, edge: hitRate - expected, ci, significant, thin: nEff < 30 };
}

/** A signal's record trimmed to what a reading shows: overall, the current regime's record and stability. */
export function forRegime(record, regime) {
  if (!record) return record;
  const { byRegime = {}, early, recent, ...overall } = record;
  return { ...overall, byRegime: byRegime[regime] ? { [regime]: byRegime[regime] } : {} };
}

/** Whether an edge seen in the early bars survived into the recent ones: holds, fades or thin. */
export function stabilityOf(early, recent) {
  if (recent.edge == null || early.edge == null || recent.nEff < STABILITY_MIN_NEFF) return 'thin';
  return Math.sign(recent.edge) === Math.sign(early.edge) || early.edge === 0 ? 'holds' : 'fades';
}

/**
 * Replays every signal and the composite over history: how often a reading shown as ▲ or ▼
 * matched the close `horizon` bars later, overall, per regime (tagged at each bar) and for the
 * early and the most recent `recentShare` of bars. `expected` is what a coin-flip with the
 * same long/short mix scores on that bucket's own up-bar share; intervals use n ÷ horizon.
 */
export function calibrate(x, { horizon = 6, informational = [], signalMin = 0.25, compositeMin = 0.25, recentShare = 0.3 } = {}) {
  const ids = [...CONFLUENCES.map(d => d.id), 'composite'];
  const records = Object.fromEntries(ids.map(id => [id, new Map()]));
  const bases = new Map();
  const bucket = (map, key) => map.get(key) || map.set(key, blankStat()).get(key);
  const baseOf = key => bases.get(key) || bases.set(key, { ups: 0, total: 0 }).get(key);
  const split = Math.floor((x.n - horizon) * (1 - recentShare));

  for (let i = 0; i + horizon < x.n; i++) {
    const fwd = x.close[i + horizon] - x.close[i];
    if (fwd === 0) continue;
    const up = fwd > 0;
    const r = scoreTimeframe(x, { i, informational });
    const keys = ['all', `regime:${regimeKey(r.regime)}`, i < split ? 'early' : 'recent'];
    for (const k of keys) { const b = baseOf(k); b.total++; if (up) b.ups++; }
    const active = [...r.signals.filter(s => s.score != null && Math.abs(s.score) >= signalMin).map(s => [s.id, s.score]),
                    ...(r.score != null && Math.abs(r.score) >= compositeMin ? [['composite', r.score]] : [])];
    for (const [id, score] of active) for (const k of keys) tally(bucket(records[id], k), score, up);
  }

  const record = id => {
    const at = k => finish(records[id].get(k) || blankStat(), bases.get(k) || { ups: 0, total: 0 }, horizon);
    const regimes = [...bases.keys()].filter(k => k.startsWith('regime:'));
    const early = at('early'), recent = at('recent');
    return { ...at('all'), byRegime: Object.fromEntries(regimes.map(k => [k.slice(7), at(k)])),
             early, recent, stability: stabilityOf(early, recent) };
  };
  const all = bases.get('all') || { ups: 0, total: 0 };
  return {
    horizon, bars: all.total, baseUp: all.total ? all.ups / all.total : null,
    signals: Object.fromEntries(CONFLUENCES.map(d => [d.id, record(d.id)])),
    composite: record('composite')
  };
}

/** Timeframe-weighted overall score; `aligned` needs 1h, 4h and 1d present. */
export function combineTimeframes(byTf, weights = TF_WEIGHTS) {
  let num = 0, den = 0;
  for (const [tf, r] of Object.entries(byTf)) {
    if (r?.score == null || !weights[tf]) continue;
    num += weights[tf] * r.score;
    den += weights[tf];
  }
  const s = tf => byTf[tf]?.score;
  const haveAll = ['1h', '4h', '1d'].every(tf => s(tf) != null);
  const aligned = haveAll
    ? Math.sign(s('4h')) !== 0 && Math.sign(s('4h')) === Math.sign(s('1d'))
      && Math.sign(s('1h')) === Math.sign(s('4h')) && Math.abs(s('1h')) > 0.3
    : null;
  const score = den ? num / den : null;
  return { score, state: score == null ? 'n/a' : stateOf(score), aligned };
}

/**
 * Halves an alt's score when it disagrees with a clear BTC reading on the same timeframe
 * and the two have moved together (72-bar correlation above 0.7).
 */
export function btcAlignment(score, btcScore, corr) {
  const applies = score != null && btcScore != null && corr != null && corr > 0.7
    && Math.abs(btcScore) >= 0.3 && score !== 0 && Math.sign(score) !== Math.sign(btcScore);
  return { score: applies ? score * 0.5 : score, discounted: applies };
}

export function btcCorrelation(assetCandles, btcCandles, bars = 72) {
  const { x, y } = alignedReturns(assetCandles, btcCandles);
  if (x.length < 24) return null;
  return pearsonCorr(x.slice(-bars), y.slice(-bars));
}

const VERDICT_TFS = ['1h', '4h', '1d'];
const TRUST_TF = '4h';

function strengthOf(score) {
  const a = Math.abs(score ?? 0);
  return a >= 0.6 ? 'strong' : a >= 0.35 ? 'moderate' : 'weak';
}

function recordIn(hit, regime) {
  if (!hit) return null;
  const inRegime = hit.byRegime?.[regime];
  const r = inRegime && !inRegime.thin ? inRegime : hit;
  return { hitRate: r.hitRate, expected: r.expected, edge: r.edge, nEff: r.nEff, significant: r.significant,
           thin: r.thin, scope: r === hit ? 'overall' : 'regime', regime };
}

function contributionsOf(timeframes, weights) {
  return VERDICT_TFS.filter(tf => timeframes[tf]).flatMap(tf => {
    const r = timeframes[tf];
    const regime = regimeKey(r.regime);
    return r.sources.filter(src => src.weight > 0).flatMap(src => {
      const live = r.signals.filter(s => s.source === src.id && s.score != null);
      return live.map(s => ({ tf, id: s.id, name: s.name, score: s.score,
                              pull: (weights[tf] ?? 0) * src.weight / live.length * s.score,
                              record: recordIn(s.hit, regime) }));
    });
  });
}

/**
 * The reading in words: lean and strength, the three signals pulling hardest that way across
 * 1h–1d with their records in each timeframe's current regime, the strongest signal against,
 * and the composite's record and stability on 4h (or the heaviest timeframe present).
 */
export function explainVerdict(timeframes, overall, weights = TF_WEIGHTS) {
  const direction = overall?.state === 'bull' ? 1 : overall?.state === 'bear' ? -1 : 0;
  const byPull = list => [...list].sort((a, b) => Math.abs(b.pull) - Math.abs(a.pull));
  const contributions = contributionsOf(timeframes, weights);
  const reasons = direction ? byPull(contributions.filter(c => Math.sign(c.score) === direction)) : byPull(contributions);
  const against = direction ? byPull(contributions.filter(c => Math.sign(c.score) === -direction))[0] ?? null : null;

  const present = Object.keys(timeframes).filter(tf => timeframes[tf]);
  const trustTf = timeframes[TRUST_TF] ? TRUST_TF : present.sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0))[0];
  const trustRegime = trustTf ? regimeKey(timeframes[trustTf].regime) : null;
  const composite = trustTf ? timeframes[trustTf].calibration?.composite : null;
  const strip = ({ pull, ...c }) => c;

  return {
    direction, state: overall?.state ?? 'n/a', score: overall?.score ?? null, strength: strengthOf(overall?.score),
    aligned: overall?.aligned ?? null,
    reasons: reasons.slice(0, 3).map(strip),
    against: against && strip(against),
    trust: trustTf ? { tf: trustTf, regime: trustRegime, record: recordIn(composite, trustRegime),
                       stability: composite?.stability ?? 'thin' } : null
  };
}
