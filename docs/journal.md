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
A routine resync pulls fills only for symbols the ledger shows trading after their fills were
last pulled (`meta.tradesSyncedAt`), plus anything open (~10s); `?full=true` forces all of them.
**Fixed:** the rule used to be "traded in the last 7 days", so a symbol closed out more than a
week before the next sync kept its fills missing; the Costs ledger checks found it.

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
- **Orphan fills are excluded, and counted.** A hedge-mode leg never changes sign, so a fill
  that takes one past zero closes a position opened before the earliest reachable fill. With
  nothing visible open it is a lone orphan fill; after visible adds to a position opened before
  history, the whole in-flight trip goes with it, since its entry, size and open time are
  unknowable. Either way it lands in `orphans`, the leg restarts at zero, and the Journal footer
  states how large that bucket is. Until 2026-10 only the first case was caught: the second
  left the leg negative for good, and every later trade on it merged into one trip that never
  closed.
- **Rebuilt open legs are checked against Binance.** Each sync records the open legs Binance
  reports (`meta.openLegsAtSync`); `openLegMismatches` compares them with the legs the fills
  leave open, and the Journal names any that differ. Both sides are as of the sync, so a trade
  since then is not a false alarm. A mismatch means fills are missing or misread.
- **A lone visible leg of a hedged settlement takes its own row.** When the other leg is
  outside the history, the settlement still books two rows; the visible leg takes the one
  nearest its modelled amount (rate × size × mark), or its funding is unknown without a rate.
- **Funding on a position opened before history is placed, not lost.** Every orphan fill
  proves a position opened before history was still open at that moment, so funding on that
  symbol up to its last orphan fill (`preHistoryUntil`) belongs to it; the ledger's funding
  check does not count it as unmatched.

Statistics over those trips: `summarise(trips)` (wins, losses, net, payoff, expectancy, fees,
funding, median hold — on net after fees and funding). Per symbol, weekday, hour and calendar
day they are `breakdowns.js`; costs and the wallet ledger are `costs.js` (*Timing, Symbols and
Costs* below). From the income ledger: `dailyIncomeNet(income, tz)`, the net per local day.

Breakdowns for the journal sections: `byDayOfWeek` / `byHourOfDay` / `byHoldTime` / `bySide`
/ `byMonth`, each bucket carrying its trip count and a `thin` flag below 10 trips, days and
months in the reader's timezone; `makerTaker`; and `calendar(days)`, which lays Monday-first
weeks and leaves an untraded day `null` rather than zero so "no trading" never reads as "flat".

**One definition each** lives in `habits.js` and every tab uses it: `netOf` (net after fees and
funding), `resultOf` (win, loss, or flat within a cent), `previousTrips` (the last trip closed
*before* this one opened, judged on every trip before any session or window filter),
`medianSizesBefore` (usual size from earlier trips only) and `hedgeUnits` (same-symbol legs
that overlap in time count as one unit).

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
- `POST /api/history/sync` with `{ "full": true }` or `{}` — starts a sync when idle; JSON only,
  so no other site can start one
- `GET /api/history/sync` — progress, the store's file/byte counts and the cursors
- `GET /api/performance[?days=N&tz=M&session=S]` — trip and unit statistics, the window before,
  the account series with return, drawdown and ratios, streaks, records, habits, sizing,
  breakdowns, calendar, costs, periods and curves (`api.md`)
- `GET /api/trips[?days=N]` — every closed round trip with its context and its `entry` capture (below), plus coverage
- `GET /api/hedgeledger` — locked PnL per pair, residual exposure, carry per day, margin
  inflation under a pump

### Journal tab (7th) — nine sections
Sub-tabs (`jrTab`): **Overview · Goals · Performance · Behaviour · Factors · Timing · Symbols · Costs · Trades**.

**Overview answers "am I on track, and does anything need me?"** — the layout and its sources
are in [`research/overview.md`](research/overview.md). Top to bottom (`journal-overview.js`):

