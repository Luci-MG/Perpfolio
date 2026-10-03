# Changelog

## Unwind: one tool, priced at the book (2026-10-04)

- **One place to unwind**: Tools → Unwind has **Plan** and **Build** over one readout. The
  Liquidation-after-close and Unwind-simulator drawers are gone; their selection, presets,
  live-book cost, exposure, Binance-matched liquidation table and "then the market moves" live
  in the readout. **Edit this plan** loads the plan's closes into Build.
- **The planner prices at the book**: steps are ranked by gain per dollar of exit cost, walked on
  the live depth with each symbol's own taker rate; a close the book cannot fill is a last
  resort; the last step is cut to the size that lands on the target instead of closing a whole
  hedge.
- **Cross-coin hedges are guarded**: a close that raises BTC-beta exposure is refused like one
  that breaks a same-symbol hedge, and the tolerance is half a percent of gross notional
  instead of one dollar.
- **New objective**: every liquidation price at least N% from the mark.
- **One liquidation figure**: Unwind uses the solve that matches Binance's published price;
  Stress keeps the live engine's reading. "Then the market moves" can move coins by beta.
- `/api/deleverage` is removed: the page computes the plan from `/api/riskbook` with the same
  engine, so inputs recompute at once without a request.

## Guardrails, exchange hygiene and docs, batch 5 of the 2026-10-03 review (2026-10-03)

- **The rules have checks**: `npm run check` now fails on an `await` inside a loop over the
  book, a value passed to an inline handler in quotes, exchange text reaching the page without
  `esc()`, a request value used as an object key without `Object.hasOwn`, equity read from the
  wallet, funding multiplied by 3 anywhere, and a docs map or script order that no longer
  matches the code. Each would have caught a bug this review found.
- **The exchange client is harder to trip**: signed calls carry a receive window and Binance's
  own time; errors say what Binance said; a 403 pauses calls like a 429; the listenKey
  keep-alive goes through the ban guard; an old weight reading lapses; a failed commission
  rate is not cached; concurrent cold table reads share one request.
- **Tests guard the rules too**: shared reads across tabs, cache-only-success, the
  bracket-table fallback, the Hyperliquid 429 backoff and the synthetic candle series. The
  golden snapshot now fails when missing under CI or when a route is added without it, and
  compares floats to ten digits.
- **Docs match the code**: the architecture map and script order, the funding rule in
  CLAUDE.md, the API's payload fields and parameters, and Node 20 as the minimum.
- About 35 exports used only inside their own module are private now; an unused entry gate and
  VWAP wrapper are gone. `npm run check` runs its syntax pass in parallel.

## Frontend, batch 4 of the 2026-10-03 review (2026-10-03)

- **Exchange text is always text**: every symbol, pair, order type and warning reaching the
  page is escaped, and values passed to buttons go through `jsArg`, so a quote can no longer
  break out of a handler.
- **A minus is a minus everywhere**: one set of sign helpers replaces a dozen local ones;
  uPnL, ROI, the scatter axis, betas, correlations and stress and unwind percentages now
  carry `−`, and the server no longer sends a preformatted funding string.
- **A tile hands over the whole position**: the calculator opened from a tile knows the leg
  and its account-aware liquidation, and the drag-to-hedge popup counts 1h and 4h funding.
- **No stale or lost screens**: a slower response no longer overwrites a newer one; a venue
  switch during a poll is applied straight after it; a note being typed or a tile being
  dragged is not rebuilt away; the Journal fetches and rebuilds only what the open tab shows.
- **Small reads fixed**: Stops after a filtered venue goes off, Margin health for a venue
  that is off, the Overview account line live with its time, the colour of locked hedges, a
  tag filter whose tag is gone, tiny order prices, cost bars with their counts, and the
  Journal window remembered.
- Dark mode reaches the margin gauges and the scatter; about 40 unused CSS classes, an unused
  scenario helper, an unreachable tile branch and a calculator field that never showed are gone.

## Funding, journal and goals, batch 3 of the 2026-10-03 review (2026-10-03)

