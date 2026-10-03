# Roadmap

Planned work, in priority order. History lives in [`changelog.md`](changelog.md); what is
deliberately left out lives in [`known-gaps.md`](known-gaps.md). Decided 2026-10-03.

Each card: **Problem · Scope · Done when · Depends on · Status**. Status is one of
`idea` → `planned` → `in progress` → `done (date)`. Move a card to the changelog when done.

| Priority | Card | Status |
|---|---|---|
| P0 | [USDC in assets](#p0--usdc-in-assets) | done (2026-10-03) |
| P1 | [Venue on/off](#p1--venue-onoff) | done (2026-10-03) |
| P2 | [Tools in the sidebar](#p2--tools-in-the-sidebar) | done (2026-10-03) |
| P3 | [Stops: real vs suggested](#p3--stops-real-vs-suggested) | done (2026-10-03) |
| P3 | [Journal: Overview and Behaviour](#p3--journal-overview-and-behaviour) | done (2026-10-03) |
| P3 | [Journal: richer Trades](#p3--journal-richer-trades) | done (2026-10-03) |
| P3 | [Journal: context at entry](#p3--journal-context-at-entry) | done (2026-10-03) |
| P3 | [Confluence: verdict and honest calibration](#p3--confluence-verdict-and-honest-calibration) | done (2026-10-03) |
| P3 | [Calculators: live and account-aware](#p3--calculators-live-and-account-aware) | done (2026-10-03) |
| P3 | [Sessions across the dashboard](#p3--sessions-across-the-dashboard) | planned |
| P3 | [Protected tiles read as safe](#p3--protected-tiles-read-as-safe) | planned |
| P4 | [What correlates with outcome](#p4--what-correlates-with-outcome) | idea |
| P4 | [Goals: design spike](#p4--goals-design-spike) | idea |
| — | [Carried over](#carried-over) | planned |

---

## P0 — USDC in assets

- **Problem:** USDC held on Binance is fetched but never shown or counted. `marginAssets`
  keeps it (`lib/binance-account.js`) but only `/api/riskbook` returns it and no view lists
  assets. Equity and margin come from the account totals, which are believed to cover USDT
  only when multi-assets mode is off — unverified. The fake exchange adds USDC into its
  totals, so no test can catch it.
- **Scope:**
  1. Confirm against the Binance docs and the live account what `totalMarginBalance` covers
     in single- and multi-assets mode.
  2. Per-asset list per venue (wallet, uPnL, margin, available — USDT, USDC, BNB if held),
     with equity summed across assets, valued at the asset's mark.
  3. Fake exchange: totals follow the real rule, so a test fails while USDC is missing.
  4. `baseAsset` regex in `routes/volstops.js` strips `USDC`; calculator labels stop
     hardcoding "USDT".
- **Done when:** a USDC balance appears in the asset list and in total equity, and the
  route test fails if either drops it.
- **Depends on:** —
- **Status:** done (2026-10-03) — see the changelog. Stress was already per-pool and
  unaffected. The per-asset rows under Total equity were dropped as too busy;
  `binance.assets` stays in `/api/dashboard` for a later asset view.

## P1 — Venue on/off

- **Problem:** every venue is called whether used or not. Hyperliquid is never skipped — with
  `HL_WALLET_ADDRESS` empty it still sends four calls with `user: ''` on every 15s poll,
  plus candles from Stops. The only toggle today (`exchFilter`) hides rows, it saves nothing.
- **Scope:**
  - **Off is off on the server:** no REST, no warm-up, no candles; for Binance also no user-data
    stream, reconcile or watchdog. Routes answer `{ disabled: true }` for that venue and the
    UI greys its cards.
  - Persisted in `data/settings.json`; HL defaults to off when no wallet is set.
  - **Control:** the status bulb (`#statusDot`) becomes a button opening a popover — per
    venue a switch, last sync and health. Turning Binance off asks to confirm (it stops the
    order stream). The bulb keeps its states: pulsing while fetching, solid idle, hollow
    when a venue is off, amber/red matching the health chip.
  - `GET`/`POST /api/venues`; `/api/health` stops reporting a disabled venue as stale.
- **Done when:** with HL off, the fake exchange records zero HL requests across every route;
  with Binance off, the websocket is closed and no Binance request is made.
- **Depends on:** —
- **Status:** done (2026-10-03) — see the changelog and `docs/operations.md`, *Venue switch*.

## P2 — Tools in the sidebar

- **Problem:** Stops, Stress, Unwind, Journal and Confluence sit in the same tab strip as the
  positions views, though they are tools, not views of the book.
- **Scope:** a **Tools** section in the right sidebar, between uPnL | Exposure and Margin
  health. Tiles / List / Orders stay as tabs. Tools still open full width in the main column.
  Planned layout — **C, launcher list with a live hint** (built, then replaced by A):
  ```
   TOOLS
   ◎ Stops        2 too tight ›
   ⚡ Stress      liq −18.4%  ›
   ⇣ Unwind                  ›
   ▤ Journal      today +$xx ›
   ◇ Confluence   BTC ▲ 0.42 ›
  ```
  - Hints read only data already fetched — no extra request; blank until the tool has
    loaded once.
  - Hints blur with the eye toggle like every other sidebar figure.
  - The active row is highlighted; clicking it again returns to the last positions view.
  - Under ~800px viewport height it collapses to layout B.
- **Fallback layouts** — kept simple, swap in if C does not work out:
  - **A — icon tiles** (~110px, matches the calculator tiles; risks blurring view vs modal)
    ```
    ┌───────┐┌───────┐┌───────┐
    │ ◎     ││ ⚡    ││ ⇣     │
    │ Stops ││Stress ││Unwind │
    └───────┘└───────┘└───────┘
    ┌───────────┐┌────────────┐
    │ ▤ Journal ││ ◇ Confluen.│
    └───────────┘└────────────┘
    ```
  - **B — segmented icon bar** (~36px, tooltips name each, active one filled)
    ```
    ┌────┬────┬────┬────┬────┐
    │ ◎  │ ⚡ │ ⇣  │ ▤  │ ◇  │
    └────┴────┴────┴────┴────┘
    ```
- **Done when:** the five tools are reachable only from the sidebar, the smoke test renders
  each from there, and the poll never rebuilds a mounted tool mid-edit.
- **Depends on:** P1 (the bulb popover shares the sidebar header).
- **Status:** done (2026-10-03) as layout **A**, plain widgets — C's hints read as clutter in
  use. See the changelog and `docs/frontend.md`, *Views*.

## P3 — Stops: real vs suggested

- **Problem:** Stops suggests a width and size but never compares them with the stop orders
  you actually have.
- **Scope:** per position — your real stop (from the order cache) beside the suggested one,
  the gap in ATR, distance in ATR, and the probability of being hit within N hours from the
  composite volatility. Flags "too tight" / "too wide" / "no stop". Compare only; the key is
  read-only and nothing is placed.
- **Done when:** every position with a stop order shows both stops and a hit probability.
- **Depends on:** —
- **Status:** done (2026-10-03) — see `docs/stops.md`, *Your real stop*. The hit rate is
  measured on the symbol's candles, not modelled; the sidebar hint was dropped with the hints.

## P3 — Journal: Overview and Behaviour

- **Problem:** Overview is Binance-only and reads as a reconciliation, not a result. Behaviour
  describes what happened without saying what it cost.
- **Scope:**
  - **Overview:** equity curve; PnL today / this week / this month; both venues.
  - **Behaviour:** each habit with its dollar cost and n — e.g. "adding while underwater:
    −$X over N trips vs clean trips".
- **Done when:** Overview answers "how am I doing" without arithmetic, and every Behaviour
  finding carries a cost and a sample size.
- **Depends on:** —
- **Status:** done (2026-10-03) — see `docs/journal.md`, *Overview* and *Behaviour*. Account
  value history starts with the snapshots; Hyperliquid has no realised history.

## P3 — Journal: richer Trades

- **Problem:** a trip shows little beyond PnL, so nothing can be correlated later.
- **Scope:** columns computable from fills and candles, so past trips fill in too:
  - **Size:** opened and peak notional in USD, adds, partial closes
  - **Time:** time held, entry hour, weekday, session (Asia / Europe / US)
  - **Costs:** fees and funding split out, net PnL after both (absorbs *funding-adjusted
    PnL per trip*)
  - **Path:** MAE / MFE from 1h klines
  - **Market at entry:** ATR %, BTC trend
  - **Hedge:** whether the opposite leg was open at entry
  - Sortable, filterable, CSV export.
- **Done when:** every trip carries every column (or `—` with a reason), and the export
  round-trips.
- **Depends on:** —
- **Status:** done (2026-10-03) — see `docs/journal.md`, *Trades*. Funding for hedged legs is
  split from Binance's single net row per symbol.

## P3 — Journal: context at entry

- **Problem:** some facts cannot be rebuilt later: equity and margin % at entry, leverage
  setting, the confluence verdict, your stop vs the suggested one.
- **Scope:** on an opening fill from the order stream, append a snapshot to
  `data/entry-context.ndjson`, keyed like the trip, read from the shared snapshot (no extra
  request). Joined onto Trades.
- **Done when:** a trip opened after release shows its context; one opened before shows `—`.
- **Depends on:** richer Trades.
- **Status:** done (2026-10-03) — see `docs/journal.md`, *Context at entry*. Stored in
  `data/entry-context.ndjson` keyed by orderId; adds are captured too.

## P3 — Confluence: verdict and honest calibration

- **Problem:** the matrix is dense, and calibration pools all regimes and scores in-sample.
- **Scope:**
  1. **Verdict first:** bias, strength and the three strongest reasons; matrix on demand.
  2. **Calibration** (old roadmap item 7): split records by regime; fit on the first 70% of
     bars, report on the last 30%.
  - **Later:** liquidation levels, volume profile, order-book imbalance, sessions; custom
    confluences / rule builder; alert on a bias flip.
- **Done when:** the verdict is readable at a glance and every hit rate shown says which regime
  and whether it held up recently.
- **Depends on:** —
- **Status:** done (2026-10-03) — see `docs/confluence.md`. The signals are fixed rules, so
  "out-of-sample" became a stability check (early 70% against recent 30%). New signals, the
  rule builder and alerts remain *later*.

## P3 — Calculators: live and account-aware

- **Problem:** from the sidebar the calculators open blank; Liq uses a linear formula with a
  fixed 0.5% MMR and can disagree with Stress; labels hardcode USDT.
- **Scope**, in order:
  1. **Live:** pick a position; mark, leverage, MMR from the brackets and the asset fill in.
  2. **Account-aware:** liquidation from `risk-engine.js` — cross margin and hedges.
  3. **Sensitivity:** recompute as you type; PnL and liq across a price range.
  4. **New:** size from risk %, break-even including fees and funding.
- **Done when:** the Liq calculator agrees with Stress for the same position and price.
- **Depends on:** P0 (asset).
- **Status:** done (2026-10-03) — see `docs/frontend.md`, *Calculators*. Account-aware for
  Binance only; Hyperliquid stays on the isolated estimate.

## P3 — Sessions across the dashboard

- **Problem:** trading sessions (Asia, Europe, US) shape volatility, funding and your own
  results, but only the Trades table knows about them — nothing says which session is live,
  when the next one opens, or how a view looks for one session alone.
- **Scope:**
  - **Session clock** on the dashboard: the live session, time left in it, the next session
    and its countdown, overlaps (Europe/US) marked. One definition, shared with the journal's
    `sessionOf()` (UTC: Asia 22–08, Europe 08–14, US 14–22), shown in the reader's local time.
  - **Session as a dashboard-wide parameter**: one selector (All · Asia · Europe · US) that
    the views honour where it means something — Journal stats and Trades, habit costs,
    Confluence calibration and Stops hit rates by session — and ignore, visibly, where it
    does not (live positions).
  - Remembered per browser, like the view.
- **Done when:** the clock is always visible and correct across a DST change, and every view
  that honours the session says so in its header with its sample size.
- **Depends on:** — (Confluence and Stops by session build on their own cards).

## P3 — Protected tiles read as safe

- **Problem:** a position tile only ever signals trouble — the red "no stop" badge. A leg that
  is protected looks the same as one nobody has checked, so every tile still draws the eye.
- **Scope:** a calm "protected" mark on the tile when the leg has a stop order (`hasStop`),
  matching the Stops verdict — OK, breakeven or locks profit read as safe; too tight or too
  wide get a muted caution; hedged legs keep their thread colour. Shape plus colour, never
  colour alone; the tooltip names the stop price and verdict.
- **Done when:** a glance at the tiles separates "covered, ignore" from "needs a look", and the
  tile and the Stops tab never disagree about a leg.
- **Depends on:** Stops: real vs suggested (done) — the verdict needs to reach `/api/dashboard`.

## P4 — What correlates with outcome

- **Idea:** rank factors (session, ATR regime, against the confluence bias, adds, margin % at
  entry …) by their effect on PnL and win rate, with n and a confidence interval, the same
  honesty rules as confluence calibration. A factor below a minimum n is not shown.
- **Depends on:** richer Trades, context at entry, and enough trips.

## P4 — Goals: design spike

- **Idea:** process goals checked automatically against fills (max leverage, max loss per
  trade, stop after N losses, trades per day) plus milestones with deadlines and a progress
  line over time. Outcome-only targets are left out — they encourage forcing trades.
- **Spike output:** a short design note — goal types, storage, how each is checked, how
  progress is shown. Behaviour flags are the first candidate goals. No build before the note.
- **Depends on:** Journal: Overview and Behaviour.

---

## Carried over

From the 2026-09-29 review, still open:

- **Per-trip notes and tags** — `data/annotations.ndjson` keyed `symbol:positionSide:openTime`,
  one POST route, one input. Makes Behaviour actionable.
- **Server-side alerts** — kill distance, free margin → 0, ADL quantile ≥ 3, order-feed drift,
  evaluated on the shared snapshot and pushed by webhook.
- **`!markPrice@arr@1s` market stream** — replaces the premiumIndex poll; live marks in Stress.
- **Piecewise-analytic kill prices** — exact by construction, ~100× fewer evaluations per
  slider frame; keep the scan as the cross-check.
- **Keep controls visible on every tab's error state** — Stress, Journal and Unwind replace
  their controls with the error.
- **Keyboard access** — `role="button"`/`tabindex` on tiles and calc tiles, focus trap and
  focus return in drawers.

Absorbed into cards above: funding-adjusted PnL per trip and MAE/MFE (richer Trades),
regime-conditional and walk-forward calibration (Confluence).
