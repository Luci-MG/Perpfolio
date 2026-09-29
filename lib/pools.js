// pools.js — builds the per-collateral cross pools the stress engine runs on, and scores them
// against the exchange's own reported margin figures.

import * as vol from '../vol-estimator.js';
import * as risk from '../risk-engine.js';
import { getBinanceData } from './binance-account.js';
import { commissionFor, getBinanceLeverageBrackets, getBook, refreshSymbolFilters, symbolFilters } from './binance-meta.js';
import { getBinanceKlines } from './market-data.js';

// Fallback when the bracket table is unavailable: infer a flat rate from the one
// maintenance-margin number Binance reports per position. A single observation
// cannot separate rate from cum deduction, so cum is assumed 0 and the position is
// tagged estimated.
function inferredBrackets(p) {
  const notional = Math.abs(p.sizeRaw) * p.mark;
  const mmr = (p.reportedMm > 0 && notional > 0) ? p.reportedMm / notional : 0.005;
  return [{ notionalFloor: 0, notionalCap: 1e12, maintMarginRatio: mmr, cum: 0 }];
}

function toEnginePosition(p, info) {
  const hasTable = !!info?.brackets?.length;
  return {
    key:          `${p.symbol}:${p.positionSide}`,
    asset:        p.asset,
    symbol:       p.symbol,
    positionSide: p.positionSide,
    q:            p.sizeRaw,
    entry:        p.entry,
    mark:         p.mark,
    leverage:     p.leverageRaw || 1,
    brackets:     hasTable ? info.brackets : inferredBrackets(p),
    notionalCoef: info?.notionalCoef ?? 1,
    estimated:    !hasTable
  };
}

function toEngineOrder(o) {
  return {
    asset:        o.asset,
    positionSide: o.positionSide || 'BOTH',
    side:         o.side,
    q:            o.sizeRaw || 0,
    trigger:      o.stopPrice || o.price || 0,
    type:         o.type,
    closePosition: !!o.closePosition,
    reduceOnly:   !!o.reduceOnly
  };
}

// Per-asset beta to BTC and daily sigma, from the existing 1h candle cache. Candles
// are fetched by full symbol — ZECUSDC and ZECUSDT are separate books on the same
// underlying — and keyed by base asset, which is unique within one pool.
async function poolStats(positions) {
  // One fetch per asset, all in flight together. Serially this was the single largest cost
  // in the riskbook response.
  const unique = [...new Map(positions.map(p => [p.asset, p])).values()];
  const [btc, ...series] = await Promise.all([
    getBinanceKlines('BTCUSDT'),
    ...unique.map(p => getBinanceKlines(p.symbol))
  ]);

  const stats = {};
  unique.forEach((p, i) => {
    const candles = series[i];
    const own = candles ? vol.computeReturns(candles) : [];
    const { x, y } = risk.alignedReturns(candles, btc);
    stats[p.asset] = {
      dailySigmaPct: own.length > 2 ? +risk.dailySigmaPct(own).toFixed(3) : null,
      beta:          x.length > 2 ? +risk.beta(x, y).toFixed(3) : 1,
      bars:          candles?.length || 0,
      pairedBars:    x.length
    };
  });
  return stats;
}