- **The funding warning compares like with like**: realised Binance funding against the Binance
  estimate, over the week to the last sync, and "sync to compare" when the ledger is too short.
  A Hyperliquid leg the ledger never sees no longer sets it off. Hyperliquid's cap reads 4%/h.
- **Stops judge funding per 8 hours on every symbol**, so 1h and 4h symbols and Hyperliquid
  are no longer read as calm; the portfolio regime weighs today and its history the same way.
- **Funding intervals catch up at once**: a next settlement off the declared interval's hours
  shows the symbol has moved to a shorter one, minutes after a cap hit.
- **Factors judge the previous trip and usual size on every trip**, so a session filter no
  longer makes each trip the first of its day; new context and notes reach Factors at once,
  and a full build is several times faster.
- **Switching a venue on or off is a transfer**, not a loss or gain, in returns, drawdown,
  period change and milestones.
- **Notes edit in place** when found by opening order, leaving nothing behind.
- **Funding rates match within a minute and page past 1000 rows**, so a sync stops
  re-requesting most of them.
- **Milestones read "reached late"** when the target came after its date; a goal's date must
  be a real one, ahead on your own clock; loss caps skip trips older than the wallet curve.
- One definition of a win everywhere, `meta.json` written whole, the wallet stamped when it was
  read, half-hour and midnight daylight-saving zones handled, and a ledger past the call stack's
  limit still builds.

## Risk maths, batch 2 of the 2026-10-03 review (2026-10-03)

- **Stress rows agree with the pool header when stops are honoured**: each asset's kill price
  now starts from the book with the other assets' crossed stops already fired.
- **Per-side margin tiers reach the frozen reading**: when calibration picks per-side tiers,
  the frozen kill price, its "exch" note and the tier-crossing flag now tier each leg on its
  own, as the live engine and the closed form already did.
- **The drawers see every pool**: the liquidation, simulator and hedge-ledger drawers switch
  between USDT and USDC pools, open on the one nearest a kill price, and say how old the book
  is. Dragging a % slider no longer rebuilds the drawer under the pointer.
- **Costs and caps read as entered**: a 0 fee is 0, a 0 risk is floored at 0.1% rather than
  read as 1%, a fill better than the mark lowers the cost, and a blocked plan names the cap
  that would let it continue, fees included. The Unwind fee defaults to your account's taker
  rate, and a slow response can no longer overwrite a newer plan.
- **Linked moves stay sane**: an asset with |β| under 0.2 moves alone instead of driving the
  rest past −100%, and no shift goes below −99%.
- **One asset without a mark no longer fails the risk book**; it gets an empty row.
- Each Stress row shows how far its kill price is from Binance's published one.
- A Stress frame is about three times faster (brackets are sorted once, not on every lookup),
  and the risk book fetches depth and fees in parallel and scans each asset once fewer times.
  The unused lot filters and `roundToStep` are gone.

## Correctness fixes, batch 1 of the 2026-10-03 review (2026-10-03)

- **Trades no longer vanish from the Journal.** A hedge leg opened before the earliest
  reachable fill, added to and then closed went negative and swallowed every later trade on
  that leg into one trip that never closed. The whole trip now goes to the opened-before-history
  bucket and the leg starts afresh. A new check compares the open legs the fills leave with
  Binance's at each sync and names any that differ.
- **One venue down no longer blanks the other.** A failed Hyperliquid read used to fail the
  whole dashboard; now the healthy venue stays on screen, the failed one reads "unavailable"
  and a banner says the totals leave it out.
- **Stops are never "missing" when they could not be read.** A failed stop-order read showed
  every leg as unprotected and was cached; it now shows a grey "?" shield and "stop unknown" on
  the Stops tab, and is read again next time. A failed mark-price read fails the Binance read
  instead of pricing collateral at $1 and funding at 0.
- **Open orders are read even when the order stream never opens**, and health warns when they
  have not been read for 3 minutes.
- **Only this machine can reach the server by default:** it listens on loopback and refuses
  other Host names (`HOST`, `ALLOWED_HOSTS` to open it), and a sync starts only from a JSON POST.
- **Goals are safe from bad input:** an action named like a built-in (`toString`) is refused
  instead of wiping every goal, an unreadable goals file is reported and never overwritten, and
  a suggestion outside its type's range is capped rather than failing the Goals tab.