1. **Attention** — at most three items, ranked: a goal broken today, a milestone missed or a
   drawdown limit broken, a milestone late, funding paid far off the estimate, a factor that
   stands out. Each links to its tab; with none, one muted line says *nothing needs attention*.
   The ranking is the `ATTENTION_SOURCES` list, one entry per source.
2. **Today / This week / This month** — net with n and wins, each against the previous period
   *by now* (yesterday to this hour, last week to this weekday and hour), and the account
   change when snapshots cover it.
3. **Account** — value, wallet, open and hedges locked in one line, the two-curve chart, and a
   link to *How the wallet got here*.
4. **Next milestone** — the lowest account target not reached, missed or paused — beside the
   **last five closed trades** with their tags, each opening Trades on that symbol and day.
5. A footer with trips, trading days, the span and the last sync.

Open positions and account stats stay on the main view and sidebar; they are not repeated.

**How the wallet got here** sits at the top of **Costs** — see *Costs* below.
`jrLockedFromPositions()` computes the hedge lock from the dashboard poll, with no extra
request.

`history-store.js` exports the filesystem primitives the sync is built from:
`readNdjson` / `appendNdjson(file, rows, keyOf)` (dedupes on the caller's key, so a re-run
adds nothing), `readJson` / `writeJson` for the cursor file, `tradesFile(dir, symbol)` which
strips path characters so a malformed symbol cannot escape `data/`, `ensureDir`, and
`storeStats(dir)` for the file, byte and symbol counts the sync endpoint reports.

| section | contents |
|---|---|
| Overview | attention, the periods against the last ones by now, the account and its chart, the next milestone, recent trades |
| Goals | rules you set, scored from the day you set them — see [`goals.md`](goals.md) |
| Performance | return, drawdown, win rate, expectancy, payoff, Sharpe against the window before; the account by day with its underwater strip; months, hold time, side; records; streaks against chance — see *Performance* below |
| Behaviour | each habit: how often, its 8-week trend, against the window before, its cost or why it cannot be told yet, a rule to set; position size at open — see *Behaviour* below |
| Factors | which conditions at entry go with better or worse trips — see *Factors* below |
| Timing | calendar of days, weekday and hour opened with shrunk averages, a weekday × hour count grid — see *Timing* below |
| Symbols | best and worst symbols with the rest folded, shrunk averages, costs, concentration, a way into each symbol's trades — see *Symbols* below |
| Costs | the wallet ledger and its checks, costs in basis points against the window before, the fee check, costs by week and by symbol — see *Costs* below |
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
  ledger — exact; Hyperliquid has no history. Each carries `previous`, the same span one period
  back cut at the same elapsed time (`previousPeriodStarts`, `periodNetBetween`); a previous
  month shorter than the elapsed time ends at its own end. *Account* is the change in account
  value across both venues, net of transfers, from equity snapshots, marked *partial* when
  snapshots began after the period started. Switching a venue on or off counts as a transfer
  of its equity (`venueSwitches`), here and in the return, drawdown and milestones, so turning
  Hyperliquid off is not a loss. Hyperliquid's own deposits and withdrawals are still invisible.
  A trip's win or loss is `resultOf(netOf)` everywhere, period counts included, so a trip that
  funding turned into a loss is not counted a win.
- **Wallet** is rebuilt backwards from today's `walletBalance` through every dollar
  income row — exact as far back as the ledger reaches (three months). **Account value** is
  the snapshots (`lib/equity-snapshots.js`, every 15 minutes while the server runs, one row
  per interval). The gap between the lines is the open positions. One dollar axis, the
  account line solid and the wallet dashed, both labelled.
- **Fixed:** Overview read `bn.equity` as the wallet and added unrealised PnL to it — but
  equity has been the margin balance (wallet + unrealised) since 2026-09-29, so account value
  counted open positions twice. `/api/dashboard` now sends `walletBalance`; a route test pins
  wallet + unrealised = margin balance.

