# Changelog and roadmap

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

### Next, ranked by value for effort
1. **`/api/health` + a small status chip** — used weight, ban state, websocket age, last
   reconcile drift, snapshot age. The server already tracks every one of these.
2. **Funding-adjusted PnL per trip** — attach `FUNDING_FEE` rows to the open trip by symbol and
   time. On a hedged book held for days, carry is part of the result. Low effort.
3. **Per-trip notes and tags** — `data/annotations.ndjson` keyed `symbol:positionSide:openTime`,
   one POST route, one input. Makes the Behaviour tab actionable. Low effort.
4. **Server-side alerts** — kill distance, free margin → 0, ADL quantile ≥ 3, order-feed drift,
   evaluated on the shared snapshot and pushed by webhook.
5. **`!markPrice@arr@1s` market stream** for marks and funding — replaces the premiumIndex
   poll and gives the Stress tab live marks.
6. **Piecewise-analytic kill prices** — exact by construction and ~100× fewer evaluations per
   slider frame; keep the scan as the cross-check.
7. **Regime-conditional and walk-forward confluence calibration** — split records by regime,
   fit on the first 70% of bars and report on the last 30%.
8. **MAE/MFE per trip from 1h klines** — whether losers were ever winners, whether stops were
   too tight. Medium effort.
9. **Keep controls visible on every tab's error state** — Stress, Journal and Unwind still
   replace their controls with the error, so the input that caused it is gone.
10. **Keyboard access** — `role="button"`/`tabindex` on tiles and calc tiles, focus trap and
    focus return in drawers.