// Binance applies MMR and cum per leg but brackets the tier on combined notional.
// Rather than trust that, both readings are scored against the maintenance margin the
// exchange reports per position and the closer one wins. Equity is checked against the
// asset's own marginBalance, so a wrong collateral base cannot pass silently.
export function calibrate(pool, marks, positions, reported) {
  const reportedMm = positions
    .filter(p => p.reportedMm != null)
    .reduce((sum, p) => sum + p.reportedMm, 0);

  const combined = risk.evalPool(pool, marks);
  const perSide  = risk.evalPool(pool, marks, { perSideTiers: true });
  const errOf    = (model, ref) => ref > 0 ? Math.abs(model - ref) / ref * 100 : null;
  const cErr = errOf(combined.mm, reportedMm), pErr = errOf(perSide.mm, reportedMm);

  const tierMode = (pErr != null && cErr != null && pErr < cErr) ? 'perSide' : 'combined';
  const chosen   = tierMode === 'perSide' ? perSide : combined;
  const mmErr    = errOf(chosen.mm, reportedMm);
  const eqErr    = errOf(chosen.equity, reported?.marginBalance);
  const freeErr  = errOf(chosen.freeUsable, reported?.availableBalance);
  const reportedIm = positions.filter(p => p.reportedIm != null).reduce((sum, p) => sum + p.reportedIm, 0);
  const imErr      = errOf(chosen.im, reportedIm);

  return {
    tierMode,
    modelMm:     +chosen.mm.toFixed(4),
    reportedMm:  +reportedMm.toFixed(4),
    mmErrPct:    mmErr == null ? null : +mmErr.toFixed(3),
    modelEquity: +chosen.equity.toFixed(2),
    reportedEquity: reported?.marginBalance ?? null,
    equityErrPct: eqErr == null ? null : +eqErr.toFixed(3),
    modelIm:     +chosen.im.toFixed(4),
    reportedIm:  +reportedIm.toFixed(4),
    imErrPct:    imErr == null ? null : +imErr.toFixed(3),
    modelFree:   +chosen.freeUsable.toFixed(2),
    reportedFree: reported?.availableBalance ?? null,
    freeErrPct:  freeErr == null ? null : +freeErr.toFixed(3),
    freeAnchored: reported?.availableBalance > 0,
    freeReserved: +(pool.freeReserved || 0).toFixed(2),
    openOrderHold: reported?.openOrderInitialMargin ?? null,
    transferable: reported?.maxWithdrawAmount ?? null,
    trustworthy: mmErr != null && mmErr < 1 && (eqErr == null || eqErr < 1)
                 && (imErr == null || imErr < 1),
    estimatedBrackets: pool.positions.some(p => p.estimated),
    perPosition: chosen.positions.map(d => {
      const src = positions.find(p => `${p.symbol}:${p.positionSide}` === d.key);
      const rep = src?.reportedMm ?? null;
      return {
        key: d.key,
        modelMm:    +d.mm.toFixed(4),
        reportedMm: rep,
        errPct:     rep > 0 ? +(Math.abs(d.mm - rep) / rep * 100).toFixed(3) : null
      };
    })
  };
}

// Binance publishes an absurd sentinel (hundreds of millions) as the liquidation price
// of a position it considers unreachable — both legs of a flat hedge get one.
export function reportedLiq(p) {
  const v = p.reportedLiqPrice;
  return (v > 0 && v < p.mark * 50) ? v : null;
}

// Cross-check: the pool-aware threshold should reproduce the liquidation price Binance
// reports, since their formula holds every other contract fixed exactly as this scan
// does. One caveat, and it is not an error: their published figure freezes each margin
// tier at the current notional, while their live engine re-tiers as notional moves
// ("MMR at the level of position notional"). Where a threshold crosses a bracket
// boundary the two legitimately differ, so both readings are reported — the frozen one
// is what validates the arithmetic, the re-tiered one is what should actually happen.
function liqCrossCheck(pool, marks, positions, opts) {
  const frozenPool = risk.freezeTiers(pool, marks);
  const cache = {}, frozenCache = {}, detailCache = {};
  return positions.map(p => {
    cache[p.asset]       = cache[p.asset]       || risk.killPrices(pool, p.asset, marks, opts);
    frozenCache[p.asset] = frozenCache[p.asset] || risk.killPrices(frozenPool, p.asset, marks, opts);
    // The closed form has no scan range, so it still validates when the threshold sits
    // beyond what killPrices will walk to.
    detailCache[p.asset] = detailCache[p.asset] || risk.liquidationDetail(pool, p.asset, marks, opts);
    const k   = cache[p.asset];
    const rep = reportedLiq(p);
    const candidates = [k.up, k.down].filter(v => v != null);
    const model = (rep && candidates.length)
      ? candidates.reduce((best, v) => Math.abs(v - rep) < Math.abs(best - rep) ? v : best)
      : (p.sizeRaw > 0 ? k.down : k.up);
    const side   = model == null ? null : (model === k.up ? 'up' : 'down');
    const f      = frozenCache[p.asset];
    const frozen = side === 'up' ? f.up : side === 'down' ? f.down : null;
    const err    = (a, b) => (a != null && b) ? +(Math.abs(a - b) / b * 100).toFixed(3) : null;

    const detail = detailCache[p.asset];
    return {
      key:              `${p.symbol}:${p.positionSide}`,
      modelKill:        model == null ? null : +model.toFixed(6),
      modelSide:        side,
      analyticKill:     detail.price == null ? null : +detail.price.toFixed(6),
      analyticErrPct:   (detail.price != null && rep) ? +(Math.abs(detail.price - rep) / rep * 100).toFixed(3) : null,
      illConditioned:   detail.illConditioned,
      movePerOnePctEquity: detail.movePerOnePctEquity ?? null,
      frozenKill:       frozen == null ? null : +frozen.toFixed(6),
      crossesTier:      model != null && risk.crossesTier(pool, p.asset, marks, model),
      reportedLiqPrice: rep,
      exchangeSaysUnreachable: p.reportedLiqPrice > 0 && rep == null,
      modelSaysUnreachable: !candidates.length,
      errPct:       err(model, rep),
      frozenErrPct: err(frozen, rep)
    };
  });
}

