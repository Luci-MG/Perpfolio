// vol-estimator.js — Dynamic Stop Width composite volatility engine (ESM)
//
// Layers (Phases 1–3):
//   L1 ATR(14)        — base, reactive backward-looking vol
//   L2 BBW squeeze    — pre-breakout compression detector
//   L3 Funding adj    — crowded-positioning unwind risk
//   L4 Cross-asset    — BTC→alt vol lead-lag propagation
//
// All inputs are normalised candles { open, high, low, close, volume } oldest→newest.
// Every function degrades gracefully — missing data returns a neutral value so the
// caller can always produce a stop (see /api/volstops backfill logic in server.js).

// ─── ATR ─────────────────────────────────────────────────────────────────────

export function computeATR(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(
      c.high - c.low,
      Math.abs(c.high - p.close),
      Math.abs(c.low - p.close)
    ));
  }
  const recent = trs.slice(-period);
  const close = candles[candles.length - 1].close;
  if (!close) return null;
  return (recent.reduce((a, b) => a + b, 0) / period) / close;
}

// ─── BBW ─────────────────────────────────────────────────────────────────────

function computeBBW(candles, period = 20) {
  if (!Array.isArray(candles) || candles.length < period) return null;
  const closes = candles.slice(-period).map(c => c.close);
  const sma = closes.reduce((a, b) => a + b, 0) / period;
  if (!sma) return null;
  const std = Math.sqrt(closes.reduce((s, v) => s + (v - sma) ** 2, 0) / period);
  return (sma + 2 * std - (sma - 2 * std)) / sma;
}

export function percentileRank(value, history) {
  if (!history || !history.length) return 0.5;
  return history.filter(v => v < value).length / history.length;
}

function getSqueezeFactor(pctile) {
  if (pctile < 0.10) return 0.50;
  if (pctile < 0.20) return 0.30;
  if (pctile < 0.35) return 0.15;
  if (pctile < 0.80) return 0.00;
  return -0.05;
}

// Build a rolling series of BBW values from a candle series (used for percentile +
// as growing real history accumulated across polls).
export function buildBbwSeries(candles, period = 20) {
  const series = [];
  if (!Array.isArray(candles)) return series;
  for (let i = period; i <= candles.length; i++) {
    const bbw = computeBBW(candles.slice(0, i), period);
    if (bbw != null) series.push(bbw);
  }
  return series;
}

export function getBBWAdjustment(candles, bbwHistory) {
  const bbw = computeBBW(candles);
  if (bbw == null) return 1.0;
  return 1.0 + getSqueezeFactor(percentileRank(bbw, bbwHistory));
}

// ─── FUNDING ─────────────────────────────────────────────────────────────────
// fundingRate8h is the raw 8h rate as a fraction (e.g. 0.00012 = 0.012%).

export function getFundingAdjustment(fundingRate8h) {
  const abs = Math.abs(Number(fundingRate8h) || 0);
  if (abs < 0.0001) return 1.00;
  if (abs < 0.0003) return 1.10;
  if (abs < 0.0006) return 1.25;
  if (abs < 0.0010) return 1.45;
  return 1.65;
}

// ─── CROSS-ASSET ─────────────────────────────────────────────────────────────

export function computeReturns(candles) {
  const r = [];
  if (!Array.isArray(candles)) return r;
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    if (!prev) { r.push(0); continue; }
    r.push((candles[i].close - prev) / prev);
  }
  return r;
}

export function pearsonCorr(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  const xs = x.slice(-n), ys = y.slice(-n);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const num = xs.reduce((s, xi, i) => s + (xi - mx) * (ys[i] - my), 0);
  const dx = Math.sqrt(xs.reduce((s, xi) => s + (xi - mx) ** 2, 0));
  const dy = Math.sqrt(ys.reduce((s, yi) => s + (yi - my) ** 2, 0));
  return (dx * dy === 0) ? 0 : num / (dx * dy);
}

