// stop-suggestion.js — the volatility-adjusted stop and size for one position: composite
// volatility from ATR, squeeze, funding and BTC, its regime, then the stop. Shared by the Stops
// tab and the entry capture.

import * as vol from '../vol-estimator.js';

const ATR_FLOOR = 0.01;

function atrLayer(candles, backfilled) {
  const atrPct = vol.computeATR(candles);
  if (atrPct != null && isFinite(atrPct)) return atrPct;
  if (!backfilled.includes('candles')) backfilled.push('atr');
  return ATR_FLOOR;
}

function squeezeLayer(candles, backfilled) {
  const bbwHistory = vol.buildBbwSeries(candles);
  if (bbwHistory.length < 20) backfilled.push('bbw');
  return vol.getBBWAdjustment(candles, bbwHistory);
}

function fundingLayer(p, backfilled) {
  if (p.fundingRate == null) backfilled.push('funding');
  const intervalHours = p.fundingIntervalHours > 0 ? p.fundingIntervalHours : 8;
  return vol.getFundingAdjustment((p.fundingRate ?? 0) * (8 / intervalHours) / 100);
}

function crossAssetLayer({ btcCandles, candles, candlesBackfilled, btcAtrHistory }, backfilled) {
  if (!btcCandles || candlesBackfilled) {
    backfilled.push('crossAsset');
    return { adj: 1.0, corr: 0, ratio: null };
  }
  return vol.getCrossAssetAdj(btcCandles, candles, btcAtrHistory);
}

function accountSizeFor(p, totalEquity, backfilled) {
  if (p._equity > 0) return p._equity;
  backfilled.push('equity');
  return totalEquity > 0 ? totalEquity : (p.sizeUsd || 0);
}

/**
 * Stop, size and vol layers for position `p` on `candles`. Missing inputs are backfilled and
 * named in `result.backfilled`; `volSeries` is the position's composite-vol history.
 */
export function suggestStop(p, { candles, candlesBackfilled, btcCandles, btcAtrHistory, totalEquity, riskPct, k }) {
  const backfilled = candlesBackfilled ? ['candles'] : [];
  const atrPct = atrLayer(candles, backfilled);
  const bbwAdj = squeezeLayer(candles, backfilled);
  const fundingAdj = fundingLayer(p, backfilled);
  const cross = crossAssetLayer({ btcCandles, candles, candlesBackfilled, btcAtrHistory }, backfilled);

  const compositeVol = vol.computeCompositeVol({
    atrPct, bbwAdj, fundingAdj, crossAssetAdj: cross.adj, kronosVol: null
  });
  const volSeries = vol.buildCompositeVolSeries(candles, { bbwAdj, fundingAdj, crossAssetAdj: cross.adj });
  if (volSeries.length < 10) backfilled.push('regimeHistory');
  const regimeLabel = vol.classifyRegime(compositeVol, volSeries);
  const accountSize = accountSizeFor(p, totalEquity, backfilled);

  const stop = vol.computeDynamicStop({
    entryPrice: p.entry,
    accountSize,
    riskPct,
    compositeVolPct: compositeVol,
    k,
    regimeLabel,
    direction: p.side === 'Long' ? 'long' : 'short'
  });

  const result = {
    pair:        p.pair,
    exchange:    p.exchange,
    side:        p.side,
    entry:       p.entry,
    mark:        p.mark,
    ...stop,
    regimeLabel,
    allowTrend:   vol.shouldTakeEntry(regimeLabel, 'trend'),
    allowMeanRev: vol.shouldTakeEntry(regimeLabel, 'meanRev'),
    allowBreakout:vol.shouldTakeEntry(regimeLabel, 'breakout'),
    layers: {
      atrPct:    +(atrPct * 100).toFixed(3),
      bbwAdj:    +bbwAdj.toFixed(3),
      fundingAdj:+fundingAdj.toFixed(3),
      crossAdj:  +cross.adj.toFixed(3),
      crossCorr: +cross.corr.toFixed(3),
      crossRatio: cross.ratio != null ? +cross.ratio.toFixed(2) : null
    },
    accountSize: +accountSize.toFixed(2),
    backfilled
  };
  return { result, volSeries };
}
