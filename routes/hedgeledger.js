import { perDay as fundingPerDay } from '../funding.js';
import * as risk from '../risk-engine.js';
import * as ta from '../trade-analytics.js';
import { analytics } from '../lib/analytics.js';
import { fundingMeta } from '../lib/binance-meta.js';
import { calibrate, marksOf, resolvePools } from '../lib/pools.js';
import { isEnabled, venueOffBody } from '../lib/venues.js';

export function register(app) {
  // ── Hedge ledger ──────────────────────────────────────────────────────────────
  app.get('/api/hedgeledger', async (req, res) => {
    if (!isEnabled('binance')) return res.status(409).json(venueOffBody('binance'));
    try {
      const { bn, pools: groups } = await resolvePools();
      const { income } = analytics();

      const pools = groups.map(g => {
        const marks = marksOf(g.positions);
        const { tierMode } = calibrate(g.pool, marks, g.positions, g.reported);
        const opts = { perSideTiers: tierMode === 'perSide' };
        const ledger = risk.lockedPnl(g.pool, marks);
        const state = risk.evalPool(g.pool, marks, opts);

        // carry, using the settlement cadence actually observed rather than the declared one
        const carry = g.positions.map(p => {
          const observed = ta.inferFundingInterval(income, p.symbol);
          const hours = observed.inferredHours ?? fundingMeta[p.symbol]?.intervalHours ?? 8;
          const perDay = fundingPerDay({ ...p, fundingIntervalHours: hours });
          return { key: `${p.symbol}:${p.positionSide}`, asset: p.asset, side: p.side,
                   notional: +p.sizeUsd.toFixed(2), ratePct: +(p.fundingRate ?? 0).toFixed(5),
                   intervalHours: hours,
                   declaredHours: fundingMeta[p.symbol]?.intervalHours ?? null,
                   observedHours: observed.inferredHours,
                   settlementsSeen: observed.settlements,
                   perDay: +perDay.toFixed(2) };
        });

        return {
          marginAsset: g.marginAsset,
          ...ledger,
          inflation: risk.marginUnderMove(g.pool, marks, [0, 25, 50, 100, 200], opts),
          carryPerDay: +carry.reduce((s, c) => s + c.perDay, 0).toFixed(2),
          carry,
          marginLocked: +state.im.toFixed(2),
          equity: +state.equity.toFixed(2),
          grossNotional: +state.positions.reduce((s, p) => s + p.notional, 0).toFixed(2)
        };
      });

      res.json({ ok: true, lastUpdated: new Date().toISOString(),
                 multiAssetsMode: bn.multiAssetsMode, pools });
    } catch (err) {
      console.error('[hedgeledger]', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