// Returns for the last `n` steps both series share, paired on candle open time. Pairing by
// index silently compared different hours whenever one cache was a bar staler, and one bar
// of lag was enough to take the correlation from 1.0 to 0.
function pairedReturns(a, b, n) {
  const byTime = new Map(b.filter(c => c?.t != null).map(c => [c.t, c.close]));
  const shared = a.filter(c => c?.t != null && byTime.has(c.t));
  if (shared.length < 3 || shared.length < Math.min(a.length, b.length) / 2) {
    return { x: computeReturns(a.slice(-(n + 1))), y: computeReturns(b.slice(-(n + 1))) };
  }
  const tail = shared.slice(-(n + 1));
  const x = [], y = [];
  for (let i = 1; i < tail.length; i++) {
    const a0 = tail[i - 1].close, b0 = byTime.get(tail[i - 1].t);
    if (!a0 || !b0) continue;
    x.push(tail[i].close / a0 - 1);
    y.push(byTime.get(tail[i].t) / b0 - 1);
  }
  return { x, y };
}

export function getCrossAssetAdj(btcCandles, assetCandles, btcAtrHistory) {
  if (!btcCandles?.length || !assetCandles?.length) return { adj: 1.0, corr: 0, ratio: null };
  const btcAtr = computeATR(btcCandles);
  if (btcAtr == null) return { adj: 1.0, corr: 0, ratio: null };
  const hist = (btcAtrHistory && btcAtrHistory.length) ? btcAtrHistory : [btcAtr];
  const sorted = [...hist].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] || btcAtr;
  const ratio = median ? btcAtr / median : 1;
  const { x, y } = pairedReturns(btcCandles, assetCandles, 20);
  const corr = Math.max(0, pearsonCorr(x, y));
  let base = 0;
  if (ratio < 1.2) base = 0.00;
  else if (ratio < 1.6) base = 0.15;
  else if (ratio < 2.2) base = 0.30;
  else base = 0.50;
  return { adj: 1.0 + base * corr, corr, ratio };
}

// Build rolling ATR series from a candle series (for btcAtrHistory median).
export function buildAtrSeries(candles, period = 14) {
  const series = [];
  if (!Array.isArray(candles)) return series;
  for (let i = period + 1; i <= candles.length; i++) {
    const atr = computeATR(candles.slice(0, i), period);
    if (atr != null) series.push(atr);
  }
  return series;
}

// Hedge health for one net-long leg against one net-short leg.
//
// Correlation risk lives BETWEEN assets. Two legs of the same symbol are perfectly
// correlated by construction, so pairing an asset with itself can only ever return ~1.0 —
// what matters there is net delta, not correlation. `x` and `y` are the long and short
// legs' return series, already paired on equal timestamps by the caller.
//
// Reports correlation and hedge ratio only. Anything derived from the legs' full notionals
// — implied size, residual delta — is correct only when the book holds a single pair; with
// several pairs it charges the same short notional against every long it sits opposite.
// Exposure is therefore answered once, at book level, by the remainder that
// `matchHedgeLegs` could not pair.
export function assessHedgePair({
  x, y, longAsset, shortAsset,
  recent = 72, baseline = 480, threshold = 0.5, drop = 0.25
}) {
  const n = Math.min(x?.length || 0, y?.length || 0);
  if (n < 20) {
    return { longAsset, shortAsset, samples: n, status: 'unknown',
             warning: `Not enough paired history for ${longAsset}/${shortAsset} (${n} bars)` };
  }

  const recentN   = Math.min(recent, n);
  const baselineN = Math.min(baseline, n);
  const corrRecent   = pearsonCorr(x.slice(-recentN), y.slice(-recentN));
  const corrBaseline = pearsonCorr(x.slice(-baselineN), y.slice(-baselineN));

  const xb = x.slice(-baselineN), yb = y.slice(-baselineN);
  const mx = xb.reduce((a, b) => a + b, 0) / baselineN;
  const my = yb.reduce((a, b) => a + b, 0) / baselineN;
  const cov  = xb.reduce((s, v, i) => s + (v - mx) * (yb[i] - my), 0) / (baselineN - 1);
  const varX = xb.reduce((s, v) => s + (v - mx) ** 2, 0) / (baselineN - 1);
  const beta = varX === 0 ? 1 : cov / varX;

  const flags = [];
  if (corrRecent < threshold)           flags.push('broken');
  if (corrRecent < corrBaseline - drop) flags.push('degrading');
  if (n < 100)                          flags.push('thin');
  const status = flags.find(f => f !== 'thin') || (flags.length ? 'thin' : 'intact');

  const pair = `${longAsset} long / ${shortAsset} short`;
  const signed = v => v.toFixed(2).replace('-', '−');
  const warning =
      flags.includes('broken')    ? `${pair}: correlation ${signed(corrRecent)} over the last ${recentN}h is below ${threshold} — these legs are no longer hedging each other`
    : flags.includes('degrading') ? `${pair}: correlation fell from ${signed(corrBaseline)} to ${signed(corrRecent)} — the hedge is decaying`
    : null;

  return {
    longAsset, shortAsset, samples: n, status, flags, warning,
    corrRecent:   +corrRecent.toFixed(4),
    corrBaseline: +corrBaseline.toFixed(4),
    beta:         +beta.toFixed(3)
  };
}