- **Calculators fill sizes of $1,000 and more** — the thousands separator blanked the field.
- The Stops tab no longer retries a failed candle read one position at a time.

## Journal Timing, Symbols and Costs remodel (2026-10-03)

- **Timing** opens with a calendar you can read without colour vision: blue gains, orange losses,
  flat and untraded days apart, every day a button that opens its trades, with week and month
  totals. Weekday and hour are by the time a position opened, each average shrunk toward the
  book's with its range from 8 units, under a line saying how many would stand out by chance.
  A weekday × hour grid shows when you trade.
- **Symbols** shows the best and worst five by total net with the rest folded, a shrunk average,
  fees in basis points and funding per hour held, sortable, each symbol opening its trades.
  Concentration reads as the top three's share and "effectively N symbols".
- **Costs** leads with fees and funding in basis points of notional against the window before,
  funding paid and received apart, and maker share by notional with its trend. The fee rate paid
  is checked against your own rates, BNB fees are priced apart, costs run by week and by symbol
  with receipts kept, and the wallet ledger lists every income type with four checks.
- **Every Journal tab follows daylight saving**: the browser sends its time zone and each
  timestamp converts at the offset in force then.
- **Fixed:** a routine sync skipped symbols closed out more than a week before it, leaving their
  fills missing; it now pulls any symbol the ledger shows trading since its last pull. Execution
  figures ignored the window and session. A BNB fee could be added to dollar fees. Funding by
  symbol showed payers only. The "0.05% against 0.02%" note was hard-coded.

## Journal Performance and Behaviour remodel (2026-10-03)

- **Performance** leads with return, drawdown, win rate, expectancy, payoff and Sharpe, each
  against the window before. Return is time-weighted with transfers taken out; drawdown is in
  percent of the account, beside what a book with no edge would expect; Sharpe waits for 60
  daily returns and carries its error. Win rate and expectancy count a hedged pair once and
  carry intervals. Streaks are judged against chance. The chart is the account by day —
  the wallet from the ledger before equity snapshots began, account value after.
- **Behaviour** is one row per habit: how often, its 8-week trend, against the window before,
  and a cost with an interval, or "can't tell yet". Adding to a loser and sizing up after a
  loss are costed by replaying the trip; re-entering fast after a loss is compared with
  re-entering fast after a win; busy days with quiet ones. Habits picked by their own result
  are counted, not costed. Each row sets a rule in one click; a costly habit reaches Overview.
- **One definition each** of net (after fees and funding), win, loss and flat, the trip before
  (closed before this one opened), usual size (earlier trips only) and hedge unit, shared by
  every tab. A session now narrows the curve, records, costs and calendar too, and says so.
  Months, days and hours use the reader's timezone.
- **Fixed:** one-way trips grouped as "BOTH"; an empty window read "Avg loss $0.00"; the
  added-underwater split and the habit row could show different averages for the same trips;
  bar labels were not escaped. `enrichedTrips()` is memoised per input change.

## Fixed: hedged funding receipts were dropped (2026-10-03)

- Binance books both legs of a hedged funding settlement under one `tranId`; the income cache
  keyed on it and kept only the first row, usually the paying leg. Realised funding counted only
  what hedges paid, never what they received, so the Overview flagged funding paid far above
  the estimate when Binance's own ledger agreed with the estimate.
- The key now includes the amount. On the next sync a cache written under the old key refetches
  Binance's three-month window once to restore the missing rows; funding totals,
  periods, the wallet curve, Costs, the funding drawer and each trip's funding all correct.
- Trip funding no longer splits a "net" row: each leg's row is matched to it. Settlements cached
  before the window cannot be recovered and show as unknown, not guessed.

## Journal Overview remodel (2026-10-03)

- Overview now reads top to bottom: what needs attention (at most three ranked items, or
  *nothing needs attention*), today / this week / this month against the previous period by
  now, the account in one line over its chart, the next milestone beside the last five trades
  with their tags, and a one-line footer.
- Open positions, the account stat grid and the activity block are gone from Overview — the
  main view, the sidebar and Performance already show them. The wallet reconciliation moved to
  the top of Costs.