// One cross pool per collateral asset. With multi-assets margin off — the default —
// a USDC-margined contract is backed by the USDC wallet alone, so a USDT balance of any
// size is no protection at all. Multi-assets mode collapses them into one pool.
function buildPools(bn, brackets) {
  const cross  = bn.openPositions.filter(p => !p.isolated);
  const orders = bn.openOrders.filter(o => o.exchange === 'binance' && o.reduceOnly);

  const groups = bn.multiAssetsMode
    ? [{ marginAsset: 'MULTI', positions: cross, orders,
         reported: { wallet: bn.crossWalletBalance, marginBalance: bn.marginBalance,
                     maintMargin: bn.maintMargin, availableBalance: bn.availBal } }]
    : [...new Set(cross.map(p => p.quote))].map(quote => ({
        marginAsset: quote,
        positions:   cross.filter(p => p.quote === quote),
        orders:      orders.filter(o => o.quote === quote),
        reported:    bn.marginAssets[quote] || null
      }));

  return groups.map(g => ({
    ...g,
    pool: {
      collateral:   g.reported?.wallet ?? 0,
      freeReserved: g.reported?.openOrderInitialMargin ?? 0,
      positions:    g.positions.map(p => toEnginePosition(p, brackets?.[p.symbol])),
      orders:       g.orders.map(toEngineOrder)
    }
  }));
}

export function marksOf(positions) {
  const marks = {};
  positions.forEach(p => { marks[p.asset] = p.mark; });
  return marks;
}

// Anchor the price-invariant hold to the exchange's own availableBalance. Position initial
// margin — the part that moves with price — is modelled exactly and checked separately, so
// this anchor cannot hide an error in the simulation itself.
function anchorFreeReserved(group) {
  const { pool, reported } = group;
  const marks = marksOf(group.positions);
  const atMarks = risk.evalPool({ ...pool, freeReserved: 0 }, marks);
  if (Number.isFinite(reported?.availableBalance)) {
    pool.freeReserved = atMarks.equity - atMarks.im - reported.availableBalance;
  }
  return group;
}

export async function resolvePools(opts) {
  const [bn, brackets] = await Promise.all([getBinanceData(opts), getBinanceLeverageBrackets()]);
  return { bn, pools: buildPools(bn, brackets).map(anchorFreeReserved) };
}

