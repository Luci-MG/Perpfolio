// calc-engine.js — the calculators' arithmetic: position size, P&L, the exit for a target
// return, the add that reaches a target average, and the isolated liquidation estimate.
// Served to the browser at /calc-engine.js, so the modal and the tests run the same code.

import { pickTier } from './risk-engine.js';

/** Quantity, margin and notional from either the margin committed (`usd`) or the quantity (`qty`). */
export function sizeFrom({ mode, value, entry, lev = 1 }) {
  if (!(value > 0) || !(entry > 0) || !(lev > 0)) return null;
  const qty = mode === 'qty' ? value : value * lev / entry;
  return { qty, notional: qty * entry, margin: qty * entry / lev };
}

/** Profit of `qty` from `entry` to `exit` for `side`, and its return on `margin` in percent. */
export function pnlAt({ side, entry, qty, exit, margin }) {
  const pnl = (side === 'Long' ? exit - entry : entry - exit) * qty;
  return { pnl, roiPct: margin > 0 ? pnl / margin * 100 : null };
}

/** The exit price that returns `targetPct` on `margin`. */
export function exitForReturn({ side, entry, qty, margin, targetPct }) {
  const move = margin * targetPct / 100 / qty;
  return side === 'Long' ? entry + move : entry - move;
}

/**
 * Notional to add at `newEntry` so `qtyOld` held at `entry` averages to `target`. Returns
 * `{ unreachable: true }` when no add at that price gets there.
 */
export function averageAdd({ entry, qtyOld, newEntry, target }) {
  const denominator = 1 - target / newEntry;
  const addNotional = (target * qtyOld - qtyOld * entry) / denominator;
  if (Math.abs(denominator) < 1e-10 || !(addNotional >= 0)) return { unreachable: true };
  const addQty = addNotional / newEntry;
  const newQty = qtyOld + addQty;
  const totalNotional = qtyOld * entry + addNotional;
  return { addNotional, addQty, newQty, totalNotional, achieved: totalNotional / newQty };
}

/** Isolated-margin liquidation estimate: entry moved by 1/leverage less the maintenance rate. */
export function isolatedLiq({ side, entry, lev, mmrPct }) {
  if (!(entry > 0) || !(lev > 0)) return null;
  const mmr = mmrPct / 100;
  const price = Math.max(0, side === 'Long' ? entry * (1 - 1 / lev + mmr) : entry * (1 + 1 / lev - mmr));
  return { price, distPct: Math.abs(entry - price) / entry * 100 };
}

/** Binance's maintenance rate, in percent, for a position of `notional` on `brackets`. */
export function maintRatePct(brackets, notional) {
  const tier = pickTier(brackets, notional);
  return tier ? tier.maintMarginRatio * 100 : null;
}