### Performance: how the account did
`performance.js`; the method and its sources are in
[`research/performance-behaviour.md`](research/performance-behaviour.md).

- **The daily series** is the wallet rebuilt from the ledger before the first equity snapshot,
  and account value after it, one value per local day. Transfers are flows, never gains.
- **Return** is time-weighted: daily Modified Dietz returns, each transfer weighted by the part
  of the day it was held, chain-linked. A day with no value, and the day the series hands over
  from wallet to account, has a null return rather than a zero.
- **Drawdown** is the deepest fall from a peak of that return index, in percent, with when it
  began, how long it lasted and whether it recovered. A fall that touches the wallet segment
  leaves out open losses, so it reads *at least* that deep. Beside it: the fall a book with no
  edge and the same daily volatility would expect over the window, √(π/2)·σ·√T.
- **Sharpe and Sortino** wait for 60 daily returns. Sharpe carries its standard error and the
  chance the true Sharpe is above zero, both corrected for skew and fat tails; Sortino a 90%
  bootstrap interval. **Beta and correlation to BTC** wait for 60 paired days.
- **Win rate, payoff and expectancy count hedge units**, so a long and short opened together are
  one decision. Win rate carries a Wilson interval, expectancy a day-clustered bootstrap one;
  profit factor waits for 30 units. R is shown only on trips that had a stop, as "k of n".
- **Streaks** are judged against the same results shuffled 2,000 times: a run is flagged only
  when chance reaches it under 5% of the time.
- **With a session picked**, the curve is those trips' net by local day in dollars; return,
  drawdown %, Sharpe and beta are the whole account's and wait.
- 7d, 30d and 90d compare with the same span just before it; *all* has nothing to compare.

### Behaviour: habits
`habits.js` holds one `HABITS` table. A habit that changes how a trip ran is costed by
**replaying** the trip without it; one that changes which trips happen is **compared** with its
nearest alternative; one defined by the trip's own result is **counted only**, since costing it
would be circular.

| Habit | Measured as |
|---|---|
| Added to a losing position | replay: the opening lot closed at the trip's average exit, fees and funding scaled by its share of quantity entered (est.) |
| Opened bigger right after a loss (> 1.5× the median of earlier trips) | replay at that median size |
| Re-entered within 30 min of a loss | against re-entries within 30 min of a win — loss-chasing apart from simply re-entering fast |
| Traded on your busiest days (top third by trips a day) | against trips on the quietest third |
| Let a winner turn into a loss (up 1% or more, closed at a loss) | share of losers with a price path; trips awaiting context are counted |
| Held losers longer than winners | median hold of losers ÷ winners |

Each cost carries a 90% day-clustered interval (the wider of bootstrap and Welch for a
comparison). The verdict is *costs* or *helps* when the interval clears zero, *can't tell yet*
when it spans it, and *thin* under 10 trips a side. Each habit also reports its share against
the window before, its share week by week for 8 weeks, and the goal that rules it out. A habit
that *costs* joins Overview's attention list after the factors.

### Timing, Symbols and Costs: facts and estimates
`breakdowns.js` and `costs.js`; the method and its sources are in
[`research/timing-symbols-costs.md`](research/timing-symbols-costs.md). **A total is a fact** and is
shown at any size with its count. **An average is an estimate**: it is pulled toward the book's
average in proportion to how few trades it rests on (`stats.shrunkMeans`, one-way random effects
after Efron & Morris), carries a 90% range, and appears only from 8 hedge units. Under each chart a
line says how many buckets are shown, how many would stand clear of the average by chance alone,
and how many do. All three tabs follow the window and the session, except the wallet ledger, and
say so under a session.

**Time zone.** The browser sends its zone name (`zone=Europe/Madrid`) beside its offset;
`local-time.js` converts each timestamp at the offset in force at that moment, so trades either
side of a daylight-saving change land on the right day and hour on every Journal tab. An unknown
zone falls back to the offset.

