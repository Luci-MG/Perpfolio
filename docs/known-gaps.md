# Known gaps

## Known gaps / not yet implemented

- **Drawdown before equity snapshots is a lower bound** — the wallet rebuilt from the ledger
  leaves out open positions, so a fall that touches that segment reads "at least". It becomes
  exact as snapshots accumulate (every 15 minutes while the server runs).
- **Replayed habit costs are estimates** — trips keep their opening lot, quantity entered and
  average exit, not every lot, so "without the adds" closes the opening lot at the trip's
  average exit and scales fees and funding by quantity. Lot-by-lot replay would need each lot stored.
- **Binance spot** — only USDM futures; spot endpoint is `/api/v3/openOrders`
- **Hyperliquid is read-only and unmaintained** — it still renders, but none of the risk,
  unwind, journal or ledger tooling covers it, by decision
- **HL equity uses the *spot* USDC balance** (`lib/hyperliquid.js`, `getHyperliquidData`) — wrong for
  liquidation purposes, since HL perp margin comes from the perp account. Deliberately left:
  with perp value 10,000 and 12 USDC in spot it reports `equity: 12`, `marginPct: "16666.7"`
- **`hedgeWarnings` in `/api/volstops`** is fixed, but `checkHedgePairHealth`'s old
  same-asset pairing is the pattern to avoid if that code is ever revisited
- **No login** — the server listens on loopback and refuses any other `Host` (`lib/http.js`),
  so nothing off this machine reaches it by default. Setting `HOST=0.0.0.0` for a phone on the
  LAN or a Railway/Render deploy exposes positions, orders and the whole trade history to
  anyone who can reach the address and is listed in `ALLOWED_HOSTS`; put it behind
  authentication before doing that
- **Reconcile can race a websocket event** — a CANCELED arriving while the 60s snapshot is in
  flight is overwritten by the pre-cancel snapshot; a phantom order can show for up to a
  minute and a false drift is logged. Self-heals on the next reconcile
- **Stress slider cost grows with book size** — ~11ms/frame on this book; a probe with 15
  assets / 25 legs / 10-tier brackets measured 43–57ms, about 15ms since brackets are sorted once. A piecewise-analytic kill price (the
  buffer is linear between tier floors, clamp kinks and triggers) would be exact and cheaper
- **Unwind guards a cross-coin hedge but never closes one as a pair** — closing one side of a
  BTC-long / ETH-short pair is refused on its BTC-beta exposure, but no candidate closes both
  sides together sized by beta, and betas from 1h candles are noisy enough that they gate a
  step rather than size one
- **Journal: the "all" window mixes spans** — trips reach back as far as fills, the ledger only
  three months, so the calendar, the wallet ledger and the account curve start later than trip statistics
- **Slippage is not measured** — it needs the price at the moment each order was sent; fills carry
  only the price they filled at
- **Costs cover Binance only** — Hyperliquid has no fill history in the dashboard
- **Confluence: two modelling choices left as they are** — the crowding cap also applies on the
  1d timeframe, where leverage is shown for information only, and the BTC discount changes the
  displayed alt score while the calibrated composite beside it is undiscounted. Both want their
  own research before the maths changes (`docs/confluence.md`)
- **Alerts** — thresholds are visible in the Stress tab but there is no push or sound (roadmap P6)
- **No streaming for market data** — positions and marks are a 15s REST poll. Only the
  Binance user-data stream is a websocket, and *that* is an accelerator over a 60s REST
  reconcile rather than a source of truth (see *Order cache*)
- **Stress simulator: Hyperliquid** — engine is per-pool, so HL slots in by building a pool
  with `collateral = crossMarginSummary.accountValue − Σ uPnL` and `mm = notional / (2 × maxLeverage)`
- **Stress simulator: funding drag** — a days-held slider subtracting accrued funding from
  pool collateral before the shock
- **Unwind: no execution** — it produces a plan only; nothing is ever sent to an
  exchange. Use a key without trading permission so that safety does not rest on the code alone
- **Journal: income capped at 3 months** by Binance, so the equity curve stops there while
  round-trip statistics reach further; the panel states both spans
- **Journal: positions opened before the earliest reachable fill** are excluded from round
  trips; their closing fills are reported as an orphan bucket rather than dropped
- **Depth is a snapshot** — it shows what the book can absorb now, not during a move
- **Notes only on closed trips** — an open position has no trip key yet; tagging at entry would
  need the entry order id from entry capture
- **Kill prices are scanned, not solved** — a piecewise-analytic solve would be exact by
  construction and ~100× cheaper per slider frame, but the scan already matches Binance exactly
  and the slider does not lag, so it was dropped (2026-10-03)
- **Hedged funding before 2026-07-05 is incomplete** — the income cache dropped the receiving leg
  of every hedged settlement until 2026-10-03, and Binance serves only three months of income, so
  hedged settlements cached before the repair window keep one row. Their trips show funding as
  unknown; ledger totals that reach back that far overstate funding paid
