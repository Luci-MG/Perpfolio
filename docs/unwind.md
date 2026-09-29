# Unwind planner and drawers

## Unwind planner (Binance USDM)

Which positions to close, in what order, to free margin or restore liquidation buffer.

### What a close actually does
```
equity          unchanged   — realised PnL replaces unrealised one for one
free margin    += initial margin released
buffer         += maintenance margin released
gross exposure  changes by the leg's delta (down for a naked leg, UP for a hedge leg)
```
`closePositions` **must** credit realised PnL to collateral. Dropping a position without it
inflates equity by that position's loss — on a book carrying a large unrealised loss it reported
free margin five times the true figure. That is the first
thing the tests pin.

### The ceiling comes first
Free margin is `equity − initial margin − reserved`, and closing never changes equity, so
**free margin can never exceed `equity − reserved`** however much is closed.
`deleverageCeiling` reports it and `targetAboveCeiling` flags a request that no combination
of closes can satisfy — the honest answer to "how do I get to more free margin than I have equity" on any
book is that closing cannot do it.

### Where the margin actually is
A same-symbol hedge pays initial margin on **both** legs (verified: `notional/leverage` per
leg, no netting) while contributing no net delta. On this book three matched hedges hold
over 90% of the total initial margin at zero directional exposure, so the matched
portion is the whole optimisation.

### Exposure is a guardrail, not a tie-breaker
`allowBreakingHedges` defaults to **false**. Ranking by margin released and falling back to
unsafe closes when no safe one qualifies is how a planner ends up proposing to shut the
*profitable* leg of a hedge under a realised-loss cap: at a stressed mark it freed a little
buffer while leaving a large leg naked and liquidation at +5%. When constraints are mutually
unsatisfiable the planner takes no step and returns `blocked` with the reason, the loss the
cheapest exposure-neutral close would realise, and the gain it refused.

### Endpoint: `GET /api/deleverage`
`objective=free|buffer`, `target`, `maxLoss`, `fee`, `breakHedges`. Greedy, re-deriving
candidates against the evolving book each step so bracket tiers and part-closed legs are
accounted for. Returns `ceiling`, `before`/`after`, `steps[]` (with legs, gain, `deltaShift`,
realised, cumulative), `blocked`, `remaining[]` and `thresholdsAfter[]`. Uses the tier mode
the stress calibration chose, so both endpoints agree on maintenance margin.
Only a realised **loss** is capped — taking a profit is never blocked.

### Frontend
6th view tab **Unwind** (`posView === 'unwind'`), fetched on activation. Same
mounted-panel guard as the Stress tab (`#uw-mounted`) so the 15s poll cannot rebuild the
panel and drop input focus mid-edit.

### Liquidation after close (sidebar drawer)
Close a subset of positions, get the liquidation price the **exchange** would then show for
everything left. Reached from the icon block in the sidebar (`renderCalcTiles`, scissors) →
`openLiqDrawer()` → `#liqDrawer`, computed client-side from `riskBook` so there is no second
code path.

Built on `liquidationPriceAnalytic`, a closed-form solve of `equity(P) = maintenanceMargin(P)`
with the asset's legs carrying `P` and every other position frozen at its mark:
```
A  = Σ_legs (q_l − |q_l|·mmr_l)
C  = WB + Σ_others (upnl_j − mm_j) − Σ_legs q_l·E_l + Σ_legs cum_l
P* = −C / A          A = 0, or P* ≤ 0  →  null (no positive price liquidates the book)
```
Two deliberate choices make it match what Binance publishes rather than what its live engine
does: the **margin tier is frozen** at the current notional, and the solve is **linear**, so
it does not clamp a leg's maintenance margin at zero the way a scan of the true non-linear
surface does. Binance's formula does not clamp either. `killPrices` over `freezeTiers` solves
the same definition by scanning, giving two independent implementations.

Verification, since the account is read-only and no position can actually be closed:
- **Against the exchange, live**: worst error **2.1e-8%** on every symbol checked —
  the same price to the last published digit. The panel recomputes this on every open and shows it as a badge,
  so the claim is checkable rather than asserted.
- **Against the ray scan**: agreement to 8e-11% across every leave-one-out close. The scan
  reports `none` where a threshold sits beyond its ±300% range (HYPE at +797%), which is
  why the analytic form is the primary.
- **Against the definition**: `equity == mm` to ~1e-11 at every price the tool reports,
  re-checked for each close in the drawer test.
- **Against Binance's published approximation** `Entry × (1 − 1/lev + mmr)`: agreement to
  first order for a single position collateralised at its own initial margin.

The insight the panel exists to surface: closing a position releases its maintenance margin,
which pushes every *other* asset's liquidation **further away**; only the symbol that loses a
hedge leg moves **closer**. Closing all longs on a hedged book took ETH from +135.7% to
+10.4% and HYPE from +797.5% to +22.0% while gaining room on everything else — the panel
raises a banner naming every asset that moved toward the mark.

### Unwind simulator (sidebar drawer)
The hand-driven counterpart to the tab: the tab computes an optimal plan, the drawer lets
you build one leg by leg. Reached from the icon block in the sidebar (`renderCalcTiles`,
sliders) → `openSimDrawer()` → `#simDrawer`, following the same overlay/drawer pattern as the
uPnL, exposure and funding drawers (so the 15s poll, which rebuilds the sidebar, cannot touch
it — the drawer lives at body level).

- Per symbol: `close long` / `close short` / `matched`, with a 0–100% slider. `matched`
  closes `min(|long|, |short|) × pct` on both legs, so the legs stay hedged against each
  other down to whatever is left.
- Presets: `TP the hedge longs`, `TP the hedge shorts`, `Close matched`, `Close everything`.
- Readout: free margin, buffer, realised, notional and fees, net delta **per coin** before
  → after, and gross exposure — the number that exposes an asymmetric unwind.
- **Then the market moves**: a ±50% slider applied to whatever is still open, reporting
  uPnL on the remainder, equity, buffer, free margin and the liquidation thresholds left.
  This is the point of the tool — closing one side of a hedge converts a flat book into a
  directional one, and the thresholds say how much room the remaining side has.
- `updateSimOutcome()` patches `#simOut` alone so that slider stays smooth; the rest of the
  body is rebuilt only on a selection change.
- State: `simSel` (symbol → {side, pct}), `simMove`. Fee rate is shared with the Unwind
  tab's `uwFee`.