- `/api/performance` adds each period's previous span and the last five closed trips. Layout
  research with sources is in `docs/research/overview.md`.

## Funding section (2026-10-03)

- The funding drawer answers what holding the book costs: estimated net a day, realised 24h /
  7d / 30d from the ledger with a note when the two disagree, share of equity, and one table
  worst first with each hedged pair netted into one row.
- Rates are labelled as estimates and shown per each symbol's own interval with an annualised
  column, a 7-day sparkline against the symbol's average and the rate charged at the last
  settlement; a leg at half its cap or more is flagged, since it can switch to 1h settlements.
- The old "Avg rate/8h" averaged 4h and 8h rates unweighted; the book-wide figure is now the
  rate on gross notional. The bubble grid, heatmap, exchange cards and burn-down chart are gone.
- The sidebar widget adds the next settlement with a countdown and its amount, above a row
  per venue — zero with no positions, *off* when switched off.

## Notes and tags on trips (2026-10-03)

- A note and up to five tags on any closed trip, edited inline in Trades, with a Notes column,
  a tag filter and both in the CSV. Saved in `data/annotations.json`; a note follows its trip
  through a rebuild by its opening order.
- Goal breaches show the trip's tags and note; Factors compares each tag with enough trips in
  a separate *Your tags* section, marked as set after the trade.

## Error states keep their controls (2026-10-03)

- A failed load no longer replaces a tab's controls: Stress, Unwind, Stops, Confluence, the
  Journal and its Trades, Goals and Factors, and the hedge-ledger, liquidation and simulator
  drawers show the error under their controls with a **Retry**. The Journal keeps **Sync**
  usable when history fails to load.
- A failed refresh keeps the last good data and says so, instead of blanking the panel.
- Two Unwind drawer errors reached the page unescaped; `scripts/check.mjs` now fails on any
  error interpolated or concatenated into markup without `esc()`.

## What goes with better or worse trips (2026-10-03)

- A Journal **Factors** tab: each condition known at entry — session, hour, side, hedged, size
  against earlier trips, the previous trip, coin group, BTC trend, volatility, and from
  captured entries confluence, leverage, margin and stop — compared with the rest of the book
  on average net per trip and win rate, with intervals that count days rather than trips.
- Only rows whose interval clears zero and that survive a false-discovery check across every
  comparison are called out; the rest sit on the board behind *Show all factors*, with sign
  flips, thin samples and early-against-recent stability marked. A losing factor that maps
  to a goal offers *set a goal ›*.
- The method and its sources are in `docs/research/outcome-factors.md`.

## Goals: milestones (2026-10-03)

- Account-value targets, with an optional date, and a monthly drawdown limit, in their own
  block under the rules. Progress leaves deposits and withdrawals out; the pace is a
  least-squares line through daily closes, shown only after a week of snapshots, and drawn
  dashed as an extrapolation in the expanded chart.
- States: on pace, late, reached, missed and *not enough history*; the Overview line names a
  milestone only when it is late or missed.

## Goals: rules (2026-10-03)

- Eight process rules — max leverage, a stop within 5 minutes, a max loss per trade, no adding
  underwater, max size, max trades a day, a losing-streak stop, no trading in chosen sessions —
  each optionally scoped to a session, in `goals.js`'s `GOAL_TYPES`.
- Scored from the day each is set: adherence with n, streak, a 7-day strip and an 8-week
  calendar, breaches with their estimated cost; history before the set date is one line apart.
  Editing re-scores from the same date; pausing stops scoring.
- The Journal **Goals** tab, an add / edit drawer whose preview re-scores as you type, an empty
  state that suggests only goals whose breaches lost money, and a goals line on Overview.
  *open ›* on a breach filters Trades to that symbol and day.

## Goals: design agreed (2026-10-03)

- `docs/goals.md` records the goals design — process rules and milestones, scored from the
  day each is set, with honest suggestions drawn from the reader's own history — and the
  scoreboard, expanded row, drawer and empty-state designs. The build is two roadmap cards.

## Weekend session (2026-10-03)

