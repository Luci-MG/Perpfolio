// risk-engine.js — Binance USDM cross-pool stress engine (ESM)
//
// Pure functions. Shared verbatim between server.js and the browser (served at
// /risk-engine.js) so the Stress tab and the API can never disagree.
//
// A "pool" is one cross-margin collateral pool:
//   {
//     collateral: number,                  // crossWalletBalance — the pool base
//     freeReserved: number,                // price-invariant holds against free margin:
//                                          // open-order initial margin plus whatever else
//                                          // the exchange withholds. Anchored by the caller
//                                          // to the reported availableBalance, never guessed.
//     positions: [{
//       key, asset, symbol, positionSide,  // 'LONG' | 'SHORT' | 'BOTH'
//       q,                                 // SIGNED contract size (+long / −short)
//       entry, mark, leverage,
//       brackets: [{ notionalFloor, notionalCap, maintMarginRatio, cum }],
//       notionalCoef                       // per-user bracket multiplier (usually 1)
//     }],
//     orders: [{ asset, positionSide, side, q, trigger, reduceOnly, closePosition }]
//                                          // closePosition orders carry q = 0 on the
//                                          // exchange and close whatever is left
//   }
//
// Two thresholds matter, and a ray scan finds either one:
//   buffer = equity − maintenanceMargin   → 0 means liquidation
//   free   = equity − initialMargin − freeReserved → 0 means no capacity left to open
//            a position or transfer out (Binance's availableBalance, floored at 0)
// Maintenance margin is non-linear in price because notional crosses bracket tiers,
// so every threshold here is scanned rather than solved analytically.

// Ray sampling: fine near the mark where thresholds usually sit, coarse further out so
// the scan can still reach a threshold at −93% without paying for 0.25% steps all the
// way. Between discontinuities the buffer is concave and free margin linear, so a coarse
// grid cannot skip a crossing — and both discontinuities are sampled explicitly: trigger
// prices, and bracket floors. The tier comes from the symbol's combined notional while cum
// is subtracted per leg, so a hedge crossing a floor sees its maintenance margin DROP and
// the buffer jump upward; unsampled, a breach just below a floor was reported at the later
// crossing (+6.4% for a true +4.15%).
const RAY_FINE       = 0.0025;  // 0.25% steps out to RAY_FINE_LIMIT
const RAY_COARSE     = 0.01;    // 1% steps beyond it
const RAY_FINE_LIMIT = 0.30;
const RAY_MAX_UP     = 3.00;    // upside is unbounded; stop at +300%
const PRICE_FLOOR    = 0.999;   // a price cannot reach zero, so cap downside rays here
const BISECT_ITER    = 32;      // refines a breach to ~1e-9 of the ray

// ─── MAINTENANCE MARGIN ──────────────────────────────────────────────────────

// Bracket whose notional band contains `notional`. Highest bracket is the fallback
// for notionals past the last cap.
const sortedBrackets = new WeakMap();

export function pickTier(brackets, notional) {
  if (!Array.isArray(brackets) || !brackets.length) return null;
  let sorted = sortedBrackets.get(brackets);
  if (!sorted) {
    sorted = [...brackets].sort((a, b) => a.notionalFloor - b.notionalFloor);
    sortedBrackets.set(brackets, sorted);
  }
  for (const b of sorted) {
    if (notional >= b.notionalFloor && notional < b.notionalCap) return b;
  }
  return sorted[sorted.length - 1];
}

export function maintMargin(notional, tier) {
  if (!tier) return 0;
  return Math.max(0, notional * tier.maintMarginRatio - tier.cum);
}

// uPnL of a linear USDT-margined contract. Signed size handles both directions.
export function upnl(pos, price) {
  return pos.q * (price - pos.entry);
}

// Initial margin uses the leverage set on the position, not the maintenance tier.
export function initialMargin(pos, price) {
  const lev = pos.leverage > 0 ? pos.leverage : 1;
  return Math.abs(pos.q) * price / lev;
}

// ─── POOL EVALUATION ─────────────────────────────────────────────────────────

function priceFor(pos, prices) {
  const p = prices?.[pos.asset];
  return (p != null && isFinite(p) && p > 0) ? p : pos.mark;
}

function tierBasis(positions, prices, opts = {}) {
  const own = pos => Math.abs(pos.q) * priceFor(pos, prices) * (pos.notionalCoef > 0 ? pos.notionalCoef : 1);
  if (opts.perSideTiers) return own;
  const totals = {};
  for (const pos of positions) totals[pos.symbol] = (totals[pos.symbol] || 0) + own(pos);
  return pos => totals[pos.symbol];
}

export function evalPool(pool, prices = {}, opts = {}) {
  const positions = pool.positions || [];
  const basisOf = tierBasis(positions, prices, opts);

  let equity = pool.collateral || 0;
  let mm = 0;
  let im = 0;
  const detail = [];

  for (const pos of positions) {
    const price    = priceFor(pos, prices);
    const notional = Math.abs(pos.q) * price;
    const tier     = pickTier(pos.brackets, basisOf(pos));
    const posMm    = maintMargin(notional, tier);
    const posIm    = initialMargin(pos, price);
    const posPnl   = upnl(pos, price);

    equity += posPnl;
    mm     += posMm;
    im     += posIm;
    detail.push({
      key: pos.key, asset: pos.asset, symbol: pos.symbol, positionSide: pos.positionSide,
      q: pos.q, price, notional, upnl: posPnl, mm: posMm, im: posIm,
      mmr: tier?.maintMarginRatio ?? null, cum: tier?.cum ?? null
    });
  }

  const buffer = equity - mm;
  const free   = equity - im - (pool.freeReserved || 0);
  return {
    equity, mm, im, buffer, free,
    freeUsable:  Math.max(0, free),
    marginRatio: equity > 0 ? mm / equity : (mm > 0 ? Infinity : 0),
    usedPct:     equity > 0 ? Math.min(100, (mm / equity) * 100) : 100,
    liquidated:  buffer <= 0,
    positions:   detail
  };
}

// Net signed USD delta per asset. A hedged book shows ≈0 here while still carrying
// a finite kill price — which is the whole point of the panel.
export function netDeltas(pool, prices = {}) {
  const out = {};
  for (const pos of pool.positions || []) {
    out[pos.asset] = (out[pos.asset] || 0) + pos.q * priceFor(pos, prices);
  }
  return out;
}

// ─── REDUCE-ONLY STOPS ───────────────────────────────────────────────────────