// Match net-long legs against net-short legs into a partition, largest first, so every
// dollar of exposure is accounted for exactly once. Amounts are expected in a common unit
// (BTC-equivalent delta), and whatever cannot be matched is the book's naked exposure.
export function matchHedgeLegs(longs, shorts, dust = 50) {
  const L  = longs.map(([asset, amount]) => ({ asset, left: Math.abs(amount) }))
                  .sort((a, b) => b.left - a.left);
  const S  = shorts.map(([asset, amount]) => ({ asset, left: Math.abs(amount) }))
                  .sort((a, b) => b.left - a.left);

  const pairs = [];
  let i = 0, j = 0;
  while (i < L.length && j < S.length) {
    const matched = Math.min(L[i].left, S[j].left);
    if (matched > dust) pairs.push({ longAsset: L[i].asset, shortAsset: S[j].asset, matched });
    L[i].left -= matched;
    S[j].left -= matched;
    if (L[i].left <= dust) i++;
    if (S[j].left <= dust) j++;
  }

  return {
    pairs,
    unmatchedLong:  +L.reduce((s, e) => s + e.left, 0).toFixed(2),
    unmatchedShort: +S.reduce((s, e) => s + e.left, 0).toFixed(2)
  };
}

// Weighted mean across series of differing length, aligned from the most recent element
// backwards. Every series here is derived from 1h candles ending at the same poll, so
// trailing-index alignment matches timestamp alignment.
export function weightedSeriesMean(entries) {
  const usable = (entries || []).filter(e => e.series?.length && e.weight > 0);
  if (!usable.length) return [];
  const len = Math.min(...usable.map(e => e.series.length));
  const wSum = usable.reduce((s, e) => s + e.weight, 0);
  const out = new Array(len);
  for (let i = 0; i < len; i++) {
    let acc = 0;
    for (const e of usable) acc += e.series[e.series.length - len + i] * e.weight;
    out[i] = acc / wSum;
  }
  return out;
}

// ─── COMPOSITE ───────────────────────────────────────────────────────────────

export function computeCompositeVol({ atrPct, bbwAdj, fundingAdj, crossAssetAdj, kronosVol }) {
  const adjusted = atrPct * bbwAdj * fundingAdj * crossAssetAdj;
  if (kronosVol != null) {
    return adjusted * 0.90 + kronosVol * 0.10;
  }
  return adjusted;
}

// Build a rolling composite-vol series for regime classification. Uses ATR series
// as the spine and applies the (static, latest) adjustment multipliers — an
// approximation of historical composite vol sufficient for relative regime banding.
export function buildCompositeVolSeries(candles, { bbwAdj = 1, fundingAdj = 1, crossAssetAdj = 1 } = {}) {
  const atrSeries = buildAtrSeries(candles);
  return atrSeries.map(a => a * bbwAdj * fundingAdj * crossAssetAdj);
}

// ─── REGIME ──────────────────────────────────────────────────────────────────