- *Weekend* — New York's Friday close to Tokyo's Monday open — is its own session, split from
  *Off-hours*, which is now only the weekday gap after New York closes. On the live book most
  former off-hours trips were weekend and net negative; the weeknight gap was net positive.
- The clock, the session filter, Trades, habits and Confluence pick it up from `SESSIONS`; a
  smoke test keeps the browser's menu equal to that list.

## Sessions across the dashboard (2026-10-03)

- Sessions follow each market's own clock with daylight saving — Tokyo, London and New York
  hours, a *Europe + US* overlap and *Off-hours* — in `sessions.js`, shared by server and
  browser. The fixed UTC buckets they replace drifted an hour twice a year and had no overlap.
- A session clock in the main header bar: the session now, the nearest close, the next change.
- One session filter, remembered, narrows the Journal's trip statistics, habit costs and Trades
  and adds the composite's record for that session to the Confluence verdict. Overview and
  Stops say why it does not apply to them.

## Protected tiles read as safe (2026-10-03)

- Every tile and List row now says whether the leg needs attention: a green shield only when
  the stop cannot lose (at entry or locking profit), a grey shield when a stop is set but still
  risks a loss (the tooltip gives the loss if hit), an amber shield when only part of the leg
  is covered or the Stops tab judged the stop too tight or wide, the red ring when nothing
  protects it.
- What counts as a stop: stop-market, stop-limit and trailing stops on the closing side;
  reduce-only limits are take-profits. Trailing stops were silently ignored before, and a
  stop for part of a leg passed as full protection.

## Confluence: verdict and honest calibration (2026-10-03)

- A verdict card leads: lean and strength, the three signals carrying it with their records in
  the current regime, the strongest signal against, and whether the composite can be trusted —
  its record in this regime and whether it held up in the most recent 30% of bars. The full
  matrix sits behind *Show all signals*.
- Calibration records each signal per regime (tagged at each bar, against that regime's own
  up-bar share) and early against recent; history is 1,500 bars. A reading ships only the
  current regime's record per signal, so the response grew 23 → 40 KB, not 92.
- A composite that ran below chance both early and recent is called unreliable, not stable.

## Journal: Overview and Behaviour (2026-10-03)

- **Fixed:** Overview counted unrealised PnL twice — it read the margin balance as the wallet
  and added open positions on top. `walletBalance` is now sent and the identity is tested.
- Overview leads with Today / This week / This month in the reader's timezone — realised net
  from the ledger, account change from snapshots — and a chart of wallet (rebuilt exactly
  from the ledger) against account value (snapshots every 15 minutes from now on).
- Behaviour leads with what each habit cost: adding while underwater, sizing up after a loss,
  winners turned losers, holding losers — each against a comparison group, with n.

## Calculators, part 2: ladder, Size and Break-even (2026-10-03)

- The P&L tab shows P&L and return at ±2/5/10% around the exit price.
- **Size**: quantity, notional and margin that risk a chosen % of equity at a stop,
  pre-filled with the Stops tab's suggestion. **Break-even**: the exit that covers both fees
  and the funding for the hold, from the account's taker rate and the position's funding.
- `pnlLadder`, `sizeFromRisk` and `breakEven` in `calc-engine.js`, unit-tested.

## Calculators, part 1: live and account-aware (2026-10-03)

- A position picker fills every calculator tab from a live position, including the
  maintenance rate for its size tier.
- The Liq tab is account-aware for Binance positions — the Stress tab's cross-pool solve,
  with Binance's reported price beside it and a *what if I add* re-solve — and the Avg tab
  shows liquidation after the add. The old flat formula was 54–98% off on every live leg.
- The arithmetic moved into `calc-engine.js`, served at `/calc-engine.js` and unit-tested;
  `addToPosition` joins the risk engine.

## Stops: real vs suggested (2026-10-03)

- Every Stops tile shows your real stop beside the suggestion: distance from mark, in ATRs,
  as a multiple of the suggestion, and how often a 24h move that size happened on the
  symbol's own candles — with a verdict: no stop, hedged, too tight, too wide, breakeven,
  locks profit, OK. The combined panel counts them. No extra request.
