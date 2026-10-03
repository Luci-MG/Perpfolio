import * as vol from '../vol-estimator.js';
import * as risk from '../risk-engine.js';
import { getBinanceData } from '../lib/binance-account.js';
import { getHyperliquidData } from '../lib/hyperliquid.js';
import { getBinanceKlines, getHlCandles } from '../lib/market-data.js';
import { isEnabled } from '../lib/venues.js';

// ── Dynamic Stop Width endpoint ───────────────────────────────────────────
// Computes a composite-volatility-based stop + position size for every open
// position across both exchanges. Missing inputs are backfilled (synthetic candle
// series, neutral multipliers, equity fallbacks) so every position yields a stop;
// backfilled fields are tagged per-position for the UI.

// Derive the base asset symbol from a normalised pair label.
function baseAsset(pair) {
  return pair.replace(/-PERP$/i, '').replace(/\/(USDT|USDC|USD)$/i, '').toUpperCase();
}

// Fetch candles for a position; backfill from position context if unavailable.
async function candlesForPosition(p) {
  let candles = null;
  if (p.exchange === 'binance') candles = await getBinanceKlines(p.symbol);
  else candles = await getHlCandles(p.coin || baseAsset(p.pair));

  if (candles && candles.length >= 21) return { candles, backfilled: false };

  // Backfill: synthesize a series from entry/mark/funding.
  const synth = vol.synthSeriesFromPosition({
    entry: p.entry, mark: p.mark, prevDayPx: p.prevDayPx,
    fundingRate8h: (p.fundingRate || 0) / 100
  });
  return { candles: synth, backfilled: true };
}