**Timing.**
- **Calendar:** net by the day it landed (the ledger; trips by close day under a session). Blue is a
  gain, orange a loss, three steps each, checked for colour blindness; a flat day and a day without
  trading are drawn apart. Every day is a button with its net and trades closed in its label, and
  opens Trades for that close day. Week totals are in each column's title; month totals and the
  best and worst week sit below.
- **Weekday and hour** are by the local time a position *opened*, as in Factors.
- **When you open positions:** a weekday × hour grid of counts only, in one hue.

**Symbols.** Sorted by total net; the best and worst five show, with the rest folded into one row
and "Show all". Columns: units (with legs when hedged), net, adjusted average with its range, win
rate on units, fees in basis points of notional traded, funding per hour held; every column sorts.
A symbol opens Trades filtered to exactly that symbol. **Concentration:** the top three symbols'
share of gross |net|, and "effectively N symbols" — the inverse of the Herfindahl index of notional.

**Costs.**
- **Headline:** fees and funding in basis points of notional traded, funding paid and received apart,
  maker share **by notional** with its 8-week trend, each against the window before. **Fee drag**
  (costs ÷ gross realised) appears only when gross is at least twice the costs.
- **Fee check:** the rate paid against the one your own maker and taker rates
  (`/fapi/v1/commissionRate`, the largest symbols covering 80% of notional, at most 5) imply for
  your maker share, whether the BNB discount is on (`/fapi/v1/feeBurn`), and BNB-paid fees priced at
  that day's BNB close. BNB fees never enter dollar totals.
- **Slippage is not measured:** it needs the price when each order was sent, which history lacks.
- **Costs by week** (fees and funding paid down, received up) and **by symbol** (fees, funding paid
  and funding received, each the top ten plus "others").
- **How the wallet got here:** from the ledger, dollar assets only — the wallet at the start,
  transfers, realised, fees, funding, every other income type by name, the wallet the last sync saw
  (`meta.walletAtSync`), and what moved since. **Checks:** the start against an equity snapshot
  when one is that old; ledger realised and fees against the fills; funding payments no rebuilt
  position explains. Each says *matches* or by how much it is off.

### Factors: what goes with better or worse trips

`outcome-factors.js` splits trips by conditions **known at entry** — session, weekday or
weekend, hour, side, hedged, size against the median of *earlier* trips, the previous trip
(closed before this one opened), BTC & ETH or alts, BTC trend, ATR terciles, and from captured
entries confluence, leverage, margin used and a stop within 5 minutes — and compares each
bucket with the rest of the book. The method and every threshold come from
[`research/outcome-factors.md`](research/outcome-factors.md):

- **Average net per trip** is the headline (it sums to the account); the median sits beside it
  and the row is marked *≠ median* when the two disagree in sign.
- **Intervals are 90% and count days, not trips:** a bootstrap that resamples whole UTC days
  (seeded, so a page shows the same numbers on every load) next to a Welch interval, the wider
  one shown; win rate uses Wilson.
- **Hidden** under 20 trips or 8 days on either side, **dimmed** under 40.
- **Stands out** only when the interval clears zero *and* the row passes Benjamini–Hochberg at
  q = 0.10 across every comparison shown. The tab prints the count and says *exploratory,
  association not cause*.
- **⚑** when the sign flips within size buckets or within hedged / unhedged trips;
  **holds / fades / thin** compare the early 70% of trips with the recent 30%, tercile cut
  points taken from the early window only.
- **During the trade** — adds while underwater, hold time — is shown apart and never ranked:
  it is part of the outcome, not something known when the trip opened.

`GET /api/factors` caches per window, session, trip count and enrichment version, so the poll
never recomputes and new context, funding or notes are picked up at once. The previous trip and
the usual size are worked out on every trip and only then filtered; until 2026-10 Factors worked
them out on the filtered trips, so under a session filter a trip right after a loss in another
session read as the first of its day. Each bootstrap draw sums per-day totals rather than
re-filtering every trip, so a full Factors build is several times faster.

