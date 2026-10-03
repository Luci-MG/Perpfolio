# Account history, journal and hedge ledger

## Account history, journal and hedge ledger

Everything above models risk *forward*. These measure what already happened and what the
current book costs to hold. Sizing figures come from the live account, pulled read-only.

### `history-store.js` — append-only NDJSON cache
Binance serves income for three months and fills only through `fromId` paging, so history is
cached locally in `data/` (gitignored): `income.ndjson`, `trades-<SYMBOL>.ndjson`, `meta.json`
for cursors. `appendNdjson` dedupes on each record's own id, which makes an overlapping
refetch free and the cursors an optimisation rather than a correctness requirement — a
resync adds **0** rows. `tradesFile()` strips path characters so a malformed symbol cannot
escape the directory. A torn final line (killed mid-write) is skipped, not fatal.

**`userTrades` silently clamps `startTime` to a 7-day window** — a naive 90-day pull returned
a small fraction of the fills the income data implied. `fromId` paging has no such limit and
reaches all of them. A first full build of a few months of activity takes about a minute.
A routine resync touches only symbols traded in the last 7 days plus anything open (~10s);
`?full=true` forces all of them.

### `trade-analytics.js` — round trips and statistics
`buildRoundTrips(fills)` walks fills per `(symbol, positionSide)` and closes a trip when size
returns to zero, because the exchange reports PnL per fill and never per position. It handles
partial closes, hedge legs as separate trips, and a one-way fill that crosses zero (closing
one position and opening the opposite). Commission paid in BNB is reported separately rather
than added to a dollar total.

`addsWhileUnderwater` counts size increases at a price worse than the running average entry —
the metric that splits the book: **trips that added while underwater lost money at a payoff
well below 1; trips that never did were net positive at a payoff above 1.5** (re-measured
2026-09-29 after the two fixes below).

Two things `buildRoundTrips` has to get right, both found in the 2026-09-29 review:
- **"Closed" is relative, not absolute.** Summed fill quantities leave float dust (~1e-11);
  an absolute `1e-12` kept finished trips open, merged each into the next and counted its
  adds-down against a stale average. The tolerance is `max(1e-12, size × 1e-9)` and a closed
  size is snapped to exactly 0.
- **Orphan fills are excluded, and counted.** A hedge-mode fill that reduces a side with
  nothing open closes a position opened before the earliest reachable fill. It used to push
  size negative and later "close" as a fabricated trip. It now goes to `orphans`, and the Journal footer states
  how large that bucket is.

Statistics over those trips: `summarise(trips)` (win rate, payoff, expectancy, profit
factor, median hold) and `bySymbol(trips)`, which is `summarise` grouped and sorted worst
first. `behaviourSplit(trips)` returns the added-while-underwater partition as two
`summarise` results. From the income ledger: `equityCurve(income)` (daily and cumulative PnL
with running drawdown, green/red day counts, best and worst day) and `incomeTotals(income)`
(per-type totals plus fee drag as a share of gross realised).

Breakdowns for the journal sections: `byDayOfWeek` / `byHourOfDay` / `byHoldTime` / `bySide`
/ `byMonth`, each bucket carrying its trip count and a `thin` flag below 10 trips;
`streaks`; `sequenceEffect` (size after a win against size after a loss — revenge trading
shows up as a *bigger* position, not a worse one); `sizeDistribution`; `makerTaker`;
`records`; and `calendar(income)`, which lays Monday-first weeks and leaves an untraded day
`null` rather than zero so "no trading" never reads as "flat".

**The cross-check that matters**: every fill's `realizedPnl` must land in exactly one bucket —
a closed trip, a trip still open, or the orphan bucket. Verified 2026-09-29 across every
symbol and fill at a worst per-symbol gap of **$2.7e-11**. Closed trips alone do
*not* equal income `REALIZED_PNL` — orphans and trips straddling the three-month income
window account for the gap — and the footer says so rather than claiming a match.

### Funding cadence: observed beats declared
`/fapi/v1/fundingInfo` reports `fundingIntervalHours`, and 8h is **not** a safe assumption —
PUMPUSDT settles every 4h, so a `×3` daily figure understates it 2×. Worse, the declared value
can be wrong: **LABUSDT settles hourly** (362 one-hour gaps against 18 four-hour ones, switched
2026-06-24) while `fundingInfo` still says 4h — trusting it understates that symbol 4×.
`inferFundingInterval()` derives the cadence from settlement timestamps in the income history
and the hedge ledger prefers it, falling back to the declared value. Timestamps are deduped
first so hedge mode billing both legs at one instant cannot look like a shorter interval.