export function register(app) {
  app.get('/api/volstops', async (req, res) => {
    try {
      const riskPct = Math.max(0, Math.min(0.5, parseFloat(req.query.risk) || 0.01));
      const k       = Math.max(0.1, Math.min(10, parseFloat(req.query.k) || 1.5));

      const [hlData, bnData] = await Promise.all([getHyperliquidData(), getBinanceData()]);

      const positions = [
        ...hlData.openPositions.map(p => ({ ...p, _equity: hlData.equity })),
        ...bnData.openPositions.map(p => ({ ...p, _equity: bnData.equity }))
      ];

      // BTC reference and every position's candles in one fan-out; `once` collapses the
      // duplicate requests the two legs of a hedge would otherwise make.
      const [bnBtc, ...candleSets] = await Promise.all([
        getBinanceKlines('BTCUSDT'),
        ...positions.map(p => candlesForPosition(p).catch(() => null))
      ]);
      let btcCandles = bnBtc;
      if ((!btcCandles || btcCandles.length < 21) && isEnabled('hyperliquid')) btcCandles = await getHlCandles('BTC');
      const btcAtrHistory = btcCandles ? vol.buildAtrSeries(btcCandles) : [];

      const totalEquity = (hlData.equity + bnData.equity) || 0;

      const results = [];
      const candlesByAsset = {};
      const volHistories = [];
      for (const [idx, p] of positions.entries()) {
        try {
          const backfilled = [];
          const { candles, backfilled: candlesBackfilled } = candleSets[idx] ?? await candlesForPosition(p);
          if (candlesBackfilled) backfilled.push('candles');

          // L1 ATR — with floor fallback if even synth fails to produce a value.
          let atrPct = vol.computeATR(candles);
          if (atrPct == null || !isFinite(atrPct)) {
            atrPct = 0.01;                       // 1% baseline floor
            if (!backfilled.includes('candles')) backfilled.push('atr');
          }

          // L2 BBW squeeze
          const bbwHistory = vol.buildBbwSeries(candles);
          const bbwAdj = vol.getBBWAdjustment(candles, bbwHistory);
          if (bbwHistory.length < 20) backfilled.push('bbw');

          // L3 Funding
          const fundingRate8h = (p.fundingRate ?? 0) / 100;   // dashboard stores raw %
          const fundingAdj = vol.getFundingAdjustment(fundingRate8h);
          if (p.fundingRate == null) backfilled.push('funding');

          // L4 Cross-asset
          let crossAdj = 1.0, crossCorr = 0, crossRatio = null;
          if (btcCandles && !candlesBackfilled) {
            const x = vol.getCrossAssetAdj(btcCandles, candles, btcAtrHistory);
            crossAdj = x.adj; crossCorr = x.corr; crossRatio = x.ratio;
          } else {
            backfilled.push('crossAsset');
          }

          // Composite + regime
          const compositeVol = vol.computeCompositeVol({
            atrPct, bbwAdj, fundingAdj, crossAssetAdj: crossAdj, kronosVol: null
          });
          const volSeries = vol.buildCompositeVolSeries(candles, { bbwAdj, fundingAdj, crossAssetAdj: crossAdj });
          if (volSeries.length < 10) backfilled.push('regimeHistory');
          const regimeLabel = vol.classifyRegime(compositeVol, volSeries);

          const assetKey = p.asset || baseAsset(p.pair);
          if (!candlesByAsset[assetKey] && !candlesBackfilled) candlesByAsset[assetKey] = candles;
          volHistories.push({ key: `${p.exchange}:${p.pair}:${p.side}`, series: volSeries,
                              weight: Math.abs(p.sizeUsd) || 1 });

          // Account size: live exchange equity; fall back to total then exposure.
          let accountSize = p._equity;
          if (!accountSize || accountSize <= 0) {
            accountSize = totalEquity > 0 ? totalEquity : (p.sizeUsd || 0);
            backfilled.push('equity');
          }

          const direction = p.side === 'Long' ? 'long' : 'short';
          const stop = vol.computeDynamicStop({
            entryPrice: p.entry,
            accountSize,
            riskPct,
            compositeVolPct: compositeVol,
            k,
            regimeLabel,
            direction
          });

          results.push({
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
              crossAdj:  +crossAdj.toFixed(3),
              crossCorr: +crossCorr.toFixed(3),
              crossRatio: crossRatio != null ? +crossRatio.toFixed(2) : null
            },
            accountSize: +accountSize.toFixed(2),
            backfilled
          });
        } catch (perr) {
          // Never let one position break the panel.
          results.push({
            pair: p.pair, exchange: p.exchange, side: p.side, entry: p.entry, mark: p.mark,
            error: perr.message, backfilled: ['error']
          });
        }
      }

      // ── Combined portfolio view ──
      const valid = results.filter(r => !r.error && r.compositeVolPct != null);
      const totalDollarRisk = valid.reduce((s, r) => s + (r.dollarRisk || 0), 0);
      const regimeCounts = { low: 0, medium: 0, high: 0, extreme: 0 };
      valid.forEach(r => { if (regimeCounts[r.regimeLabel] != null) regimeCounts[r.regimeLabel]++; });

      // Equity-weighted portfolio composite vol → portfolio regime.
      let wSum = 0, wVol = 0;
      valid.forEach(r => {
        const w = r.notionalValue || 1;
        wSum += w; wVol += (r.compositeVolPct || 0) * w;
      });
      const portfolioVol = wSum ? wVol / wSum : 0;

      // Classify against the portfolio's own history, not a cross-section of the positions
      // it is made of: a notional-weighted mean of N positions necessarily lands between
      // their 25th and 75th percentiles, so the old reading returned 'medium' for any book.
      const portfolioVolSeries = vol.weightedSeriesMean(volHistories);
      const portfolioRegime = vol.classifyRegime(portfolioVol / 100, portfolioVolSeries);
      const regimeBasis = portfolioVolSeries.length >= 10
        ? { bars: portfolioVolSeries.length,
            percentile: +(portfolioVolSeries.filter(v => v < portfolioVol / 100).length
                          / portfolioVolSeries.length * 100).toFixed(1) }
        : { bars: portfolioVolSeries.length, percentile: null };

      // ── Hedge-pair health ──
      // Correlation risk is BETWEEN assets. Netting per asset first means the two legs of a
      // same-symbol hedge collapse into a single delta (they cannot decorrelate from
      // themselves), and what remains is the book's real hedge structure: whatever is net
      // long against whatever is net short.
      const netByAsset = {};
      positions.forEach(p => {
        const a = p.asset || baseAsset(p.pair);
        const signed = (p.side === 'Long' ? 1 : -1) * (p.sizeUsd || 0);
        netByAsset[a] = (netByAsset[a] || 0) + signed;
      });

      const DUST = 50;   // residual delta too small to count as a hedge leg

      // Every net delta restated as BTC-equivalent, so legs of different volatility can be
      // matched against each other on comparable terms.
      const betaByAsset = {}, btcEquiv = {};
      for (const [asset, net] of Object.entries(netByAsset)) {
        const { x, y } = risk.alignedReturns(candlesByAsset[asset], btcCandles);
        betaByAsset[asset] = x.length > 2 ? +risk.beta(x, y).toFixed(3) : 1;
        btcEquiv[asset] = net * betaByAsset[asset];
      }

      const equivLongs  = Object.entries(btcEquiv).filter(([, v]) => v >  DUST);
      const equivShorts = Object.entries(btcEquiv).filter(([, v]) => v < -DUST);
      const { pairs: matched, unmatchedLong, unmatchedShort } =
        vol.matchHedgeLegs(equivLongs, equivShorts, DUST);

      const hedgePairs = matched.map(m => {
        const { x, y } = risk.alignedReturns(candlesByAsset[m.longAsset], candlesByAsset[m.shortAsset]);
        return {
          ...vol.assessHedgePair({ x, y, longAsset: m.longAsset, shortAsset: m.shortAsset }),
          longNet:  +netByAsset[m.longAsset].toFixed(2),
          shortNet: +netByAsset[m.shortAsset].toFixed(2),
          matchedBtcEquiv: +m.matched.toFixed(2)
        };
      }).sort((a, b) => (b.matchedBtcEquiv || 0) - (a.matchedBtcEquiv || 0));
      const hedgeWarnings = hedgePairs.filter(h => h.warning).map(h => ({ asset: `${h.longAsset}/${h.shortAsset}`, ...h }));

      // Same-symbol both-sides positions carry net delta but no correlation exposure —
      // reported so it is clear they were considered rather than skipped.
      const nettedSymbols = Object.entries(
        positions.reduce((acc, p) => {
          const a = p.asset || baseAsset(p.pair);
          (acc[a] = acc[a] || new Set()).add(p.side);
          return acc;
        }, {})
      ).filter(([, sides]) => sides.size > 1)
       .map(([asset]) => ({ asset, netDelta: +(netByAsset[asset] || 0).toFixed(2) }));

      // Whether the book is actually neutral. The unmatched leftover from the pairing is the
      // same quantity arrived at independently, so the two must agree.
      const rawNet = Object.values(netByAsset).reduce((s, v) => s + v, 0);
      const betaAdjustedNet = Object.values(btcEquiv).reduce((s, v) => s + v, 0);
      const nakedBtcEquiv = unmatchedLong - unmatchedShort;

      res.json({
        ok: true,
        lastUpdated: new Date().toISOString(),
        params: { riskPct, k },
        combined: {
          portfolioRegime,
          regimeBasis,
          portfolioVolPct: +portfolioVol.toFixed(3),
          totalDollarRisk: +totalDollarRisk.toFixed(2),
          totalEquity:     +totalEquity.toFixed(2),
          hlEquity:        +hlData.equity.toFixed(2),
          bnEquity:        +bnData.equity.toFixed(2),
          positionCount:   valid.length,
          regimeCounts,
          netByAsset,
          betaByAsset,
          rawNet:          +rawNet.toFixed(2),
          betaAdjustedNet: +betaAdjustedNet.toFixed(2),
          nakedBtcEquiv:   +nakedBtcEquiv.toFixed(2),
          unmatchedLong,
          unmatchedShort,
          nettedSymbols,
          hedgePairs,
          hedgeWarnings
        },
        positions: results
      });
    } catch (err) {
      console.error('[volstops]', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
