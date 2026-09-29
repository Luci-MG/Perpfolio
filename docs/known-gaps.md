# Known gaps

## Known gaps / not yet implemented

- **Binance spot** — only USDM futures; spot endpoint is `/api/v3/openOrders`
- **Hyperliquid is read-only and unmaintained** — it still renders, but none of the risk,
  unwind, journal or ledger tooling covers it, by decision
- **HL equity uses the *spot* USDC balance** (`lib/hyperliquid.js`, `getHyperliquidData`) — wrong for
  liquidation purposes, since HL perp margin comes from the perp account. Deliberately left:
  with perp value 10,000 and 12 USDC in spot it reports `equity: 12`, `marginPct: "16666.7"`
- **HL funding is hourly, Binance's is 8h/4h/1h** — the dashboard's daily funding now uses each
  position's `fundingIntervalHours` (HL positions carry `1`), but the stops engine still feeds
  HL rates to `getFundingAdjustment` as if 8h, so the L3 layer is inert on HL
- **`hedgeWarnings` in `/api/volstops`** is fixed, but `checkHedgePairHealth`'s old
  same-asset pairing is the pattern to avoid if that code is ever revisited
- **Authentication, and the server listens on every interface** — `app.listen(PORT)` binds
  `0.0.0.0` with no login and no Host check, so anyone on the same network (or a public
  Railway/Render deploy) can read positions, orders and the whole trade history, and any web
  page can start a history sync with a GET. A loopback default (`HOST` env to override) and a
  POST for sync start were proposed in the 2026-09-29 review and deliberately not applied;
  revisit before any deployment beyond this machine
- **Reconcile can race a websocket event** — a CANCELED arriving while the 60s snapshot is in
  flight is overwritten by the pre-cancel snapshot; a phantom order can show for up to a
  minute and a false drift is logged. Self-heals on the next reconcile
- **Stress slider cost grows with book size** — ~11ms/frame on this book, but a probe with 15
  assets / 25 legs / 10-tier brackets measured 43–57ms. A piecewise-analytic kill price (the
  buffer is linear between tier floors, clamp kinks and triggers) would be exact and cheaper
- **The unwind planner treats a cross-asset hedge as two naked legs** — `grossNetDelta` works
  per asset, so closing the BTC side of a BTC-long / ETH-short pair scores as de-risking.
  `/api/volstops` already restates legs in BTC-beta terms; the planner does not
- **Journal: all timing buckets are UTC**, the "all" window mixes a four-month trip span with a
  three-month income span, and the history sync's "recent" window is a fixed 7 days — a sync
  after a two-week gap misses symbols traded 8–14 days ago that are now flat (Full rebuild
  catches them)
- **Alerts** — thresholds are visible in the Stress tab but there is no push or sound
- **No streaming for market data** — positions and marks are a 15s REST poll. Only the
  Binance user-data stream is a websocket, and *that* is an accelerator over a 60s REST
  reconcile rather than a source of truth (see *Order cache*)
- **Stress simulator: Hyperliquid** — engine is per-pool, so HL slots in by building a pool
  with `collateral = crossMarginSummary.accountValue − Σ uPnL` and `mm = notional / (2 × maxLeverage)`
- **Stress simulator: two-coin heatmap** — a 2D margin-ratio grid with the liquidation
  contour would show joint extremes the one-coin-at-a-time view hides
- **Stress simulator: funding drag** — a days-held slider subtracting accrued funding from
  pool collateral before the shock
- **Unwind planner: the plan's own steps price at the mark** — the drawers walk live depth
  (*Execution cost*), but `deleveragePlan`'s step ordering still uses a flat fee rate, so a
  step that looks cheap could fill worse than stated
- **Unwind planner: partial-size search** — candidates are whole legs or the full matched
  portion of a hedge. A continuous search over close fractions would find cheaper steps
- **Unwind planner: no execution** — it produces a plan only; nothing is ever sent to an
  exchange. Use a key without trading permission so that safety does not rest on the code alone
- **Journal: income capped at 3 months** by Binance, so the equity curve stops there while
  round-trip statistics reach further; the panel states both spans
- **Journal: positions opened before the earliest reachable fill** are excluded from round
  trips; their closing fills are reported as an orphan bucket rather than dropped
- **Depth is a snapshot** — it shows what the book can absorb now, not during a move
- **Journal has no manual annotation** — no per-trade notes, tags, screenshots or emotional
  state. Everything shown is derived from exchange records, which is why it can be
  reconciled; anything hand-entered would need storage the store does not yet have
- **Timing breakdowns are UTC** with no session or local-time grouping