### Execution cost
`walkBook(levels, qty)` consumes one side of the order book and reports the unfilled remainder
rather than inventing a price for depth that is not there; `exitCost()` splits the result into
slippage against the mark and commission. `roundToStep()` floors a quantity onto the symbol's
lot grid. The riskbook payload carries 50 levels per asset (10s cache), the lot filters, and
the account's **real** commission rate — taker 0.05% / maker 0.02% at fee tier 0, replacing the
0.045% guess. The Unwind and Liquidation drawers now price a close at the live book.

### Endpoints
- `GET /api/history/sync[?start=true][&full=true]` — starts a sync when idle, returns
  progress, the store's file/byte counts and the cursors
- `GET /api/performance[?days=N]` — 28 sections: round trips, behaviour split, equity curve,
  calendar, per-symbol, per-hold-time/day/hour/side/month, streaks, sequence effect, size
  distribution, execution, records, fees and funding per symbol
- `GET /api/trips[?days=N]` — every closed round trip with its context and its `entry` capture (below), plus coverage
- `GET /api/hedgeledger` — locked PnL per pair, residual exposure, carry per day, margin
  inflation under a pump

### Journal tab (7th) — seven sections
Sub-tabs (`jrTab`): **Overview · Performance · Behaviour · Timing · Symbols · Costs · Trades**.

**Overview is the account, not the closed trades.** Round-trip statistics alone mislead while
a large position is still open: the closed-trip net (plus the orphan fills) can be a fraction
of the unrealised loss the account carries on top of it. The front page reconciles the whole thing —

```
wallet at the start of the window   (derived from the ledger)
+ deposits and withdrawals
+ realised PnL
− fees
− funding
= wallet now
+ open positions, unrealised
= account value
```

— then lists what is open, the locked hedge portion, and activity totals. The starting wallet
is derived as `wallet − Σledger`, so it is exact only for the window income covers.
`jrLockedFromPositions()` computes the hedge lock from the dashboard poll, with no extra
request.

`history-store.js` exports the filesystem primitives the sync is built from:
`readNdjson` / `appendNdjson(file, rows, keyOf)` (dedupes on the caller's key, so a re-run
adds nothing), `readJson` / `writeJson` for the cursor file, `tradesFile(dir, symbol)` which
strips path characters so a malformed symbol cannot escape `data/`, `ensureDir`, and
`storeStats(dir)` for the file, byte and symbol counts the sync endpoint reports.

| section | contents |
|---|---|
| Overview | account value, the reconciliation above, open positions, activity |
| Performance | hero stats, cumulative curve + underwater panel + daily bars, month by month, records |
| Behaviour | added-while-underwater split, hold-time buckets, long vs short, streaks, size after a win vs a loss, size distribution |
| Timing | calendar heatmap, day of week, hour of day |
| Symbols | full per-symbol table with concentration |
| Costs | maker/taker split, fees by symbol, funding by symbol |
| Trades | one sortable, filterable table of every round trip, with CSV export — see *Trades* below |

**Two stacked panels, never two y-axes.** Daily results are bars whose *direction* encodes
sign: the project's green/red pair measures ΔE 3.2 under deuteranopia, far below the ΔE 8 at
which colour may carry meaning alone, so geometry does the work and colour only reinforces
it. `jrDivergingBars` applies the same rule everywhere — bars grow left or right from a
centre line, and **every bucket shows its trip count**, with fewer than 10 dimmed and marked
⚠. A five-figure number from two trades is noise, and the count is what says so.

`jrSym()` keeps the quote on non-USDT pairs: stripping both collapsed `BTCUSDT` and
`BTCUSDC` into a single label that then appeared twice in the costs list.

### Overview: periods and the two curves
- **Today / This week / This month** use the reader's clock (`?tz=` minutes ahead of UTC, from
  the browser; weeks start Monday). *Realised* is net of fees and funding from the Binance
  ledger — exact; Hyperliquid has no history. *Account* is the change in account value across
  both venues, net of transfers, from equity snapshots; when snapshots began after the
  period started it says *since …*.