- A stop at entry read "too tight" on a short whose 24h hit rate was 60.2%: "locks" needed
  strictly positive locked profit, so a breakeven stop fell through to the risk checks. A
  stop within ±0.05% of entry is now `breakeven` and exempt from them.
- One rule for "your stop" (a closing `Stop…` order) across the Stops tab, the entry
  capture and the tiles' badge, via `hasStop` on `/api/dashboard`. The badge no longer counts
  a reduce-only limit order — a take-profit — as a stop.
- New pure engine `stop-check.js`; `legStop` moved there from `trip-context.js`.

## Journal: context at entry (2026-10-03)

- Every increasing fill on the order stream records, once per order: equity, margin %, free
  margin, leverage, the Confluence reading, the suggested stop, and five minutes later your
  stop and its ratio to the suggestion. Joined to trips by the opening orderId; shown under
  *More columns* and in the CSV. Captured only while the server runs.
- The Confluence and Stops calculations moved out of their routes into
  `lib/confluence-reading.js` and `lib/stop-suggestion.js`, so the capture runs the same
  code as the tabs; route output is byte-identical (golden snapshot). The stop layers are
  now named helpers, and the stream's event handling is `applyUserDataEvent` with an
  `onFill` hook.

## Journal: richer Trades (2026-10-03)

- The Trades sub-tab is one table of every round trip: opened and peak size, adds, held,
  net after fees and funding, MAE / MFE, session, hedged at entry; *More columns* adds ATR,
  BTC trend, entry → exit, fees, funding, fills and maker %. Sort, filter, CSV export.
- `GET /api/trips`. Context is fetched by a new last phase of the history sync and cached
  per trip, versioned; funding for hedged legs is split from Binance's net row and sums to it
  exactly. `/api/performance` drops its three trip lists.
- New pure engine `trip-context.js`; `buildRoundTrips` also returns each trip's size steps.

## Tools in the sidebar (2026-10-03)

- Stops, Stress, Unwind, Journal and Confluence moved from the tab strip to **tool widgets**
  in the sidebar — icon and name, three over two. Clicking the open tool returns to the last
  positions view; below 900px they sit in a strip above the content.
- One `TOOLS` table in `public/js/tools-nav.js` replaces the three hand-written lists of tool
  views in `render.js`.
- A launcher list with a live hint per row was built first and dropped: too much on screen.

## Venue switch (2026-10-03)

- **Each exchange can be switched off from the status bulb**, and an exchange that is off is
  never called: no account read, no candles, and for Binance no order stream, reconcile or
  warm-up. Saved in `data/settings.json`; Hyperliquid defaults to off without a wallet — it
  used to send four calls per poll with an empty `user`.
- `GET`/`POST /api/venues` (JSON only); Binance-only routes answer `409 { disabled: true }`.
- Health ignores an exchange that is off. The bulb shows a ring when one is off.
- The route tests count requests per venue: zero for one that is off, on every route.

## USDC collateral (2026-10-03)

- **Binance equity left out the USDC pool.** In single-asset mode every account total covers
  USDT only (Binance docs, confirmed on the live account: USDT + USDC held, three
  USDC-margined positions, totals equal to the USDT pool). Equity, margin used, maintenance
  and free margin now sum the collateral pools; `/api/dashboard` returns `binance.assets`
  for a per-asset view later — the sidebar split was tried and dropped as too busy.
- The fake exchange follows the same rule, so the route test fails if USDC is dropped.
- `baseAsset` in `routes/volstops.js` strips `/USDC`; calculator labels say USD, not USDT.

## Maintainability restructure (2026-09-29, after the review)

No behaviour change except the two additions at the end; each step was checked against a
golden snapshot of every route and a render of every view.