export async function describePool(group) {
  const { pool, positions, marginAsset, reported } = group;
  const marks = marksOf(positions);

  const calibration = calibrate(pool, marks, positions, reported);
  const opts   = { perSideTiers: calibration.tierMode === 'perSide' };
  const stats  = await poolStats(positions);
  const state  = risk.evalPool(pool, marks, opts);
  const deltas = risk.netDeltas(pool, marks);

  const frozenPool = risk.freezeTiers(pool, marks);
  const baseline = Object.keys(marks).map(asset => {
    const both = risk.killPricesBoth(pool, asset, marks, opts);
    const k = both.buffer, f = both.free;
    const d = risk.drainPer1Pct(pool, asset, marks, opts);
    const crossUp   = k.up   != null && risk.crossesTier(pool, asset, marks, k.up);
    const crossDown = k.down != null && risk.crossesTier(pool, asset, marks, k.down);
    const frozen = (crossUp || crossDown) ? risk.killPrices(frozenPool, asset, marks, opts) : null;
    const sigma   = stats[asset]?.dailySigmaPct || null;
    const inSigma = pct => (pct == null || !sigma) ? null : +(Math.abs(pct) / sigma).toFixed(2);
    return {
      asset,
      mark:        marks[asset],
      netDelta:    +(deltas[asset] || 0).toFixed(2),
      killUp:      k.up   == null ? null : +k.up.toFixed(6),
      killDown:    k.down == null ? null : +k.down.toFixed(6),
      killUpPct:   k.upPct   == null ? null : +k.upPct.toFixed(2),
      killDownPct: k.downPct == null ? null : +k.downPct.toFixed(2),
      sigmaUp:     inSigma(k.upPct),
      sigmaDown:   inSigma(k.downPct),
      safeUpBuffer:   k.up   == null ? +k.minBufferUp.toFixed(2)   : null,
      safeDownBuffer: k.down == null ? +k.minBufferDown.toFixed(2) : null,
      drainUp:     +d.up.toFixed(2),
      drainDown:   +d.down.toFixed(2),
      freeZeroUp:     f.up   == null ? null : +f.up.toFixed(6),
      freeZeroDown:   f.down == null ? null : +f.down.toFixed(6),
      freeZeroUpPct:  f.upPct   == null ? null : +f.upPct.toFixed(2),
      freeZeroDownPct:f.downPct == null ? null : +f.downPct.toFixed(2),
      freeDrainUp:    +d.freeUp.toFixed(2),
      freeDrainDown:  +d.freeDown.toFixed(2),
      crossesTierUp:   crossUp,
      crossesTierDown: crossDown,
      killUpFrozen:    crossUp   && frozen?.up   != null ? +frozen.up.toFixed(6)   : null,
      killDownFrozen:  crossDown && frozen?.down != null ? +frozen.down.toFixed(6) : null,
      scannedUpPct:    +k.scannedUpPct.toFixed(1),
      scannedDownPct:  +k.scannedDownPct.toFixed(1)
    };
  }).sort((a, b) => {
    const near = x => Math.min(
      x.killUpPct   == null ? Infinity : Math.abs(x.killUpPct),
      x.killDownPct == null ? Infinity : Math.abs(x.killDownPct)
    );
    return near(a) - near(b);
  });

  const hedgedSymbols = [...new Set(
    positions
      .filter(p => positions.some(q => q.symbol === p.symbol && Math.sign(q.sizeRaw) !== Math.sign(p.sizeRaw)))
      .map(p => p.symbol)
  )];

  // Depth, lot filters and the real commission rate, so the unwind tools price a close the
  // way it would actually fill instead of assuming the mark.
  // One round-trip per asset, not one per position, and all of them in parallel — served
  // sequentially this added seconds to a panel that has to feel instant.
  await refreshSymbolFilters();
  const byAsset = [...new Map(positions.map(p => [p.asset, p])).values()];
  const fetched = await Promise.all(byAsset.map(async p => ({
    asset: p.asset,
    book: await getBook(p.symbol),
    fee: await commissionFor(p.symbol),
    filter: symbolFilters[p.symbol] || null
  })));
  const books = {}, filters = {}, fees = {};
  for (const f of fetched) { books[f.asset] = f.book; fees[f.asset] = f.fee; filters[f.asset] = f.filter; }

  return {
    marginAsset,
    pool,
    marks,
    opts,
    stats,
    baseline,
    hedgedSymbols,
    books,
    filters,
    fees,
    adl: positions.map(p => ({ key: `${p.symbol}:${p.positionSide}`, asset: p.asset,
                               side: p.side, quantile: p.adlQuantile ?? null })),
    reported,
    calibration,
    liqCheck: liqCrossCheck(pool, marks, positions, opts),
    state: {
      equity:      +state.equity.toFixed(2),
      mm:          +state.mm.toFixed(2),
      im:          +state.im.toFixed(2),
      free:        +state.freeUsable.toFixed(2),
      buffer:      +state.buffer.toFixed(2),
      usedPct:     +state.usedPct.toFixed(2),
      marginRatio: +state.marginRatio.toFixed(4),
      liquidated:  state.liquidated
    }
  };
}