- **Wallet** is rebuilt backwards from today's `walletBalance` through every dollar
  income row — exact as far back as the ledger reaches (three months). **Account value** is
  the snapshots (`lib/equity-snapshots.js`, every 15 minutes while the server runs, one row
  per interval). The gap between the lines is the open positions. One dollar axis, the
  account line solid and the wallet dashed, both labelled.
- **Fixed:** Overview read `bn.equity` as the wallet and added unrealised PnL to it — but
  equity has been the margin balance (wallet + unrealised) since 2026-09-29, so account value
  counted open positions twice. `/api/dashboard` now sends `walletBalance`; a route test pins
  wallet + unrealised = margin balance.

### Behaviour: what each habit cost
`habits.js` holds one `HABITS` table; each habit is a trip predicate and a comparison group:

| Habit | Against |
|---|---|
| Added while underwater | trips that never added at a worse price than their own average |
| Bigger after a loss (opened > 1.5× median size right after a losing trip) | other trips opened right after a loss |
| Winner turned loser (MFE ≥ 1%, closed at a loss) | other losing trips with a price path |
| Held losers longer (past the median winner's hold) | losers closed within it |

The cost is an **estimate** — (average net with the habit − average net of the comparison)
× trips with the habit — using net after funding where known. Either side under 10 trips is
dimmed and marked ⚠.

### Trades: every round trip with its context
One row per closed trip, built in three layers so each can be tested alone:

| Layer | Fields | Where |
|---|---|---|
| From fills, exact | side, opened and peak notional, adds (and adds while underwater), partial closes, avg entry and exit, realised, fees, hold time | `buildRoundTrips` in `trade-analytics.js` |
| From the ledger and other trips | funding, net after funding, session, hedged at entry | `trip-context.js` (pure) |
| From candles, cached | MAE / MFE, ATR % at entry, BTC trend at entry | `trip-context.js` maths, fetched by `lib/trip-enrichment.js` |

- **Sessions** follow each market's own clock, daylight saving included — Asia, Europe,
  Europe + US, US, Off-hours (`docs/sessions.md`). A trip's session is where it opened.
- **Hedged at entry** means the same symbol's opposite hedge-mode leg was already open at the
  trip's first fill; the leg opened second is the hedge.
- **MAE / MFE** are the worst and best move against the *average* entry while held, in
  percent, from the finest kline interval that covers the trip in one request of 1,500 bars
  (1m up to 25h, then 5m, 15m, 1h, 4h). Most trips are short — the median is about 3h — so a
  fixed 1h bar would have read nothing for a third of them. The first bar can include a few
  minutes before the entry fill.
- **ATR %** is ATR(14) of the 20 1h bars before entry; **BTC trend** is BTC's 1h EMA50 against
  EMA200 on bars closed before entry, `flat` within 0.5%.

**Funding: a hedged pair settles as one net row.** Binance books a settlement against the
symbol, not the leg: only a handful of thousands of funding rows came as two rows. With one leg open the row
is that trip's exactly. With both open it is split by each leg's size at that moment × the
historical funding rate × that settlement's mark, and the residual is shared equally, so
the parts always sum to the row (verified on the live ledger: attributed − ledger =
2.7e-12). Split trips show `≈`. A trip that opened before the income ledger starts — Binance
keeps three months — has unknown funding, and its Net is shown before funding with `*`.

**Fetched during a sync, never on a request.** After fills, the sync's `context` phase fetches
candles for each trip without a cached row and funding-rate history for symbols with hedged
settlements, through the weight throttle. Only the computed values are kept, one row per
trip in `data/trip-context.ndjson` tagged with `CONTEXT_VERSION`; bumping it recomputes every
row, so a formula fix never leaves old numbers on screen. A symbol Binance no longer lists is
recorded as unavailable instead of retried. The first run on a few hundred trips took a few
minutes; a routine sync fetches only new trips.

**The table** (`public/js/journal-trades.js`) is driven by one `TRADE_COLUMNS` list — label,
sort value, cell and CSV fields per column. Default columns stay compact; *More columns*
adds ATR, BTC, entry → exit, realised, fees, funding, the context at entry (equity and
margin, leverage, Confluence, stop vs suggested), fills and maker %. Every `—` says why
on hover. *Export CSV* writes every column for the rows the filters match. Journal
registers `#jr-mounted`, so the 15s poll no longer rebuilds it under a filter being typed.

### Context at entry: captured live, never rebuilt
Some facts about a trade exist only at the moment it is placed. On every **increasing fill**
the order stream reports (`BUY` on `LONG`, `SELL` on `SHORT`, any non-reduce-only fill in
one-way mode) `lib/entry-context.js` records, once per order:

| Field | Source |
|---|---|
| equity, margin %, free margin, leverage setting | shared account snapshot (≤ 60s old); leverage from `positionRisk`, which lists every symbol |
| Confluence at entry: overall score, state, aligned, score per timeframe | `readConfluence()` — the same code as the Confluence tab |
| suggested stop: price, distance, regime (risk 1%, k 1.5, the Stops tab defaults) | `suggestStop()` — the same code as the Stops tab |
| your stop, read 5 minutes after the fill, and its distance as a multiple of the suggestion | nearest closing `Stop…` order on that leg, regular or algo |

Rows go to `data/entry-context.ndjson` keyed by **orderId**: an `entry` row at once and a
`stop` row five minutes later, so a restart in between loses only the stop. Trips record
their opening `orderId`, so the join is exact. Adds are captured too, for later analysis.
A part that fails is null and named in `errors`.

**Only while the server runs, and only with Binance on.** It rides the live stream; a trade
placed while the dashboard is stopped has no context, and the Trades table says so on hover.
Run it as a service (`docs/operations.md`, *Deployment notes*) to capture every trade.

### Hedge ledger drawer
Last slot in the sidebar icon block. Leads with the number that reframes the book: a matched
hedge pins its PnL at `(entryShort − entryLong) × matchedQty` — the price terms cancel, so
**most of the book's PnL is already decided**, and only about 2% of gross notional is still exposed.
`lockedPnl()` asserts the invariant by comparing against the pair's live uPnL and the panel
shows the check. Carry uses the observed funding cadence and marks any symbol where observed
and declared disagree.

### Margin inflation — a hedge is delta-neutral, not margin-neutral
`marginUnderMove(pool, prices, moves, opts)` sweeps every mark together and reports the pool
and per-leg requirement at each step. The mechanic it exists to expose:

> Margin is charged on **notional**, and notional is quantity × **price**. A matched pair's
> PnL is pinned at `(E_short − E_long) × qty` and cannot move — but both legs' margin scales
> with price. Three times the price, three times the margin, for a position whose profit and
> loss is frozen.

Measured on the live book: across a +200% move equity barely changes (the book is
near delta-neutral) while the margin requirement goes **1× → 3×** and free margin falls from
its current level to **zero at +190.8%** — with liquidation not reachable inside +300%. In a pump the
binding constraint is running out of usable margin, not getting liquidated, and the two
thresholds are hundreds of percent apart. Bracket tiers make it worse than linear once
combined notional crosses a boundary.

**Does the losing leg eat margin on its own?** Asked directly, and tested against the live
account rather than reasoned about. Two competing formulas for `availableBalance`:

```
A. wallet + (gains + losses) − IM   →  matches to about a dollar            ← matches
B. wallet + losses only     − IM   →  negative, off by the full offset
```

Formula A wins by the whole unrealised offset, and `marginBalance = wallet + netUpnl` matches to the cent. **In
cross margin the winning leg's unrealised profit offsets the losing leg's loss exactly**, and
margin is `|qty| × price × rate` with PnL not an input at all — a losing leg is charged no
more than a winning one of the same size. Measured at +200% on the live book: individual legs
swing by six figures while the net moves by a small fraction of that, and margin trebles on *both* legs.

The offset holds only while both legs are open. Close the winner and the loser stands alone —
which is exactly what the liquidation-after-close drawer shows when a hedge leg is shut. In
isolated margin there is no offset at all, but this account holds no isolated positions.

Rendered in the hedge ledger drawer as a bar per step, the per-leg swing table, and both
thresholds. Tested as a
property: a synthetic zero-delta pair must hold its PnL to within 1e-6 at every price while
`imGrowth` comes out at exactly 2× and 3×, and per-leg IM and MM must sum to the pool totals.
