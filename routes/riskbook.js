import { lastReconcile, lastWsMessage } from '../lib/orders-stream.js';
import { describePool, reportedLiq, resolvePools } from '../lib/pools.js';
import { isEnabled, venueOffBody } from '../lib/venues.js';

export function register(app) {
  app.get('/api/riskbook', async (req, res) => {
    if (!isEnabled('binance')) return res.status(409).json(venueOffBody('binance'));
    try {
      const { bn, pools: groups } = await resolvePools(req.query.fresh === '1' ? { maxAgeMs: 0 } : undefined);
      const pools = await Promise.all(groups.map(describePool));

      res.json({
        ok: true,
        lastUpdated: new Date().toISOString(),
        pools,
        account: {
          crossWalletBalance:  +bn.crossWalletBalance.toFixed(2),
          marginBalance:       +bn.marginBalance.toFixed(2),
          availableBalance:    +bn.availBal.toFixed(2),
          reportedMaintMargin: +bn.maintMargin.toFixed(2),
          multiAssetsMode:     bn.multiAssetsMode,
          marginAssets:        bn.marginAssets,
          orderFeed: {
            lastReconcileAt: lastReconcile.at,
            lastDrift: lastReconcile.added + lastReconcile.removed,
            lastWsMessageAgeSec: lastWsMessage ? Math.round((Date.now() - lastWsMessage) / 1000) : null
          }
        },
        isolated: bn.openPositions.filter(p => p.isolated).map(p => ({
          pair: p.pair, asset: p.asset, side: p.side, wallet: p.isolatedWallet,
          liqPrice: reportedLiq(p), upnl: p.upnl
        }))
      });
    } catch (err) {
      console.error('[riskbook]', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