function opposes(order, pos) {
  const reduces = (order.side === 'Sell' && pos.q > 0) || (order.side === 'Buy' && pos.q < 0);
  if (!reduces) return false;
  if (order.positionSide && pos.positionSide && order.positionSide !== 'BOTH' && pos.positionSide !== 'BOTH') {
    return order.positionSide === pos.positionSide;
  }
  return true;
}

// Walk each asset from `from` to `to` and close the reduce-only orders crossed on
// the way, realising their PnL into collateral. Returns a new pool; the original is
// untouched. Path-dependent by nature: with several assets moving at once each
// asset's crossings are applied independently, which is an approximation.
export function applyStops(pool, from, to) {
  const orders = (pool.orders || [])
    .filter(o => o.reduceOnly && o.trigger > 0 && (o.q > 0 || o.closePosition));
  if (!orders.length) return { pool, fired: [] };

  const positions = (pool.positions || []).map(p => ({ ...p }));
  let collateral = pool.collateral || 0;
  const fired = [];

  const assets = [...new Set(orders.map(o => o.asset))];
  for (const asset of assets) {
    const ref  = positions.find(p => p.asset === asset);
    const start = from?.[asset] ?? ref?.mark;
    const end   = to?.[asset]   ?? start;
    if (start == null || end == null || start === end) continue;

    const rising  = end > start;
    const crossed = orders
      .filter(o => o.asset === asset)
      .filter(o => rising ? (o.trigger > start && o.trigger <= end)
                          : (o.trigger < start && o.trigger >= end))
      .sort((a, b) => rising ? a.trigger - b.trigger : b.trigger - a.trigger);

    for (const o of crossed) {
      let remaining = o.closePosition ? Infinity : o.q;
      for (const pos of positions) {
        if (remaining <= 0) break;
        if (pos.asset !== asset || pos.q === 0 || !opposes(o, pos)) continue;
        const closed = Math.min(remaining, Math.abs(pos.q));
        const dir    = Math.sign(pos.q);
        collateral += dir * closed * (o.trigger - pos.entry);
        pos.q      -= dir * closed;
        remaining  -= closed;
        fired.push({ asset, trigger: o.trigger, closed, positionSide: pos.positionSide });
      }
    }
  }

  return {
    pool: { ...pool, collateral, positions: positions.filter(p => Math.abs(p.q) > 0) },
    fired
  };
}

// ─── CLOSING POSITIONS ───────────────────────────────────────────────────────

// Close part or all of one or more positions at `prices`.
//
// The realised PnL MUST move into collateral: unrealised becomes realised and the margin
// balance is unchanged. Dropping a position without crediting its PnL inflates equity by
// exactly that position's loss — for a book carrying a large unrealised loss it reports
// a five-fold overstatement of free margin.
//
// closes: [{ key, qty }] with qty in contracts, clamped to the position size.
export function closePositions(pool, prices = {}, closes = [], feeRate = 0) {
  const byKey = new Map((closes || []).map(c => [c.key, c]));
  let collateral = pool.collateral || 0;
  let realized = 0, notionalClosed = 0;
  const positions = [];

  for (const pos of pool.positions || []) {
    const req = byKey.get(pos.key);
    if (!req) { positions.push(pos); continue; }

    const price = priceFor(pos, prices);
    const qty   = Math.min(Math.abs(req.qty ?? Math.abs(pos.q)), Math.abs(pos.q));
    const dir   = Math.sign(pos.q);
    const pnl   = dir * qty * (price - pos.entry);

    realized       += pnl;
    notionalClosed += qty * price;
    collateral     += pnl;

    const left = pos.q - dir * qty;
    if (Math.abs(left) > 1e-12) positions.push({ ...pos, q: left });
  }

  const fees = notionalClosed * feeRate;
  return {
    pool: { ...pool, collateral: collateral - fees, positions },
    realized: +realized.toFixed(6),
    notionalClosed: +notionalClosed.toFixed(6),
    fees: +fees.toFixed(6)
  };
}

/** The pool after adding `qty` (unsigned) to position `key` at `price`, its entry averaged; an unknown key changes nothing. */
export function addToPosition(pool, key, qty, price) {
  return {
    ...pool,
    positions: (pool.positions || []).map(pos => {
      if (pos.key !== key || !(qty > 0) || !(price > 0)) return pos;
      const held = Math.abs(pos.q);
      return { ...pos, q: pos.q + Math.sign(pos.q) * qty, entry: (held * pos.entry + qty * price) / (held + qty) };
    })
  };
}

// Gross directional exposure: the sum of per-asset net deltas in absolute terms. Closing a
// naked leg lowers it; closing one leg of a hedge raises it.
export function grossNetDelta(pool, prices = {}) {
  return Object.values(netDeltas(pool, prices)).reduce((s, v) => s + Math.abs(v), 0);
}

// ─── RAY SCAN ────────────────────────────────────────────────────────────────

function pricesAt(base, dir, lambda) {
  const out = { ...base };
  for (const [asset, d] of Object.entries(dir)) {
    if (base[asset] == null) continue;
    out[asset] = base[asset] * (1 + lambda * d);
  }
  return out;
}

function evalAt(pool, base, dir, lambda, opts) {
  const prices = pricesAt(base, dir, lambda);
  const active = opts.honorStops ? applyStops(pool, base, prices).pool : pool;
  return { prices, state: evalPool(active, prices, opts) };
}

// 'buffer' (default) scans to liquidation; 'free' scans to the point where no margin
// is left to open a position or transfer out.
function metricOf(state, opts) {
  return opts.metric === 'free' ? state.free : state.buffer;
}

// Walk λ outward from 0 and return the first breach of every requested threshold in a
// single pass. Deliberately samples the whole ray instead of bisecting from the far end:
// the buffer can rise before it falls, and with stops honoured a firing take-profit can
// put the pool back in the black past a breach that already happened.
// λ values to evaluate along the ray: an even grid, plus the exact approach to every
// reduce-only trigger. A firing stop drops that leg's maintenance margin, so the buffer
// jumps upward there — without sampling just below each trigger, a breach can sit
// entirely between two grid points and the scan reports the later, more flattering one.
// Largest λ worth scanning: whatever the caller asked for, but never far enough to drive
// any asset's price to zero.
export function rayCap(dir, opts = {}) {
  const requested = opts.lambdaMax ?? RAY_MAX_UP;
  const steepestDown = Math.max(0, ...Object.values(dir).map(d => -d));
  return steepestDown > 0 ? Math.min(requested, PRICE_FLOOR / steepestDown) : requested;
}

