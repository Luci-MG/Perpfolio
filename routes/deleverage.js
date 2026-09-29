import * as risk from '../risk-engine.js';
import { calibrate, marksOf, resolvePools } from '../lib/pools.js';

export function register(app) {
  // ── Unwind planner ────────────────────────────────────────────────────────────
  // Closing a position does not change equity — realised PnL replaces unrealised one for
  // one. What it releases is margin: initial margin becomes free margin, maintenance margin
  // becomes liquidation buffer. Free margin is therefore capped by equity no matter what is
  // closed, which is why every response leads with the ceiling.
  app.get('/api/deleverage', async (req, res) => {
    try {
      const objective = req.query.objective === 'buffer' ? 'buffer' : 'free';
      const feeRate   = Math.max(0, Math.min(0.01, parseFloat(req.query.fee) || 0.00045));
      const target    = parseFloat(req.query.target);
      const maxLossIn = Math.abs(parseFloat(req.query.maxLoss));
      const maxLoss   = Number.isFinite(maxLossIn) ? maxLossIn : Infinity;
      const allowBreakingHedges = req.query.breakHedges === 'true';

      const { bn, pools: groups } = await resolvePools();

      const plans = groups.map(g => {
        const marks = marksOf(g.positions);
        // the same tier-lookup mode the stress panel calibrated to, so both endpoints agree
        // on maintenance margin rather than one quietly assuming a default
        const { tierMode } = calibrate(g.pool, marks, g.positions, g.reported);
        const opts = { perSideTiers: tierMode === 'perSide', feeRate };
        const keyed = Object.fromEntries(g.positions.map(p => [`${p.symbol}:${p.positionSide}`, p]));

        const plan = risk.deleveragePlan(g.pool, marks, {
          ...opts, objective,
          target: isFinite(target) ? target : Infinity,
          maxRealizedLoss: maxLoss,
          allowBreakingHedges
        });

        const { resultPool, ...rest } = plan;
        return {
          marginAsset: g.marginAsset,
          marks,
          ...rest,
          // what is left standing, and where it would liquidate
          remaining: risk.evalPool(resultPool, marks, opts).positions.map(p => ({
            asset: p.asset, positionSide: p.positionSide, notional: +p.notional.toFixed(2),
            upnl: +p.upnl.toFixed(2)
          })),
          thresholdsAfter: Object.keys(marks).map(asset => {
            const k = risk.killPricesBoth(resultPool, asset, marks, opts).buffer;
            return { asset,
                     upPct:   k.up   == null ? null : +k.upPct.toFixed(2),
                     downPct: k.down == null ? null : +k.downPct.toFixed(2) };
          }),
          steps: rest.steps.map(s => ({
            ...s,
            legs: s.closes.map(c => {
              const p = keyed[c.key];
              return { key: c.key, asset: p?.asset, positionSide: p?.positionSide,
                       qty: +(c.qty ?? Math.abs(p?.sizeRaw ?? 0)).toFixed(8),
                       ofQty: Math.abs(p?.sizeRaw ?? 0) };
            })
          }))
        };
      });

      res.json({
        ok: true,
        lastUpdated: new Date().toISOString(),
        params: { objective, target: isFinite(target) ? target : null, feeRate,
                  maxLoss: isFinite(maxLoss) ? maxLoss : null, allowBreakingHedges },
        multiAssetsMode: bn.multiAssetsMode,
        plans
      });
    } catch (err) {
      console.error('[deleverage]', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
