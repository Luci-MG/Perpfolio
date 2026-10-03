# Unwind

Which positions to close, in what order, to free margin, restore liquidation buffer or push
every liquidation price far enough away — and what the book looks like afterwards. One tool,
**Tools → Unwind**, Binance USDM cross pools only. It never sends an order.

## What a close actually does
```
equity          falls by the exit cost only — realised PnL replaces unrealised one for one
free margin    += initial margin released
buffer         += maintenance margin released
exposure        changes by the leg's delta (down for a naked leg, UP for a hedge leg)
```
`closePositions` **must** credit realised PnL to collateral. Dropping a position without it
inflates equity by that position's loss — on a book carrying a large unrealised loss it reported
free margin five times the true figure. That is the first thing the tests pin.
`applyCloses` wraps it and charges the exit cost from `closeCost`: each leg walks its side of the
live book (signed slippage, so a fill better than the mark lowers the cost) and pays its own
symbol's taker rate; a symbol without a book pays its fee at the mark, and depth that runs out
is reported as `thin` with the unfilled size.

### The ceiling comes first
Free margin is `equity − initial margin − reserved`, and closing never raises equity, so
**free margin can never exceed `equity − reserved − exit cost`** however much is closed.
`deleverageCeiling` reports it (`maxFree`, with `closeAllCost`) and `targetAboveCeiling` flags a
request that no combination of closes can satisfy.

### Where the margin actually is
A same-symbol hedge pays initial margin on **both** legs (verified: `notional/leverage` per
leg, no netting) while contributing no net delta. On this book three matched hedges hold
over 90% of the total initial margin at zero directional exposure, so the matched
portion is the whole optimisation.

## The tool
Built in the browser from the risk book (`/api/riskbook`: pool, marks, depth, taker rates,
betas) with the engine the server uses, so a changed input recomputes at once and every number
on the page comes from one pool. Header: **Plan | Build**, the book's age with Refresh, and the
pool switch when there are two pools (it opens on the pool nearest a kill price).

- **Plan** — objective (**free margin** $, **liquidation buffer** $, or **liquidation
  distance**: every liquidation price at least N% from the mark), target, max realised loss,
  fee override, and *Allow breaking hedges*. The steps table shows each close's gain, exit
  cost, Δ exposure per coin and in BTC terms, realised PnL and the running total.
  **Edit this plan** loads its closes into Build, replacing whatever was selected there.
- **Build** — every position with a % slider; hedged symbols carry a **matched** shortcut that
  sets both legs to the matched size. Presets: close hedge longs, hedge shorts, matched,
  everything, clear.
- **Readout**, shared by both (the plan's end state, or your selection): free margin and
  buffer before → after, realised, exit cost at the live book, equity; net exposure per coin,
  gross, and **in BTC terms by beta**; the liquidation table (below); and **Then the market
  moves** — every coin alike or by beta to BTC, ±50%, on whatever is left.

Inputs, mode and selection stay while the page is open: the 15s poll leaves the panel mounted
(`#uw-mounted`), a refreshed book recomputes the plan, and a position that no longer exists
drops out of the selection. Dragging a slider patches only the readout, so the slider being
dragged is never replaced.

## The planner — `deleveragePlan`
Greedy, re-deriving candidates against the evolving book each step so bracket tiers and
part-closed legs are accounted for. Candidates are the matched part of each same-symbol hedge
and every leg in full.

- **Ranked by gain per dollar of exit cost.** Equity only ever pays the exit cost, so that is
  the price of each dollar freed. A step's cost is what it adds to everything already taken,
  walked on one book, so a second close on the same side pays for the depth the first used.
- **A thin book is a last resort.** A close the book cannot fill is taken only when no
  candidate that can be filled qualifies, and is flagged in the table.
- **The last step lands on the target.** Earlier steps are needed in full; the one that would
  overshoot is bisected to the size that reaches the target (marked *part*).
- **Exposure is a guardrail, not a tie-breaker.** Unless *Allow breaking hedges* is on, a
  close that raises exposure by more than **0.5% of gross notional** is refused — per coin
  (`deltaShift`, a same-symbol hedge losing a leg) **or in BTC terms** (`betaShift`, the net of
  delta × beta, a cross-coin hedge losing a side). Ranking by gain and falling back to unsafe
  closes is how a planner ends up shutting the *profitable* leg of a hedge under a loss cap,
  freeing a little buffer while leaving a large leg naked.
- **When constraints cannot all be met** the planner takes no step and returns `blocked` with
  the reason, `capNeededForNextSafeStep` — the total realised loss, exit costs and earlier
  steps included, that the cap would have to allow for the cheapest exposure-neutral close —
  and the gain it refused. Only a realised **loss** is capped; taking a profit is never blocked.
- **Liquidation distance** is measured with the published-convention solve below, nearest
  asset first; a book with no reachable liquidation price reads *none*.

## Liquidation price
The readout's table gives, per asset, the liquidation price the **exchange** would show now
and after the closes, with the room gained or lost, *closed*, *now liquidatable* or
*unreachable*, and a banner naming every asset that moved toward the mark.

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
the same definition by scanning, giving two independent implementations. The Stress tab keeps
the live engine's reading, which re-tiers as notional moves.

Verification, since the account is read-only and no position can actually be closed:
- **Against the exchange, live**: worst error **2.1e-8%** on every symbol checked —
  the same price to the last published digit. The readout recomputes this on every render and
  shows it as a badge, so the claim is checkable rather than asserted; a solve many multiples
  from the mark is named as an extrapolation instead of being scored.
- **Against the ray scan**: agreement to 8e-11% across every leave-one-out close. The scan
  reports `none` where a threshold sits beyond its ±300% range (HYPE at +797%), which is
  why the analytic form is the primary.
- **Against the definition**: `equity == mm` to ~1e-11 at every price the tool reports.
- **Against Binance's published approximation** `Entry × (1 − 1/lev + mmr)`: agreement to
  first order for a single position collateralised at its own initial margin.

The insight the table exists to surface: closing a position releases its maintenance margin,
which pushes every *other* asset's liquidation **further away**; only the symbol that loses a
hedge leg moves **closer**. Closing all longs on a hedged book took ETH from +135.7% to
+10.4% and HYPE from +797.5% to +22.0% while gaining room on everything else.

## Engine surface
`closeCost`, `applyCloses`, `betaNet`, `nearestLiqPct`, `unwindOutcome` (everything the readout
shows for one set of closes), `deleverageCeiling`, `deleveragePlan` — all in `risk-engine.js`,
which the browser imports. Their options: `books` and `fees` keyed by asset, `feeRate` as the
fallback, `betas` keyed by asset (1 where unknown), and the tier mode the stress calibration
chose (`perSideTiers`), so Unwind and Stress agree on maintenance margin.
