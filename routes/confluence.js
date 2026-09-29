import * as cf from '../confluence.js';
import { refreshFundingMeta, refreshSymbolFilters, symbolFilters } from '../lib/binance-meta.js';
import { CF_INFORMATIONAL, getKlinesTf, perpSymbols, positioningSeries, publicGet, rowsOf } from '../lib/confluence-data.js';

export function register(app) {
  app.get('/api/symbols', async (req, res) => {
    try {
      await refreshSymbolFilters();
      const symbols = perpSymbols().sort((a, b) => a.symbol.localeCompare(b.symbol));
      res.json({ ok: true, symbols });
    } catch (err) {
      console.error('[symbols]', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/confluence', async (req, res) => {
    try {
      const symbol = String(req.query.symbol || 'BTCUSDT').toUpperCase();
      if (!/^[A-Z0-9]{2,30}$/.test(symbol)) return res.status(400).json({ ok: false, error: 'invalid symbol' });
      await refreshSymbolFilters();
      const known = symbolFilters[symbol];
      if (Object.keys(symbolFilters).length && (!known || known.contractType !== 'PERPETUAL')) {
        return res.status(400).json({ ok: false, error: `${symbol} is not a Binance USDM perpetual` });
      }
      const tfs = String(req.query.tfs || Object.keys(cf.TIMEFRAMES).join(','))
        .split(',').filter(tf => cf.TIMEFRAMES[tf]);
      if (!tfs.length) return res.status(400).json({ ok: false, error: 'no valid timeframes' });

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
          signals: now.signals.map(s => ({ ...s, hit: calibration.signals[s.id] })),
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

      res.json({
        ok: true,
        lastUpdated: new Date().toISOString(),
        symbol,
        quote: known?.quoteAsset ?? null,
        fundingIntervalHours: fundingIntervalMs / 3600e3,
        lastFundingRate: funding.at(-1)?.v ?? null,
        timeframes,
        overall: cf.combineTimeframes(timeframes),
        tfWeights: Object.fromEntries(tfs.map(tf => [tf, cf.TF_WEIGHTS[tf]])),
        sources: cf.SOURCES,
        dataGaps
      });
    } catch (err) {
      console.error('[confluence]', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
