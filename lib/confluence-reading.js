// confluence-reading.js — one symbol's confluence reading across timeframes: every signal,
// its calibration and the combined verdict. Shared by the Confluence tab and the entry capture.

import * as cf from '../confluence.js';
import { refreshFundingMeta, symbolFilters } from './binance-meta.js';
import { CF_INFORMATIONAL, getKlinesTf, positioningSeries, publicGet, rowsOf } from './confluence-data.js';

/** Reads `symbol` (a USDM perpetual) on `tfs`, the verdict's session line for `session`; a timeframe without klines is null and listed in `dataGaps`. */
export async function readConfluence(symbol, tfs = Object.keys(cf.TIMEFRAMES), { session } = {}) {
  const isBtc = symbol === 'BTCUSDT';
  const [meta, fundingRaw, klines, positioning, btcKlines, btcHourly, assetHourly] = await Promise.all([
    refreshFundingMeta(),
    publicGet('/fapi/v1/fundingRate', { symbol, limit: 1000 }, 300e3),
    Promise.all(tfs.map(tf => getKlinesTf(symbol, tf))),
    Promise.all(tfs.map(tf => positioningSeries(symbol, tf))),
    isBtc ? null : Promise.all(tfs.map(tf => getKlinesTf('BTCUSDT', tf))),
    isBtc ? null : getKlinesTf('BTCUSDT', '1h'),
    isBtc ? null : getKlinesTf(symbol, '1h')
  ]);
  const fundingIntervalMs = (meta[symbol]?.intervalHours || 8) * 3600e3;
  const funding = rowsOf(fundingRaw, 'fundingTime', 'fundingRate');
  const btcCorr = isBtc ? null : cf.btcCorrelation(assetHourly?.candles, btcHourly?.candles);

  const timeframes = {};
  const dataGaps = [];
  tfs.forEach((tf, k) => {
    const kl = klines[k];
    if (!kl?.candles?.length) { dataGaps.push(`${tf}: no klines`); timeframes[tf] = null; return; }
    const deriv = { ...positioning[k], funding };
    for (const [name, rows] of Object.entries(deriv)) if (!rows.length) dataGaps.push(`${tf}: no ${name} series`);
    const informational = CF_INFORMATIONAL[tf] || [];
    const x = cf.buildIndicators(kl.candles, { tf, deriv, fundingIntervalMs });
    const now = cf.scoreTimeframe(x, { informational });
    const calibration = cf.calibrate(x, { informational });

    let btc = null;
    if (!isBtc && btcKlines?.[k]?.candles?.length) {
      const bx = cf.buildIndicators(btcKlines[k].candles, { tf });
      const bs = cf.scoreTimeframe(bx, { informational }).score;
      const adj = cf.btcAlignment(now.score, bs, btcCorr);
      btc = { score: bs, corr: btcCorr, discounted: adj.discounted, rawScore: now.score };
      now.score = adj.score;
      now.state = adj.score == null ? 'n/a' : cf.stateOf(adj.score);
    }

    timeframes[tf] = {
      ...now,
      signals: now.signals.map(s => ({ ...s, hit: cf.forRegime(calibration.signals[s.id], cf.regimeKey(now.regime)) })),
      calibration: { horizon: calibration.horizon, bars: calibration.bars, baseUp: calibration.baseUp,
        composite: calibration.composite },
      informational, btc,
      bars: x.n,
      lastClose: x.close.at(-1),
      lastClosedAt: kl.candles.at(-1).closeTime,
      live: kl.live ? { close: kl.live.close, openedAt: kl.live.t } : null,
      firstBarAt: kl.candles[0].t
    };
  });

  const overall = cf.combineTimeframes(timeframes);
  return {
    symbol,
    quote: symbolFilters[symbol]?.quoteAsset ?? null,
    fundingIntervalHours: fundingIntervalMs / 3600e3,
    lastFundingRate: funding.at(-1)?.v ?? null,
    timeframes,
    overall,
    verdict: cf.explainVerdict(timeframes, overall, cf.TF_WEIGHTS, { session }),
    tfWeights: Object.fromEntries(tfs.map(tf => [tf, cf.TF_WEIGHTS[tf]])),
    sources: cf.SOURCES,
    dataGaps
  };
}
