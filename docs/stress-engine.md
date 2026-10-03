# Cross-pool stress engine

## Cross-Pool Stress Simulator (Binance USDM)

Interactive what-if on the Binance cross-margin pool: move any coin's price and watch
the shared collateral pool drain, with markers showing the exact price at which the pool
is exhausted and liquidation begins. Hyperliquid is deliberately out of scope — it is an
independent pool with an independent liquidation event.

### Module: `risk-engine.js` (ESM)
Pure functions, no I/O. **Shared verbatim with the browser** (served at `/risk-engine.js`),
so the panel and the API cannot disagree.

- `pickTier(brackets, notional)` / `maintMargin(notional, tier)` — `notional × mmr − cum`
- `upnl(pos, price)` — signed size, linear USDT contract
- `initialMargin(pos, price)` — `notional / leverage` (the position's own leverage setting)
- `evalPool(pool, prices, opts)` → `{ equity, mm, buffer, marginRatio, usedPct, liquidated, positions[] }`
- `netDeltas(pool, prices)` — signed USD delta per asset
- `applyStops(pool, from, to)` → `{ pool, fired[] }` — reduce-only triggers crossed on the path
- `scanRay(pool, base, dir, opts)` → `{ breachLambda, breachPrices, minBuffer, samples }`
- `killPrices(pool, asset, base, opts)` → up/down threshold price + `minBufferUp/Down`;
  `opts.metric` selects `'buffer'` (liquidation, default) or `'free'`
- `killPricesBoth(pool, asset, base, opts)` → both thresholds, walking each direction once
- `rayCap(dir, opts)` — how far a ray may run before some price would reach zero
- `freezeTiers(pool, prices, opts)` / `crossesTier(pool, asset, prices, price, opts)` — the
  exchange-style frozen-tier reading, and whether any leg's threshold crosses a bracket.
  Both take the calibrated tier mode: with `perSideTiers` each leg is tiered on its own
  notional, as `evalPool` and `liquidationDetail` do. Until 2026-10 they always used the
  combined notional, so in per-side mode the frozen kill, its "· exch" note and the tier
  flag disagreed with the closed form
- `exitCost(levels, qty, mark, feeRate, side)` — slippage against the mark plus commission;
  slippage is signed by the closing side, so a fill better than the mark lowers the cost
- `liquidationAfterCloses(pool, prices, closes, opts)` — per-asset liquidation before and
  after a set of closes, with the room gained and which assets stopped existing
- `liquidationDetail(...)` — the solve plus its conditioning (see *Conditioning*)
- `alignedReturns(a, b)` — returns paired on equal timestamps
- `drainPer1Pct(pool, asset, base)` — buffer cost of a ±1% move
- `scenarioDir(pool, mode, {betas, sign, prices})` — `uniform` | `adverse` | `btcBeta`
- `cascade(pool, prices)` — force-close largest-MM-first until solvent
- `closePositions(pool, prices, closes, feeRate)` → `{ pool, realized, notionalClosed, fees }`
- `grossNetDelta(pool, prices)` — Σ|net delta| per asset
- `deleverageCeiling(pool, prices, opts)` / `deleverageCandidates(…)` / `deleveragePlan(…)`
- `beta`, `stdev`, `dailySigmaPct` — market stats (reuses
  `computeReturns` from `vol-estimator.js`)

### The math
```
notional_i = |q_i| × P
upnl_i     = q_i × (P − entry_i)
tier_i     = bracket containing Σ|notional| over the symbol   (both hedge legs)
mm_i       = max(0, notional_i × mmr − cum)                   (MMR/cum applied PER leg)
im_i       = notional_i / leverage_i
equity     = crossWalletBalance + Σ upnl_i
buffer     = equity − Σ mm_i                → liquidation at buffer ≤ 0
free       = equity − Σ im_i − freeReserved → no capacity to open or transfer at free ≤ 0
```
Two thresholds, one scan primitive. **Free margin is hit well before liquidation** and is
the number that governs whether a position can be opened or collateral transferred out.

### Per-leg `cum`, and why the exchange's own liq price differs
Two questions only bite above tier 1, and both are settled empirically:

- **`cum` is deducted per leg, not per symbol.** One hedged symbol's combined notional sits in a
  `cum = 100` tier: per-leg reproduces the reported maintenance margin to 0.0000%,
  per-symbol is off by 9.0%. A book entirely inside tier 1 (`cum = 0`)
  cannot test this — a 0% maintenance-margin match there proves nothing about `cum`.
- **The engine re-tiers; the exchange's published `liquidationPrice` does not.** Binance
  computes maintenance margin as `notional × MMR(at the level of position notional) −
  maintenance amount(at that level)`, so its live engine re-tiers as notional moves, but
  the liquidation price it publishes freezes the tier at the current notional. Where a
  threshold crosses a bracket the two legitimately differ — 1.33% on one symbol, re-tiered
  against frozen. `freezeTiers` reproduces the published figure to **0.000%**,
  which is what validates the arithmetic; the re-tiered figure is what should actually
  happen, so it is the one shown, annotated `· exch <price>`.

`freeReserved` covers the price-invariant holds — open-order initial margin plus anything
else the exchange withholds — and is **anchored** by the server to the reported
`availableBalance` rather than guessed: `freeReserved = equity(marks) − im(marks) − availableBalance`.
Order margin is locked at each order's own price, so it does not move with the marks. The
price-varying half (`im_i = notional/leverage`) is modelled exactly and checked separately
against the reported `positionInitialMargin`, so the anchor cannot mask a simulation error.
Observed live: per-position initial margin reproduces `notional/leverage` to 8 decimals,
and the residual hold came within a few percent of the reported open-order margin.
Maintenance margin is **non-linear in price** (notional crosses bracket tiers), so every
threshold is found by scanning a price ray and bisecting the first breach — never by an
analytic solve. Along a ray the buffer is concave (it can rise before it falls), so
bisection anchored at the far end can return the wrong root.

### Ray sampling — four things it has to get right
1. **Fine near the mark, coarse far out**: 0.25% steps to ±30%, then 1% steps. Between the
   discontinuities in 3 and 4 the buffer is concave and free margin linear, so a coarse grid
   cannot skip a crossing; bisection then refines to ~1e-9.
2. **Range bounded by price positivity, not a magic number**: `rayCap` runs a downside ray
   to −99.9% and an upside ray to +300%. An earlier fixed ±90% cap made the engine report
   BTC as "unreachable" when Binance's own liquidation price sat at −92.7%.
3. **Trigger prices sampled explicitly** when `honorStops` is on. A firing take-profit
   removes that leg's maintenance margin, so the buffer jumps *upward* discontinuously —
   the one place concavity breaks. Without sampling the approach to each trigger a breach
   can sit entirely between two grid points and the scan reports the later, more
   flattering one. Regression-tested: a breach at 110.10 masked by a stop at 110.20 was
   previously reported as 111.29.
4. **Bracket floors sampled explicitly** (`tierBreakpoints`). The tier is picked from the
   symbol's *combined* notional but `cum` is subtracted *per leg*, so when a hedge crosses a
   floor its maintenance margin **drops** and the buffer jumps upward — concavity breaks
   there too. Found in the 2026-09-29 review: long 230 / short −250 at 100, a true breach at
   104.15 (+4.15%) was reported at 106.38 (+6.38%), the flattering later crossing. Floors
   are solved in closed form along the ray (notional is linear in λ) for the combined basis,
   or per leg in per-side mode, and λ just below and at each is scanned.

### Pools are per collateral asset
With `multiAssetsMargin: false` (the default), **each margin asset is its own cross pool**.
A USDC-margined contract (e.g. `ZECUSDC`) is backed by the USDC wallet alone — a USDT
balance of any size is no protection. `buildPools()` groups by quote asset and reads each
pool's collateral from `account.assets[]`. Multi-assets mode collapses them into one pool
and raises a banner, since collateral haircuts are not modelled.

### Endpoint: `GET /api/riskbook`
Returns `{ ok, pools[], account, isolated[] }`. Each pool carries `pool` (engine shape),
`marks`, `opts`, `stats` (beta/σ/bars per asset), `state` (equity/mm/im/free/buffer),
`baseline` (liquidation and free-margin thresholds, σ, buffer and free drain per 1%, net
delta — sorted nearest-kill first), `hedgedSymbols`, `calibration`, `liqCheck`, `books` and
`fees` (taker rate per asset). The frontend simulates locally from this payload. An asset
whose mark is missing or 0 gets a row with `noMark: true` and empty thresholds rather than
failing the whole response. The order books and commission rates are fetched in parallel
with the candle stats, and the cross-check reuses the baseline's kill scans.

- Brackets from `GET /fapi/v1/leverageBracket` (signed), cached 24h. If unavailable, the
  rate is inferred from the reported per-position maintenance margin with `cum = 0` and
  the pool is tagged `estimatedBrackets`.
- Beta uses `alignedReturns`, which pairs candles on equal timestamps. Slicing series tails
  by recency silently pairs different hours whenever one symbol's cache is staler.
- Reduce-only orders feed the stops path. `closePosition` orders carry quantity 0 on the
  exchange and close whatever is left, so they are flagged rather than filtered out by a
  `q > 0` test. The WS path needs both halves of that: `PARTIALLY_FILLED` updates `sizeRaw`
  rather than just the display string, and the synthetic order rebuilt from
  `ORDER_TRADE_UPDATE` carries `closePosition: o.cp` — without it, a close-position stop
  placed while the server is running is honoured only after a restart, so the same book
  gives two different kill prices.
- **Calibration is a feature, not a test.** Binance reports `maintMargin` per position and
  `marginBalance` per asset; every response scores the model against both, picks the
  tier-lookup mode (`combined` vs `perSide`) that reproduces the exchange, and the UI shows
  a red banner instead of plausible-looking fiction when `trustworthy` is false.
  Verified live: maintenance margin, initial margin (`imErrPct` — the check that matters
  for free margin), equity and free margin all at **0%**, and `liqCheck` reproduced every
  published `liquidationPrice` to **0.000%** on the frozen-tier reading. Binance sometimes
  publishes an absurd sentinel (~8.2e8) for a position it considers unreachable;
  `reportedLiq()` filters it, and `modelSaysUnreachable` reports the engine's own verdict
  separately so agreement and disagreement stay distinguishable.

### Frontend (`public/js/stress.js`)
5th view tab **Stress** (`posView === 'stress'`), fetched on activation only.
`fetchRiskBook()` dynamic-imports `/risk-engine.js`.

- `renderStress()` → banner + controls + `renderStressPool()` per pool (pool header,
  `renderStressRow()` per asset, `renderScenarioTable()`)
- `updateStress()` patches individual DOM nodes on every slider frame — it must **never**
  call `render()`, which rebuilds the whole dashboard and the hedge-thread SVG.
  rAF-coalesced; ~11ms per frame, ~22ms for a full render. `walkRay` finds both thresholds
  in a single pass per direction — scanning them separately cost 15ms/frame.
- The 15s dashboard poll must **not** rebuild this panel: replacing the markup mid-drag
  destroys the slider being dragged. `render()` leaves the panel mounted whenever
  `#st-mounted` exists, unless `rerenderStress()` set `riskForceRender` — so every
  deliberate rebuild (fetch, toggle, range, reset, link) goes through that helper and the
  poll only refreshes `#st-age`. A `Refresh marks` button re-reads the book.
- Assets whose positions have closed are pruned from `riskShift`/`riskLink`/`riskBeta` on
  each fetch; otherwise a closed asset keeps dragging the beta chain and forcing the
  range open.
- State: `riskBook`, `riskShift` (asset → % move, kept as percentages so a book refresh
  preserves the scenario), `riskLink` (beta chain membership), `riskBeta`, `riskRange`
  (auto-opened to the tier containing the nearest kill), `riskHonorStops`, `riskStressCorr`
- Beta linking: dragging a linked asset sets a driver in BTC terms and moves every other
  linked asset by `driver × beta`. Unlinked assets move alone (manual what-if). An asset
  with |β| under 0.2 cannot drive the group (dividing by it sent β-1 assets past −100%,
  whose negative prices silently fell back to the mark); it moves alone with a note. No
  shift goes below −99%.
- With *Honour reduce-only stops* on, each row's kill price starts from the pool with the
  other assets' stops already fired at their shifted prices, the same pool the header
  evaluates, and the ray fires the asset's own stops as it walks. Before 2026-10 the rows
  skipped the first part, so the header and the rows disagreed.
- Each row shows `vs Binance`: the worst error of its legs' live kill price against
  Binance's published liquidation price, from `liqCheck`.
- Range (30/50/80/120%) **only ever grows**, and only when a shift would not fit — so a
  thumb never misreports the real move. `afterStressChange` must not recompute the
  smallest tier that fits: that discards a range the user picked, snapping ±50% back to
  ±30% on the next nudge of any slider. `riskRangeExplicit` likewise stops a marks refresh
  from overwriting a chosen range. Shrinking belongs to Reset alone, which clears the flag
  and re-fits to the nearest kill.
- Two marker pairs sit on the slider track: red ▲▼ for liquidation, amber △▽ for free
  margin hitting zero. Off-range markers pin to the edge at 45% opacity. A direction that
  cannot reach a threshold reports the worst value it would leave.
- Pool header shows collateral, equity, maintenance margin, buffer, **free margin** and
  pool-used %. Each row shows both thresholds per direction plus `per +1%` sensitivity for
  buffer and free margin together.
- Scenario table: uniform ±, adverse basket, BTC ± × beta — each showing where free margin
  runs out, where liquidation hits raw and with reduce-only stops honoured, plus a `snap`
  button that moves every slider to that kill. When **with stops is worse**, a take-profit fires on a hedge leg first and
  leaves the remaining side naked.
- Cascade appears automatically when the current state is liquidated (no toggle) —
  largest-MM-first, labelled approximate because Binance's ordering is not public.

### Limits stated in the UI
Mark price only (no basis blowout); no liquidation fees or slippage; stops-honoured is
path-dependent and applies each asset's crossings independently; betas come from 200×1h
candles and converge to 1 in a crash (hence the β→1 toggle); isolated positions are
excluded and listed separately. Two further gaps, documented rather than modelled: a
resting order that is **not** reduce-only would add exposure if it filled during the
shock, and `freeReserved` is anchored at fetch time, so the free-margin figure goes stale
when orders are placed or cancelled. Cascade ordering is a largest-maintenance-margin
heuristic because Binance does not publish its own.

### Conditioning: when a liquidation price stops being precise
`P* = −C / A`, so `dP*/dC = −1/A` — every dollar of equity moves the liquidation price by
`1/|A|` dollars. As a book approaches delta-neutral the solve lands far outside any observed
price and that ratio grows, so the figure becomes directional rather than exact.
`liquidationDetail()` returns `coefficient`, `sensitivityPerDollar`, `multipleOfMark`,
`movePerOnePctEquity` and flags `illConditioned` when a 1% equity wobble moves it more than
5%, or it sits beyond 3× / below ⅓ of the mark.

Observed live on a tightly hedged book: BTC solves at **9.8× the mark**, where **thousands of
dollars of liquidation price ride on 1% of equity** — which is the whole explanation for its 6.6%
difference from Binance's published figure, while ETH at 6.3× differs by 0.6%. Neither is a
modelling error; both are extrapolation. The drawer reports well-conditioned solves as a
sync badge and ill-conditioned ones separately, so the panel never claims precision it does
not have. `liqCrossCheck` uses the closed form for exactly this reason — the ray scan caps
at +300% and silently stopped validating anything past it.

### ADL
`adlQuantile` rides along on each position. On a hedged book this matters more than usual:
auto-deleveraging closes *profitable* positions, so it takes the winning leg and leaves the
loser naked. The Stress tab warns at quantile ≥ 3.