| Step | What changed |
|---|---|
| Safety net | `test/fake-exchange.js` (synthetic hedged book, exchange-derived margin figures), `test/routes.test.js` (every route, exact calibration, ban guard, golden snapshot), `test/frontend.smoke.test.js` (every view and drawer rendered in a vm), `scripts/check.mjs` (syntax, assets, route-table drift, regression guards — it found four unescaped error messages on its first run), `npm run verify` |
| Server | 2,065-line `server.js` → 69 lines of wiring + 13 `lib/` modules + 10 `routes/` files. Moved verbatim; imports generated from use; the account ↔ stress cycle broken by `lib/binance-meta.js` |
| Frontend | 5,533-line `index.html` → 289 lines of markup + `css/app.css` + 13 ordered classic scripts |
| Docs | `CLAUDE.md` 1,260 → ~140 lines of map and rules; every section moved verbatim into `docs/`; new `docs/architecture.md` with recipes |
| Added | `GET /api/health` + header chip; clean exit on SIGTERM so `npm run dev` restarts never hit `EADDRINUSE` |

## Review 2026-09-29: what was fixed, what is next

Four parallel read-only reviews (backend, maths engines, history/journal, frontend), each
finding re-verified against the code or live data before anything changed. 141 tests pass;
every view was render-tested against live payloads; Stress calibration is still 0.000% on
maintenance margin, initial margin and equity, and ENA's liquidation price matches Binance's.

### Fixed — correctness
| Area | Was | Now |
|---|---|---|
| Binance equity | `totalWalletBalance`, which leaves out a large unrealised loss | `totalMarginBalance`: equity was overstated nearly **4×** and margin used understated by the same factor; stop sizing uses it. `walletBalance` kept as its own field |
| Daily funding (5 places in the UI) | `× 3` everywhere — 4h symbols understated 2×, 1h 8×, Hyperliquid (hourly) 8× | `fundingPerDay(p)` uses each position's `fundingIntervalHours`; HL positions carry `1` |
| Stress kill prices on hedges near a tier floor | a breach at +4.15% reported at +6.38% | bracket floors sampled on every ray (*Ray sampling* 4), regression-tested |
| Round trips | float dust kept finished trips open; orphan fills made fabricated trips | relative close tolerance; orphans counted separately; identity verified to $2.7e-11 |
| NDJSON store | a torn last line swallowed the next appended row for good | newline repaired before appending, tested |
| Confluence track records | significance overstated ~2× (overlapping windows); half the displayed readings not calibrated | effective n, Wilson 95% interval, ✓/✗ only when it clears chance; calibrates exactly the ▲/▼ readings |
| Cross-asset vol layer | returns paired by index — one stale bar took correlation 1.0 → 0 | paired on candle open time |
| Unwind planner loss cap | ignored fees (a "0 loss" plan could cost $10 in fees) | fees count toward the cap |
| Hedge ledger | hard-coded combined tiers; re-read 3.6MB of income per open | uses the tier mode calibration chose; reads the cached analytics |
| Short targets / long stops | could go negative at extreme vol | floored at 0.1% of entry |
| Free-margin anchor | skipped exactly when free margin hit 0 | anchors whenever the exchange reports a figure |
| `?maxLoss=abc` | NaN blocked every close | treated as no cap |
| `Math.min(...array)` over fill history | stack overflow at ~130k rows (~1.5 years) | reduce |

### Fixed — resilience and quota
Shared 10s account snapshot with in-flight dedupe; `once()` dedupe for market data; a 418/429
pauses **every** Binance call until `Retry-After` (see *API budget*); 10s timeout on every
fetch; failed `exchangeInfo`/`fundingInfo` fetches are no longer cached as successes, and an
assumed commission rate retries in 30 minutes rather than 24h; `/api/volstops` fans out its
candle fetches (cold 3.8s → 0.5s); order-cache seed, ping and `listenKeyExpired` handling
(*Order cache* 6–7).

### Fixed — frontend
Stops is a mounted panel (the poll no longer wipes a half-typed risk % or k); out-of-order
responses dropped on Stops and Confluence (`volSeq`, `cfSeq`); Confluence "updated Xs ago"
ticks; Esc closes all six drawers; prices in tiles and the list use `fmtPrice` (a 0.249 price
read `$0.25`); every signed figure carries a `−`; `esc()` on the confluence symbol, tooltips
and error text, and the symbol is validated client-side; poll pause/overlap guard, stale
status, remembered view, 900px breakpoint.

### Deliberately not applied
- **Loopback binding and a POST-only sync start** — proposed, declined for now (see *Known gaps*).

### Next
Moved to [`roadmap.md`](roadmap.md).