export function classifyRegime(compositeVol, volHistory) {
  if (!volHistory || volHistory.length < 10) return 'medium';
  const s = [...volHistory].sort((a, b) => a - b);
  const pct = (q) => s[Math.floor(s.length * q)];
  if (compositeVol < pct(0.25)) return 'low';
  if (compositeVol < pct(0.75)) return 'medium';
  if (compositeVol < pct(0.90)) return 'high';
  return 'extreme';
}

// ─── STOP ENGINE ─────────────────────────────────────────────────────────────

// Cents are meaningless for a sub-dollar asset: at 1e-5 a 2-decimal round returns zero.
function roundToPrice(price) {
  const abs = Math.abs(price);
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 6 : 8;
  return +price.toFixed(decimals);
}

export function computeDynamicStop({
  entryPrice,
  accountSize,
  riskPct = 0.01,
  compositeVolPct,
  k = 1.5,
  regimeLabel = 'medium',
  direction = 'long'
}) {
  const REGIME_MULT = { low: 1.00, medium: 0.75, high: 0.50, extreme: 0.10 };
  const regimeMult = REGIME_MULT[regimeLabel] ?? 0.75;
  const stopDist = compositeVolPct * k;
  const dollarRisk = accountSize * riskPct;
  const rawSize = (entryPrice && stopDist) ? dollarRisk / (entryPrice * stopDist) : 0;
  const adjSize = rawSize * regimeMult;

  const priceFloor = entryPrice * 0.001;
  const stopPrice = direction === 'long'
    ? Math.max(priceFloor, entryPrice * (1 - stopDist))
    : entryPrice * (1 + stopDist);
  const targetPrice = direction === 'long'
    ? entryPrice * (1 + stopDist * 2)
    : Math.max(priceFloor, entryPrice * (1 - stopDist * 2));

  return {
    entryPrice,
    stopPrice:       roundToPrice(stopPrice),
    targetPrice:     roundToPrice(targetPrice),
    stopDistPct:     +(stopDist * 100).toFixed(3),
    positionSize:    +adjSize.toFixed(6),
    notionalValue:   +(adjSize * entryPrice).toFixed(2),
    dollarRisk:      +dollarRisk.toFixed(2),
    regimeMult,
    compositeVolPct: +(compositeVolPct * 100).toFixed(3),
    direction
  };
}

// ─── BACKFILL ────────────────────────────────────────────────────────────────
// When candles are unavailable for a symbol, synthesize a minimal series from the
// data we DO have (entry, mark, day range, funding). This guarantees every open
// position still produces a stop. The result is intentionally low-resolution; the
// caller tags the position as backfilled so the UI can mark it "estimated".
//
// ctx: { entry, mark, prevDayPx, fundingRate8h }
export function synthSeriesFromPosition(ctx) {
  const entry = Number(ctx.entry) || 0;
  const mark = Number(ctx.mark) || entry || 1;
  const prevDay = Number(ctx.prevDayPx) || 0;

  // Estimate a per-candle range. Prefer the realised daily move (prevDay→mark);
  // fall back to entry→mark drift; floor at a small baseline so vol is never zero.
  let dayMovePct = 0;
  if (prevDay > 0) dayMovePct = Math.abs(mark - prevDay) / prevDay;
  else if (entry > 0) dayMovePct = Math.abs(mark - entry) / entry;
  // Spread the daily move across ~24 hourly candles (sqrt-time scaling) + a floor.
  const perCandleRange = Math.max(0.003, dayMovePct / Math.sqrt(24));

  // Generate a deterministic series oscillating ±perCandleRange around mark so ATR
  // and BBW have something coherent to chew on.
  const n = 30;
  const series = [];
  for (let i = 0; i < n; i++) {
    const wobble = Math.sin(i * 1.3) * perCandleRange * mark * 0.5;
    const base = mark + wobble;
    const half = perCandleRange * mark * 0.5;
    series.push({
      open: base - half * 0.3,
      high: base + half,
      low: base - half,
      close: base,
      volume: 0
    });
  }
  return series;
}