### Notes and tags

Your own note (up to 500 characters) and up to five tags on any closed trip, edited inline in
Trades (✎ or the empty Notes cell). Kept in `data/annotations.json` by the trip key, with the
opening order id as a fallback so a note survives a rebuild that moves a trip's start; saving
or clearing a note found that way rewrites that entry under the current key, so nothing is left
behind. Notes that match no trip are counted under the table. `enrichedTrips()` attaches them, so Trades
(column, tag filter, CSV), Goals (breach rows) and Factors read them with no extra request.
Tags are free, lowercased slugs with autocomplete from the ones already used. In Factors they
sit in their own section and never reach the verdict: a tag is written after the result is
known, so its link to outcome is partly hindsight.

### Trades: every round trip with its context
One row per closed trip, built in three layers so each can be tested alone:

| Layer | Fields | Where |
|---|---|---|
| From fills, exact | side, opened and peak notional, adds (and adds while underwater), partial closes, avg entry and exit, realised, fees, hold time | `buildRoundTrips` in `trade-analytics.js` |
| From the ledger and other trips | funding, net after funding, session, hedged at entry | `trip-context.js` (pure) |
| From candles, cached | MAE / MFE, ATR % at entry, BTC trend at entry | `trip-context.js` maths, fetched by `lib/trip-enrichment.js` |

- **Sessions** follow each market's own clock, daylight saving included — Asia, Europe,
  Europe + US, US, Off-hours, Weekend (`docs/sessions.md`). A trip's session is where it opened.
- **Hedged at entry** means the same symbol's opposite hedge-mode leg was already open at the
  trip's first fill; the leg opened second is the hedge.
- **MAE / MFE** are the worst and best move against the *average* entry while held, in
  percent, from the finest kline interval that covers the trip in one request of 1,500 bars
  (1m up to 25h, then 5m, 15m, 1h, 4h). Most trips are short — the median is about 3h — so a
  fixed 1h bar would have read nothing for a third of them. The first bar can include a few
  minutes before the entry fill.
- **ATR %** is ATR(14) of the 20 1h bars before entry; **BTC trend** is BTC's 1h EMA50 against
  EMA200 on bars closed before entry, `flat` within 0.5%.

**Funding: one row per leg, both under one tranId.** Binance books a hedged settlement as two
`FUNDING_FEE` rows — the paying leg's and the receiving leg's — with the same `tranId`, time
and symbol. Each row is matched to the leg whose size × rate × mark it is closest to, so every
trip gets its own leg's funding exactly. With one leg open the rows are that trip's. Rates are
matched within a minute, since income lands a few milliseconds after the rate's own time;
matching to the millisecond had left about half of them "missing" and re-requested on every
sync. Requests page in 1000-row chunks, so a long hourly hedge gets every rate. When the
trip rebuild thinks two legs were open but the ledger has one row, the ledger wins: the other
leg paid nothing.

**Fixed (2026-10-03): every hedged receipt had been dropped.** The income cache deduped on
`tranId:type:symbol:time`, which both legs share, so the second row — usually the receipt —
never reached the cache. Realised funding then counted only the paying side of each hedge
(a week read many times worse than Binance's own ledger), and the code above was written to split that
lone row across both legs, believing Binance netted them. The key now includes the amount, and
a cache written under the old key refetches Binance's three-month window once, on the next
sync, recording `incomeCompleteFrom` in `meta.json`. Hedged settlements cached before that
date cannot be recovered: their trips show funding as unknown (`*`, *missing a leg's row*), never
a guess. With no funding rate on record to tell the legs apart, a settlement is shared evenly
and the trips show `≈`. A trip that opened before the income ledger starts has unknown funding
too, and its Net is shown before funding with `*`.

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
