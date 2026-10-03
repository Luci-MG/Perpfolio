import { getBinanceData } from '../lib/binance-account.js';
import { getHyperliquidData } from '../lib/hyperliquid.js';
import { isEnabled } from '../lib/venues.js';
import { legOf, legStop, stopOrders } from '../stop-check.js';

function buildSummary(hlData, bnData) {
  const allPositions = [...hlData.openPositions, ...bnData.openPositions];
  const totalEquity  = hlData.equity + bnData.equity;
  const totalUpnl    = allPositions.reduce((s, p) => s + p.upnl, 0);
  const hlExposure   = hlData.openPositions.reduce((s, p) => s + p.sizeUsd, 0);
  const bnExposure   = bnData.openPositions.reduce((s, p) => s + p.sizeUsd, 0);
  const orderCount   = hlData.openOrders.length + bnData.openOrders.length;

  return {
    totalEquity:   totalEquity.toFixed(2),
    totalUpnl:     totalUpnl.toFixed(2),
    positionCount: allPositions.length,
    orderCount,
    hlExposure:    hlExposure.toFixed(2),
    bnExposure:    bnExposure.toFixed(2),
    totalExposure: (hlExposure + bnExposure).toFixed(2),
  };
}

export function register(app) {
  app.get('/api/dashboard', async (req, res) => {
    try {
      const [hlData, bnData] = await Promise.all([
        getHyperliquidData(),
        getBinanceData()
      ]);

      const summary = buildSummary(hlData, bnData);
      const orders = stopOrders(bnData.openOrders, hlData.openOrders);
      const withStop = positions => positions.map(p => ({ ...p, hasStop: !!legStop(orders, legOf(p), p.mark) }));

      res.json({
        ok: true,
        lastUpdated: new Date().toISOString(),
        venues: { binance: isEnabled('binance'), hyperliquid: isEnabled('hyperliquid') },
        summary,
        hyperliquid: {
          equity:          hlData.equity.toFixed(2),
          marginPct:       hlData.marginPct,
          marginUsed:      hlData.marginUsed.toFixed(2),
          freeMargin:      hlData.freeMargin.toFixed(2),
          totalNtlPos:     hlData.totalNtlPos.toFixed(2),
          accountLeverage: hlData.accountLeverage,
          positions:       withStop(hlData.openPositions),
          orders:          hlData.openOrders
        },
        binance: {
          equity:      bnData.equity.toFixed(2),
          marginPct:   bnData.marginPct,
          marginUsed:  bnData.marginUsed.toFixed(2),
          freeMargin:  bnData.freeMargin.toFixed(2),
          maintMargin: bnData.maintMargin.toFixed(2),
          assets:      bnData.assets,
          positions:   withStop(bnData.openPositions),
          orders:      bnData.openOrders
        },
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
