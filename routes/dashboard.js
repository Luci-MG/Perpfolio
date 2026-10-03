import { getBinanceData } from '../lib/binance-account.js';
import { getHyperliquidData } from '../lib/hyperliquid.js';
import { isEnabled } from '../lib/venues.js';
import { legProtection, stopOrders } from '../stop-check.js';

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

const UNAVAILABLE = Object.freeze({ equity: 0, walletBalance: 0, marginPct: '0.0', marginUsed: 0, freeMargin: 0, maintMargin: 0,
  totalNtlPos: 0, accountLeverage: '0.00', assets: [], openPositions: [], openOrders: [], stopsKnown: true });

async function readVenues(opts) {
  const venues = ['hyperliquid', 'binance'];
  const reads = await Promise.allSettled([getHyperliquidData(opts), getBinanceData(opts)]);
  const failed = venues.filter((_, i) => reads[i].status === 'rejected');
  failed.forEach(v => console.warn(`[dashboard] ${v} read failed:`, reads[venues.indexOf(v)].reason.message));
  if (failed.length === venues.length) throw new Error(reads.map((r, i) => `${venues[i]}: ${r.reason.message}`).join('; '));
  const [hlData, bnData] = reads.map(r => (r.status === 'fulfilled' ? r.value : { ...UNAVAILABLE, error: r.reason.message }));
  return { hlData, bnData, failed };
}

function withStop(positions, orders, stopsKnown) {
  return positions.map(p => {
    if (!stopsKnown) return { ...p, stop: null, hasStop: null, stopKnown: false };
    const stop = legProtection(p, orders);
    return { ...p, stop, hasStop: !!stop, stopKnown: true };
  });
}

export function register(app) {
  app.get('/api/dashboard', async (req, res) => {
    try {
      const { hlData, bnData, failed } = await readVenues(req.query.fresh === '1' ? { maxAgeMs: 0 } : undefined);
      const summary = { ...buildSummary(hlData, bnData), partial: failed };
      const orders = stopOrders(bnData.openOrders, hlData.openOrders);

      res.json({
        ok: true,
        lastUpdated: new Date().toISOString(),
        venues: { binance: isEnabled('binance'), hyperliquid: isEnabled('hyperliquid') },
        summary,
        hyperliquid: {
          error:           hlData.error ?? null,
          equity:          hlData.equity.toFixed(2),
          marginPct:       hlData.marginPct,
          marginUsed:      hlData.marginUsed.toFixed(2),
          freeMargin:      hlData.freeMargin.toFixed(2),
          totalNtlPos:     hlData.totalNtlPos.toFixed(2),
          accountLeverage: hlData.accountLeverage,
          stopsKnown:      hlData.stopsKnown,
          positions:       withStop(hlData.openPositions, orders, hlData.stopsKnown),
          orders:          hlData.openOrders
        },
        binance: {
          error:       bnData.error ?? null,
          equity:      bnData.equity.toFixed(2),
          walletBalance: bnData.walletBalance.toFixed(2),
          marginPct:   bnData.marginPct,
          marginUsed:  bnData.marginUsed.toFixed(2),
          freeMargin:  bnData.freeMargin.toFixed(2),
          maintMargin: bnData.maintMargin.toFixed(2),
          assets:      bnData.assets,
          stopsKnown:  bnData.stopsKnown,
          positions:   withStop(bnData.openPositions, orders, bnData.stopsKnown),
          orders:      bnData.openOrders
        },
      });
    } catch (err) {
      console.warn('[dashboard]', err.message);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