function rayLambdas(pool, base, dir, opts) {
  const scale = Math.max(...Object.values(dir).map(Math.abs), 1e-9);
  const max   = rayCap(dir, opts);
  const fine  = (opts.step ?? RAY_FINE) / scale;
  const fineLimit = Math.min(max, RAY_FINE_LIMIT / scale);
  const coarse = Math.max(fine, RAY_COARSE / scale);

  const out = [];
  for (let lambda = fine; lambda <= fineLimit + 1e-12; lambda += fine) out.push(lambda);
  for (let lambda = fineLimit + coarse; lambda <= max + 1e-12; lambda += coarse) out.push(lambda);
  if (!out.length || out[out.length - 1] < max - 1e-12) out.push(max);
  out.push(...tierBreakpoints(pool, base, dir, max, opts));
  if (!opts.honorStops) return [...new Set(out)].sort((a, b) => a - b);

  for (const o of pool.orders || []) {
    if (!o.reduceOnly || !(o.trigger > 0) || !(o.q > 0 || o.closePosition)) continue;
    const from = base[o.asset], d = dir[o.asset];
    if (!(from > 0) || !d) continue;
    const lambda = (o.trigger / from - 1) / d;
    if (lambda > 0 && lambda <= max) out.push(Math.max(lambda - 1e-6, 0), lambda);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

// λ just below and at every point where a tier basis — the symbol's combined notional, or
// each leg's own in per-side mode — reaches a bracket floor. Notional is linear in λ.
function tierBreakpoints(pool, base, dir, max, opts) {
  const lines = new Map();
  const add = (key, pos, c0, c1) => {
    const line = lines.get(key) || { c0: 0, c1: 0, brackets: pos.brackets };
    line.c0 += c0;
    line.c1 += c1;
    lines.set(key, line);
  };
  for (const pos of pool.positions || []) {
    const from = base[pos.asset] ?? pos.mark, d = dir[pos.asset] || 0;
    if (!(from > 0) || !d || !pos.brackets?.length) continue;
    const coef = pos.notionalCoef > 0 ? pos.notionalCoef : 1;
    const n0 = Math.abs(pos.q) * from * coef;
    add(opts.perSideTiers ? pos.key : pos.symbol, pos, n0, n0 * d);
  }
  const out = [];
  for (const { c0, c1, brackets } of lines.values()) {
    if (!c1) continue;
    for (const b of brackets) {
      if (!(b.notionalFloor > 0)) continue;
      const lambda = (b.notionalFloor - c0) / c1;
      if (lambda > 0 && lambda <= max) out.push(Math.max(lambda * (1 - 1e-9) - 1e-12, 0), lambda);
    }
  }
  return out;
}

function walkRay(pool, base, dir, opts, metrics) {
  const start = evalAt(pool, base, dir, 0, opts).state;
  const acc = {};
  for (const m of metrics) {
    acc[m] = { safe: 0, breachLambda: null, minBuffer: metricOf(start, { metric: m }) };
  }

  for (const lambda of rayLambdas(pool, base, dir, opts)) {
    if (metrics.every(m => acc[m].breachLambda != null)) break;
    const { state } = evalAt(pool, base, dir, lambda, opts);

    for (const m of metrics) {
      const a = acc[m];
      if (a.breachLambda != null) continue;
      const v = metricOf(state, { metric: m });
      if (v < a.minBuffer) a.minBuffer = v;
      if (v <= 0) a.breachLambda = bisectBreach(pool, base, dir, a.safe, lambda, { ...opts, metric: m });
      else a.safe = lambda;
    }
  }

  const scanned = rayCap(dir, opts);
  for (const m of metrics) {
    acc[m].scannedTo = scanned;
    acc[m].breachPrices = acc[m].breachLambda == null ? null : pricesAt(base, dir, acc[m].breachLambda);
  }
  return acc;
}

function bisectBreach(pool, base, dir, safe, breach, opts) {
  let lo = safe, hi = breach;
  for (let i = 0; i < BISECT_ITER; i++) {
    const mid = (lo + hi) / 2;
    if (metricOf(evalAt(pool, base, dir, mid, opts).state, opts) <= 0) hi = mid;
    else lo = mid;
  }
  return hi;
}

function metricKey(opts) { return opts.metric === 'free' ? 'free' : 'buffer'; }

export function scanRay(pool, base, dir, opts = {}) {
  const m = metricKey(opts);
  return walkRay(pool, base, dir, opts, [m])[m];
}

// ─── KILL PRICES ─────────────────────────────────────────────────────────────

// Price of `asset` at which the pool is exhausted, in both directions, holding every
// other asset at its price in `base`. null = unreachable within the scan range.
export function killPrices(pool, asset, base, opts = {}) {
  const start = base?.[asset];
  if (!(start > 0)) return { asset, up: null, down: null, minBufferUp: null, minBufferDown: null };

  const m       = metricKey(opts);
  const upRay   = walkRay(pool, base, { [asset]: +1 }, opts, [m])[m];
  const downRay = walkRay(pool, base, { [asset]: -1 }, opts, [m])[m];

  const price = r => r.breachLambda == null ? null : r.breachPrices[asset];
  const pct   = p => p == null ? null : (p - start) / start * 100;

  const upPrice = price(upRay), downPrice = price(downRay);
  return {
    asset,
    up:            upPrice,
    down:          downPrice,
    upPct:         pct(upPrice),
    downPct:       pct(downPrice),
    minBufferUp:   upRay.minBuffer,
    minBufferDown: downRay.minBuffer,
    scannedUpPct:   upRay.scannedTo * 100,
    scannedDownPct: downRay.scannedTo * 100
  };
}

// Both thresholds for one asset, walking each direction once instead of twice.
export function killPricesBoth(pool, asset, base, opts = {}) {
  const start = base?.[asset];
  const empty = { asset, up: null, down: null, upPct: null, downPct: null, minBufferUp: null, minBufferDown: null };
  if (!(start > 0)) return { buffer: { ...empty }, free: { ...empty } };

  const metrics = ['buffer', 'free'];
  const upRay   = walkRay(pool, base, { [asset]: +1 }, opts, metrics);
  const downRay = walkRay(pool, base, { [asset]: -1 }, opts, metrics);

  const out = {};
  for (const metric of metrics) {
    const u = upRay[metric], d = downRay[metric];
    const up   = u.breachLambda == null ? null : u.breachPrices[asset];
    const down = d.breachLambda == null ? null : d.breachPrices[asset];
    out[metric] = {
      asset, up, down,
      upPct:   up   == null ? null : (up - start) / start * 100,
      downPct: down == null ? null : (down - start) / start * 100,
      minBufferUp:   u.minBuffer,
      minBufferDown: d.minBuffer,
      scannedUpPct:   u.scannedTo * 100,
      scannedDownPct: d.scannedTo * 100
    };
  }
  return out;
}

// The exchange publishes a liquidation price that freezes each position's margin tier at
// its current notional; its live margin engine re-tiers as the notional moves. This
// returns a pool with the tiers pinned, so both readings can be shown when a threshold
// crosses a bracket boundary.
export function freezeTiers(pool, prices = {}, opts = {}) {
  const basisOf = tierBasis(pool.positions || [], prices, opts);
  return {
    ...pool,
    positions: (pool.positions || []).map(pos => {
      const tier = pickTier(pos.brackets, basisOf(pos));
      if (!tier) return pos;
      return { ...pos, brackets: [{ notionalFloor: 0, notionalCap: 1e15,
                                    maintMarginRatio: tier.maintMarginRatio, cum: tier.cum }] };
    })
  };
}

// Does any leg of `asset` change bracket between two prices?
export function crossesTier(pool, asset, fromPrices, toPrice, opts = {}) {
  const positions = pool.positions || [];
  const legs = positions.filter(p => p.asset === asset);
  if (!legs.length || !(toPrice > 0)) return false;
  const before = tierBasis(positions, fromPrices, opts);
  const after = tierBasis(positions, { ...fromPrices, [asset]: toPrice }, opts);
  return legs.some(p => pickTier(p.brackets, before(p)) !== pickTier(p.brackets, after(p)));
}

// Buffer and free margin lost (negative) or gained (positive) by a ±1% move.
export function drainPer1Pct(pool, asset, base, opts = {}) {
  const at0  = evalPool(pool, base, opts);
  const up   = evalPool(pool, { ...base, [asset]: base[asset] * 1.01 }, opts);
  const down = evalPool(pool, { ...base, [asset]: base[asset] * 0.99 }, opts);
  return {
    up:     up.buffer - at0.buffer,
    down:   down.buffer - at0.buffer,
    freeUp: up.free - at0.free,
    freeDown: down.free - at0.free
  };
}

// ─── SCENARIOS ───────────────────────────────────────────────────────────────

// Direction vector for a named scenario. `sign` flips market-wide scenarios;
// 'adverse' ignores it and points every asset the way that hurts the pool.
export function scenarioDir(pool, mode, { betas = {}, sign = -1, prices = {} } = {}) {
  const assets = [...new Set((pool.positions || []).map(p => p.asset))];
  const dir = {};

  if (mode === 'adverse') {
    const deltas = netDeltas(pool, prices);
    for (const a of assets) dir[a] = deltas[a] > 0 ? -1 : 1;
    return dir;
  }

  for (const a of assets) {
    const beta = mode === 'btcBeta' ? (betas[a] ?? 1) : 1;
    dir[a] = sign * beta;
  }
  return dir;
}

// ─── CASCADE ─────────────────────────────────────────────────────────────────

// Once the pool breaches, positions are force-closed until the buffer is positive
// again. Binance's liquidation order is not public; largest maintenance margin first
// is a heuristic, so the result is approximate by construction.
export function cascade(pool, prices = {}, opts = {}) {
  let work = { ...pool, positions: [...(pool.positions || [])] };
  let state = evalPool(work, prices, opts);
  const closed = [];

  while (state.buffer <= 0 && work.positions.length) {
    const worst = [...state.positions].sort((a, b) => b.mm - a.mm)[0];
    const pos   = work.positions.find(p => p.key === worst.key);
    if (!pos) break;

    work = {
      ...work,
      collateral: work.collateral + upnl(pos, priceFor(pos, prices)),
      positions:  work.positions.filter(p => p.key !== pos.key)
    };
    closed.push({ key: pos.key, asset: pos.asset, positionSide: pos.positionSide,
                  realised: upnl(pos, priceFor(pos, prices)) });
    state = evalPool(work, prices, opts);
  }

  return {
    closed,
    survivors:    work.positions.map(p => p.key),
    finalEquity:  state.equity,
    finalBuffer:  state.buffer,
    wipedOut:     state.buffer <= 0
  };
}

// ─── EXECUTION COST ──────────────────────────────────────────────────────────

// Average fill price for `qty` consumed against one side of the book. Levels arrive as
// [price, size] strings, best first. Reports the unfilled remainder rather than inventing a
// price for depth that is not there.
export function walkBook(levels, qty) {
  const want = Math.abs(qty) || 0;
  if (!Array.isArray(levels) || !levels.length || want <= 0) {
    return { vwap: null, filled: 0, remaining: want, levelsUsed: 0, exhausted: !want ? false : true };
  }

  let remaining = want, cost = 0, used = 0;
  for (const level of levels) {
    const price = parseFloat(level[0]), size = parseFloat(level[1]);
    if (!(price > 0) || !(size > 0)) continue;
    const take = Math.min(remaining, size);
    cost += take * price;
    remaining -= take;
    used++;
    if (remaining <= 1e-12) break;
  }

  const filled = want - remaining;
  return {
    vwap: filled > 0 ? cost / filled : null,
    filled, remaining: Math.max(0, remaining), levelsUsed: used,
    exhausted: remaining > 1e-12
  };
}

/**
 * Cost of closing a position at the current book: slippage against the mark plus commission.
 * `side` is the closing order's, 'sell' for a long and 'buy' for a short; slippage is signed,
 * so a fill better than the mark is a negative cost.
 */
export function exitCost(levels, qty, mark, feeRate = 0, side = 'sell') {
  const walk = walkBook(levels, qty);
  if (walk.vwap == null || !(mark > 0)) return { ...walk, slipPct: null, slipUsd: null, feeUsd: null, totalUsd: null };
  const slipUsd = (side === 'sell' ? mark - walk.vwap : walk.vwap - mark) * walk.filled;
  const feeUsd  = walk.vwap * walk.filled * feeRate;
  return {
    ...walk,
    slipPct: (walk.vwap - mark) / mark * 100,
    slipUsd: +slipUsd.toFixed(4),
    feeUsd: +feeUsd.toFixed(4),
    totalUsd: +(slipUsd + feeUsd).toFixed(4)
  };
}

// ─── HEDGE LEDGER ────────────────────────────────────────────────────────────
//
// A matched same-symbol hedge pins its PnL at (entryShort − entryLong) × matchedQty. The
// price terms cancel exactly:
//
//   q(P − E_long) + (−q)(P − E_short) = q(E_short − E_long)
//
// so that portion of the loss is already determined and no price path can change it. Only
// the unmatched remainder is still exposed to the market. Both figures are reported because
// a book can look enormous in notional while almost none of it is live risk.
export function lockedPnl(pool, prices = {}) {
  const bySymbol = {};
  for (const p of pool.positions || []) (bySymbol[p.symbol] = bySymbol[p.symbol] || []).push(p);

  const rows = [];
  for (const [symbol, legs] of Object.entries(bySymbol)) {
    const long = legs.find(p => p.q > 0);
    const short = legs.find(p => p.q < 0);
    if (!long || !short) continue;

    const matched = Math.min(Math.abs(long.q), Math.abs(short.q));
    const price = priceFor(long, prices);
    const locked = matched * (short.entry - long.entry);
    const residualQty = Math.abs(long.q) - Math.abs(short.q);
    const livePair = matched * (price - long.entry) + (-matched) * (price - short.entry);

    rows.push({
      symbol, asset: long.asset, matched: +matched.toFixed(8),
      longEntry: long.entry, shortEntry: short.entry, mark: price,
      locked: +locked.toFixed(2),
      livePairPnl: +livePair.toFixed(2),
      invariant: Math.abs(locked - livePair) < 0.01,
      residualSide: residualQty === 0 ? 'flat' : residualQty > 0 ? 'long' : 'short',
      residualQty: +Math.abs(residualQty).toFixed(8),
      residualNotional: +(Math.abs(residualQty) * price).toFixed(2),
      matchedNotional: +(2 * matched * price).toFixed(2)
    });
  }

  rows.sort((a, b) => a.locked - b.locked);
  return {
    rows,
    totalLocked: +rows.reduce((s, r) => s + r.locked, 0).toFixed(2),
    totalMatchedNotional: +rows.reduce((s, r) => s + r.matchedNotional, 0).toFixed(2),
    totalResidualNotional: +rows.reduce((s, r) => s + r.residualNotional, 0).toFixed(2)
  };
}

// ─── MARGIN INFLATION ────────────────────────────────────────────────────────
//
// A hedge is delta-neutral, not margin-neutral. Margin is charged on notional and notional
// is quantity × price, so both legs' requirements scale with price while the pair's PnL is
// pinned. A matched pair whose PnL cannot move by a cent still consumes three times the
// margin at three times the price — and bracket tiers can make it worse than linear.
//
// This is why free margin runs out in a pump that costs the book almost nothing in PnL.
export function marginUnderMove(pool, prices = {}, moves = [0, 25, 50, 100, 200], opts = {}) {
  const at = pct => {
    const shifted = {};
    for (const [asset, price] of Object.entries(prices)) shifted[asset] = price * (1 + pct / 100);
    return shifted;
  };

  const base = evalPool(pool, prices, opts);
  const steps = moves.map(pct => {
    const shifted = at(pct);
    const state = evalPool(pool, shifted, opts);
    return {
      movePct: pct,
      equity: +state.equity.toFixed(2),
      im: +state.im.toFixed(2),
      mm: +state.mm.toFixed(2),
      free: +state.freeUsable.toFixed(2),
      buffer: +state.buffer.toFixed(2),
      notional: +state.positions.reduce((s, p) => s + p.notional, 0).toFixed(2),
      imGrowth: base.im > 0 ? +(state.im / base.im).toFixed(3) : null,
      equityChange: +(state.equity - base.equity).toFixed(2),
      legs: state.positions.map(p => ({
        key: p.key, asset: p.asset, positionSide: p.positionSide,
        notional: +p.notional.toFixed(2), im: +p.im.toFixed(2), mm: +p.mm.toFixed(2),
        upnl: +p.upnl.toFixed(2)
      }))
    };
  });

  // Where a uniform move exhausts free margin, and where it liquidates. The first is the
  // constraint that actually bites in a pump.
  const dir = Object.fromEntries(Object.keys(prices).map(a => [a, 1]));
  const freeGone = scanRay(pool, prices, dir, { ...opts, metric: 'free' });
  const liq = scanRay(pool, prices, dir, opts);

  return {
    steps,
    base: { im: +base.im.toFixed(2), mm: +base.mm.toFixed(2),
            free: +base.freeUsable.toFixed(2), equity: +base.equity.toFixed(2) },
    freeGoneAtPct: freeGone.breachLambda == null ? null : +(freeGone.breachLambda * 100).toFixed(2),
    liquidatedAtPct: liq.breachLambda == null ? null : +(liq.breachLambda * 100).toFixed(2),
    scannedToPct: +(freeGone.scannedTo * 100).toFixed(0)
  };
}

// ─── LIQUIDATION PRICE, BINANCE'S OWN CONVENTION ─────────────────────────────
//
// Closed-form solve of the liquidation condition, deliberately mirroring what the exchange
// publishes rather than what its live engine will do:
//
//   equity(P) = maintenanceMargin(P)
//   WB + Σ_all q_i·(P_i − E_i) = Σ_all max(0, |q_i|·P_i·mmr_i − cum_i)
//
// Legs on the asset being solved for carry P; every other position is frozen at its mark.
// With the margin tier pinned at the current notional this is linear in P:
//
//   A = Σ_legs (q_l − |q_l|·mmr_l)
//   C = WB + Σ_others (upnl_j − mm_j) − Σ_legs q_l·E_l + Σ_legs cum_l
//   P* = −C / A            (A = 0 → no solution)
//
// Two things make this the number to show next to Binance's:
//   • the tier is frozen, which is what the exchange's published figure does; and
//   • it is linear, so it does not clamp a leg's maintenance margin at zero the way a
//     scan of the true non-linear surface does. Binance's formula does not clamp either.
// `killPrices` over `freezeTiers` solves the same thing by scanning, so the two are
// independent implementations of one definition and are cross-checked in the tests.
export function liquidationPriceAnalytic(pool, asset, prices = {}, opts = {}) {
  return liquidationDetail(pool, asset, prices, opts).price;
}

// The solve plus how trustworthy it is.
//
// P* = −C / A, so dP*/dC = −1/A: every dollar of equity moves the liquidation price by
// 1/|A| dollars. As a book approaches delta-neutral, A = Σ(q − |q|·mmr) collapses toward the
// maintenance term alone and that ratio explodes — a near-flat hedge can have a liquidation
// price hundreds of percent away that shifts tens of thousands on a few hundred dollars of
// equity. The number is still correct; it just is not meaningful to the dollar, and saying
// so is the difference between a useful figure and false precision.
export function liquidationDetail(pool, asset, prices = {}, opts = {}) {
  const positions = pool.positions || [];
  const none = { price: null, coefficient: 0, sensitivityPerDollar: null, illConditioned: false };
  if (!positions.some(p => p.asset === asset)) return none;

  const basisOf = tierBasis(positions, prices, opts);
  const tierOf = p => pickTier(p.brackets, basisOf(p));

  let A = 0;
  let C = pool.collateral || 0;

  for (const p of positions) {
    const tier = tierOf(p);
    const mmr  = tier?.maintMarginRatio ?? 0;
    const cum  = tier?.cum ?? 0;

    if (p.asset === asset) {
      A += p.q - Math.abs(p.q) * mmr;
      C += -p.q * p.entry + cum;
    } else {
      const price = priceFor(p, prices);
      C += p.q * (price - p.entry) - Math.max(0, Math.abs(p.q) * price * mmr - cum);
    }
  }

  if (Math.abs(A) < 1e-12) return none;
  const price = -C / A;
  if (!(price > 0)) return { ...none, coefficient: A };

  const equity = evalPool(pool, prices, opts).equity;
  const mark = prices[asset] ?? positions.find(p => p.asset === asset).mark;
  const sensitivity = Math.abs(1 / A);

  // Two ways the figure stops being meaningful to the dollar: a 1% wobble in equity moving
  // it more than 5%, or it sitting so far from the mark that it is an extrapolation rather
  // than a forecast. A near-neutral book routinely produces both.
  const jumpy = equity > 0 && (sensitivity * equity * 0.01) > price * 0.05;
  const farAway = mark > 0 && (price > mark * 3 || price < mark / 3);

  return {
    price,
    coefficient: A,
    sensitivityPerDollar: +sensitivity.toFixed(4),
    movePerOnePctEquity: +(sensitivity * equity * 0.01).toFixed(2),
    multipleOfMark: mark > 0 ? +(price / mark).toFixed(2) : null,
    jumpy,
    farAway,
    illConditioned: jumpy || farAway
  };
}

// ─── UNWIND ──────────────────────────────────────────────────────────────────
//
// What a close does to equity, margin and exposure, and why the planner ranks and guards the
// way it does: docs/unwind.md.

/**
 * What closing `closes` costs at the live book: signed slippage against the mark plus each
 * symbol's taker fee. `opts.books` and `opts.fees` are keyed by asset, with `opts.feeRate`
 * for a symbol without its own rate; a symbol without a book pays its fee at the mark, and
 * one whose book runs out is listed in `thin` with what it could not fill.
 */
export function closeCost(pool, prices = {}, closes = [], opts = {}) {
  let fee = 0, slip = 0, notional = 0;
  const thin = [];
  for (const c of closes || []) {
    const pos = (pool.positions || []).find(p => p.key === c.key);
    if (!pos) continue;
    const qty = Math.min(Math.abs(c.qty ?? pos.q), Math.abs(pos.q));
    if (!(qty > 0)) continue;
    const mark = priceFor(pos, prices);
    const rate = opts.fees?.[pos.asset] ?? opts.feeRate ?? 0;
    const book = opts.books?.[pos.asset];
    const walk = book ? exitCost(pos.q > 0 ? book.bids : book.asks, qty, mark, rate, pos.q > 0 ? 'sell' : 'buy') : null;
    const filled = walk?.vwap != null ? walk.filled : 0;
    if (filled) { slip += walk.slipUsd; fee += walk.feeUsd; notional += filled * walk.vwap; }
    const unfilled = qty - filled;
    fee += unfilled * mark * rate;
    notional += unfilled * mark;
    if (book && unfilled > 1e-12) thin.push({ asset: pos.asset, unfilled });
  }
  return { fee, slip, total: fee + slip, notional, thin };
}

/** `closePositions` with the exit priced by `closeCost`: collateral pays the fees and the slippage. */
export function applyCloses(pool, prices = {}, closes = [], opts = {}, cost = closeCost(pool, prices, closes, opts)) {
  const r = closePositions(pool, prices, closes, 0);
  return { ...r, pool: { ...r.pool, collateral: r.pool.collateral - cost.total }, fees: cost.fee, slip: cost.slip, cost };
}

/** Net exposure in BTC terms: each asset's net delta times its beta to BTC, 1 where unknown. */
export function betaNet(pool, prices = {}, betas = {}) {
  return Object.entries(netDeltas(pool, prices)).reduce((s, [a, d]) => s + d * (betas[a] ?? 1), 0);
}

/** Distance from the mark, in %, to the nearest liquidation price Binance would publish; Infinity when none exists. */
export function nearestLiqPct(pool, prices = {}, opts = {}) {
  let nearest = Infinity;
  for (const asset of new Set((pool.positions || []).map(p => p.asset))) {
    const price = liquidationPriceAnalytic(pool, asset, prices, opts);
    const mark = prices[asset] ?? pool.positions.find(p => p.asset === asset).mark;
    if (price != null && mark > 0) nearest = Math.min(nearest, Math.abs(price - mark) / mark * 100);
  }
  return nearest;
}

function liquidationRows(pool, after, prices, opts) {
  const live = new Set((after.positions || []).map(p => p.asset));
  return [...new Set((pool.positions || []).map(p => p.asset))].map(asset => {
    const before = liquidationPriceAnalytic(pool, asset, prices, opts);
    const closed = !live.has(asset);
    const afterPx = closed ? null : liquidationPriceAnalytic(after, asset, prices, opts);
    const mark = prices[asset];
    const pct = p => (p == null || !(mark > 0)) ? null : (p - mark) / mark * 100;
    return {
      asset, mark, closed,
      liqBefore: before, liqAfter: afterPx,
      pctBefore: pct(before), pctAfter: pct(afterPx),
      roomGained: (before == null || afterPx == null || !(mark > 0)) ? null
        : Math.abs(pct(afterPx)) - Math.abs(pct(before))
    };
  });
}

/**
 * Everything one set of closes does, priced at the live book: margin before and after,
 * exposure per coin and in BTC-beta terms, and each asset's liquidation price the way
 * Binance publishes it (tier frozen, linear solve). Takes the same opts as `closeCost`,
 * plus `betas` keyed by asset.
 */
export function unwindOutcome(pool, prices = {}, closes = [], opts = {}) {
  const applied = applyCloses(pool, prices, closes, opts);
  const betas = opts.betas || {};
  return {
    before: evalPool(pool, prices, opts),
    after: evalPool(applied.pool, prices, opts),
    realized: applied.realized,
    cost: applied.cost,
    notionalClosed: applied.notionalClosed,
    netBefore: netDeltas(pool, prices),
    netAfter: netDeltas(applied.pool, prices),
    grossBefore: grossNetDelta(pool, prices),
    grossAfter: grossNetDelta(applied.pool, prices),
    betaBefore: betaNet(pool, prices, betas),
    betaAfter: betaNet(applied.pool, prices, betas),
    rows: liquidationRows(pool, applied.pool, prices, opts),
    pool: applied.pool
  };
}

export function deleverageCeiling(pool, prices = {}, opts = {}) {
  const state = evalPool(pool, prices, opts);
  const all = (pool.positions || []).map(p => ({ key: p.key, qty: Math.abs(p.q) }));
  const cost = closeCost(pool, prices, all, opts).total;
  return {
    equity:        +state.equity.toFixed(2),
    reserved:      +(pool.freeReserved || 0).toFixed(2),
    currentFree:   +state.freeUsable.toFixed(2),
    maxFree:       +Math.max(0, state.equity - cost - (pool.freeReserved || 0)).toFixed(2),
    releasableIm:  +state.im.toFixed(2),
    closeAllCost:  +cost.toFixed(2)
  };
}

const mergeCloses = (a, b) => {
  const out = new Map(a.map(c => [c.key, c.qty]));
  for (const c of b) out.set(c.key, (out.get(c.key) || 0) + c.qty);
  return [...out].map(([key, qty]) => ({ key, qty }));
};

const scaleCloses = (closes, f) => closes.map(c => ({ key: c.key, qty: c.qty * f }));

const unfilledOf = cost => cost.thin.reduce((s, t) => s + t.unfilled, 0);

function unwindMetric(pool, prices, opts, objective) {
  if (objective === 'liq') return nearestLiqPct(pool, prices, opts);
  const s = evalPool(pool, prices, opts);
  return objective === 'buffer' ? s.buffer : s.freeUsable;
}

function candidateEffect(ctx, work, label, type, closes) {
  const { origin, prices, opts, objective, taken, takenCost } = ctx;
  const merged = closeCost(origin, prices, mergeCloses(taken, closes), opts);
  const cost = { fee: merged.fee - takenCost.fee, slip: merged.slip - takenCost.slip,
                 total: merged.total - takenCost.total, thin: merged.thin };
  const r = applyCloses(work, prices, closes, opts, cost);
  const before = evalPool(work, prices, opts);
  const after = evalPool(r.pool, prices, opts);
  const betas = opts.betas || {};
  const liqGain = objective === 'liq'
    ? unwindMetric(r.pool, prices, opts, 'liq') - unwindMetric(work, prices, opts, 'liq')
    : null;

  return {
    label, type, closes,
    freeGain:       +(after.free - before.free).toFixed(2),
    bufferGain:     +(after.buffer - before.buffer).toFixed(2),
    liqGain:        liqGain == null || !isFinite(liqGain) ? liqGain : +liqGain.toFixed(2),
    imReleased:     +(before.im - after.im).toFixed(2),
    mmReleased:     +(before.mm - after.mm).toFixed(2),
    realized:       r.realized,
    fees:           +cost.fee.toFixed(2),
    slip:           +cost.slip.toFixed(2),
    cost:           +cost.total.toFixed(2),
    thin:           unfilledOf(merged) > unfilledOf(takenCost) + 1e-12,
    notionalClosed: r.notionalClosed,
    deltaShift:     +(grossNetDelta(r.pool, prices) - grossNetDelta(work, prices)).toFixed(2),
    betaShift:      +(Math.abs(betaNet(r.pool, prices, betas)) - Math.abs(betaNet(work, prices, betas))).toFixed(2),
    resultPool:     r.pool
  };
}

function candidatesFor(ctx, work) {
  const out = [];
  const bySymbol = {};
  for (const p of work.positions || []) (bySymbol[p.symbol] = bySymbol[p.symbol] || []).push(p);

  for (const [symbol, legs] of Object.entries(bySymbol)) {
    const long  = legs.find(p => p.q > 0);
    const short = legs.find(p => p.q < 0);
    if (!long || !short) continue;
    const qty = Math.min(Math.abs(long.q), Math.abs(short.q));
    if (qty <= 0) continue;
    out.push(candidateEffect(ctx, work, `close matched ${symbol} hedge`, 'matched-hedge',
      [{ key: long.key, qty }, { key: short.key, qty }]));
  }

  for (const p of work.positions || []) {
    out.push(candidateEffect(ctx, work, `close ${p.asset} ${p.positionSide}`, 'leg', [{ key: p.key, qty: Math.abs(p.q) }]));
  }
  return out;
}

const efficiency = (c, gain) => c.cost > 1e-9 ? gain / c.cost : Infinity;

/**
 * Closes that move `objective` ('free' or 'buffer' in dollars, 'liq' as the nearest liquidation's
 * distance in %) to `target`, cheapest per dollar of exit cost first. Unless `allowBreakingHedges`,
 * no close may raise per-coin or BTC-beta exposure by more than 0.5% of gross notional; `blocked`
 * says what stopped a plan short of its target.
 */
export function deleveragePlan(pool, prices = {}, opts = {}) {
  const objective = ['buffer', 'liq'].includes(opts.objective) ? opts.objective : 'free';
  const gainOf    = c => objective === 'liq' ? c.liqGain : objective === 'buffer' ? c.bufferGain : c.freeGain;
  const target    = opts.target ?? Infinity;
  const maxLoss   = opts.maxRealizedLoss ?? Infinity;
  const maxSteps  = opts.maxSteps ?? 12;
  const minGain   = opts.minGain ?? 0.01;
  const allowBreakingHedges = opts.allowBreakingHedges === true;

  const start   = evalPool(pool, prices, opts);
  const gross   = start.positions.reduce((s, p) => s + p.notional, 0);
  const deltaTol = opts.deltaTolerance ?? (allowBreakingHedges ? Infinity : Math.max(1, gross * 0.005));
  const ceiling = deleverageCeiling(pool, prices, opts);
  const betas   = opts.betas || {};
  const metric  = pl => unwindMetric(pl, prices, opts, objective);

  const ctx = { origin: pool, prices, opts, objective, taken: [], takenCost: closeCost(pool, prices, [], opts) };
  let work = pool;
  let realizedTotal = 0, costTotal = 0;
  const steps = [];
  let blocked = null;

  for (let i = 0; i < maxSteps && metric(work) < target; i++) {
    const all = candidatesFor(ctx, work).filter(c => gainOf(c) >= minGain);
    const lossAfter = c => -(realizedTotal - costTotal + c.realized - c.cost);
    const isSafe = c => c.deltaShift <= deltaTol && c.betaShift <= deltaTol;
    const affordable = all.filter(c => lossAfter(c) <= maxLoss);
    const safe       = all.filter(isSafe);
    const candidates = affordable.filter(isSafe);

    if (!candidates.length) {
      if (all.length) {
        const cheapestSafe = safe.length ? Math.min(...safe.map(lossAfter)) : null;
        blocked = {
          reason: !safe.length
            ? 'every remaining close would increase naked exposure'
            : 'every exposure-neutral close would breach the realised-loss cap',
          capNeededForNextSafeStep: cheapestSafe == null ? null : +cheapestSafe.toFixed(2),
          unsafeGainAvailable: +Math.max(0, ...affordable.map(gainOf)).toFixed(2)
        };
      }
      break;
    }

    const deep = candidates.filter(c => !c.thin);
    const ranked = (deep.length ? deep : candidates)
      .sort((a, b) => efficiency(b, gainOf(b)) - efficiency(a, gainOf(a)) || gainOf(b) - gainOf(a));
    let pick = ranked[0];

    if (isFinite(target) && metric(pick.resultPool) > target) {
      let lo = 0, hi = 1;
      for (let k = 0; k < 40; k++) {
        const mid = (lo + hi) / 2;
        if (metric(candidateEffect(ctx, work, '', '', scaleCloses(pick.closes, mid)).resultPool) >= target) hi = mid;
        else lo = mid;
      }
      pick = { ...candidateEffect(ctx, work, pick.label, pick.type, scaleCloses(pick.closes, hi)), partial: true };
    }

    work = pick.resultPool;
    ctx.taken = mergeCloses(ctx.taken, pick.closes);
    ctx.takenCost = closeCost(pool, prices, ctx.taken, opts);
    realizedTotal += pick.realized;
    costTotal     += pick.cost;
    const now = evalPool(work, prices, opts);
    const { resultPool, ...record } = pick;
    steps.push({ ...record, cumulativeFree: +now.freeUsable.toFixed(2),
                 cumulativeBuffer: +now.buffer.toFixed(2),
                 cumulativeLiqPct: nearestLiqPct(work, prices, opts),
                 cumulativeRealized: +realizedTotal.toFixed(2) });
  }

  const end = evalPool(work, prices, opts);
  const value = metric(work);
  const summary = (state, pl) => ({
    free: +state.freeUsable.toFixed(2), buffer: +state.buffer.toFixed(2),
    im: +state.im.toFixed(2), mm: +state.mm.toFixed(2), equity: +state.equity.toFixed(2),
    gross: +grossNetDelta(pl, prices).toFixed(2), betaNet: +betaNet(pl, prices, betas).toFixed(2),
    nearestLiqPct: nearestLiqPct(pl, prices, opts)
  });

  return {
    objective, target: target === Infinity ? null : target,
    ceiling,
    deltaTolerance: deltaTol,
    before: summary(start, pool),
    after:  { ...summary(end, work), positions: end.positions.length },
    realized: +realizedTotal.toFixed(2),
    cost: +costTotal.toFixed(2),
    closes: ctx.taken,
    steps,
    blocked,
    allowBreakingHedges,
    targetMet: target === Infinity ? null : value >= target,
    shortfall: target === Infinity ? null : +Math.max(0, target - value).toFixed(2),
    targetAboveCeiling: target !== Infinity && target > ceiling.maxFree && objective === 'free',
    resultPool: work
  };
}

// ─── MARKET STATS ────────────────────────────────────────────────────────────

export function stdev(xs) {
  if (!xs || xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
}

// Returns for two candle series paired on equal timestamps, keeping only steps one
// candle apart. Slicing the tails by recency silently pairs different hours whenever one
// symbol's cache is staler than the other's.
export function alignedReturns(a, b) {
  const A = new Map((a || []).filter(c => c && c.t != null).map(c => [c.t, c.close]));
  const B = new Map((b || []).filter(c => c && c.t != null).map(c => [c.t, c.close]));
  const ts = [...A.keys()].filter(t => B.has(t)).sort((p, q) => p - q);
  if (ts.length < 3) return { x: [], y: [] };

  const gaps = [];
  for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
  const step = [...gaps].sort((p, q) => p - q)[Math.floor(gaps.length / 2)];

  const x = [], y = [];
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] - ts[i - 1] !== step) continue;
    const a0 = A.get(ts[i - 1]), a1 = A.get(ts[i]);
    const b0 = B.get(ts[i - 1]), b1 = B.get(ts[i]);
    if (!(a0 > 0) || !(b0 > 0)) continue;
    x.push((a1 - a0) / a0);
    y.push((b1 - b0) / b0);
  }
  return { x, y };
}

// Beta of an asset against BTC from aligned return series.
export function beta(assetReturns, btcReturns) {
  const n = Math.min(assetReturns?.length || 0, btcReturns?.length || 0);
  if (n < 2) return 1;
  const a = assetReturns.slice(-n), b = btcReturns.slice(-n);
  const ma = a.reduce((x, y) => x + y, 0) / n;
  const mb = b.reduce((x, y) => x + y, 0) / n;
  const cov = a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0) / (n - 1);
  const varB = b.reduce((s, v) => s + (v - mb) ** 2, 0) / (n - 1);
  return varB === 0 ? 1 : cov / varB;
}

// Daily sigma in percent, from hourly returns scaled by sqrt(24).
export function dailySigmaPct(hourlyReturns) {
  return stdev(hourlyReturns) * Math.sqrt(24) * 100;
}
