# Crypto Portfolio Dashboard — CLAUDE.md

Real-time portfolio dashboard and risk workbench for **Binance USDM Futures** (plus a read-only
**Hyperliquid** view). Express backend, vanilla HTML/CSS/JS frontend. No framework, no build
step, no dependency beyond express/dotenv/ws — tests and checks use Node built-ins only.

Not a database, but not stateless either: account history is cached locally as append-only
NDJSON in `data/` (gitignored) because Binance serves income for only three months and fills
only through cursor paging.

The book this was built against is a hedged one — same-symbol long and short on several
symbols, cross margin, high leverage — and much of the design exists because that book breaks
the naive version of each calculation.

**Read before changing anything numeric:** the calibration rules in
[`docs/stress-engine.md`](docs/stress-engine.md) (*Endpoint: `GET /api/riskbook`*). Every margin
figure is scored against Binance's own reported numbers on every request, and the UI is
expected to say so rather than assert correctness.

## Where things are

| Area | Read | Code |
|---|---|---|
| How the pieces fit, recipes for common changes | [`docs/architecture.md`](docs/architecture.md) | `server.js`, `lib/`, `routes/` |
| Routes, payload shapes, exchange endpoints | [`docs/api.md`](docs/api.md) | `routes/`, `lib/binance-*.js`, `lib/hyperliquid.js` |
| Views, mounted panels, drawers, theming | [`docs/frontend.md`](docs/frontend.md) | `public/js/`, `public/css/app.css` |
| Volatility-adjusted stops | [`docs/stops.md`](docs/stops.md) | `vol-estimator.js`, `routes/volstops.js` |
| Stress / liquidation maths, calibration | [`docs/stress-engine.md`](docs/stress-engine.md) | `risk-engine.js`, `lib/pools.js` |
| Unwind planner and drawers | [`docs/unwind.md`](docs/unwind.md) | `risk-engine.js`, `routes/deleverage.js` |
| Trade history, journal, hedge ledger | [`docs/journal.md`](docs/journal.md) | `history-store.js`, `trade-analytics.js`, `trip-context.js`, `lib/history-sync.js`, `lib/trip-enrichment.js` |
| Market confluences for one coin | [`docs/confluence.md`](docs/confluence.md) | `confluence.js`, `lib/confluence-data.js` |
| Order feed, request budget, latency, deployment | [`docs/operations.md`](docs/operations.md) | `lib/orders-stream.js`, `lib/binance-client.js` |
| What changed | [`docs/changelog.md`](docs/changelog.md) | — |
| What is next | [`docs/roadmap.md`](docs/roadmap.md) | — |
| What is deliberately not done | [`docs/known-gaps.md`](docs/known-gaps.md) | — |

## Project structure
```
crypto-dashboard/
├── server.js              # wiring only — static files, routes, services when run directly
├── lib/                   # exchange clients, caches, shared snapshot, history sync (see docs/architecture.md)
├── routes/                # one register(app) per area
├── risk-engine.js         # stress / liquidation / unwind maths — also served to the browser
├── vol-estimator.js       # composite volatility for dynamic stops
├── confluence.js          # market signals, regime gating, self-calibration
├── trade-analytics.js     # round trips and statistics
├── trip-context.js        # per-trip funding, price path, market at entry
├── history-store.js       # append-only NDJSON cache
├── *.test.js              # engine unit tests
├── test/                  # fake exchange, route contract tests, golden snapshot, page smoke test
├── scripts/check.mjs      # static checks
├── docs/                  # design notes, one file per area
├── data/                  # cached income + fills (gitignored)
├── .env / .env.example    # credentials (never commit .env)
└── public/
    ├── index.html         # markup only
    ├── css/app.css
    └── js/                # 16 classic scripts, loaded in a fixed order (docs/frontend.md)
```

## Running and verifying

```bash
npm install          # first time only
npm start            # production
npm run dev          # development, restarts on any imported file change
npm run verify       # static checks + every test — run before every commit
npm run coverage     # the same tests with Node's built-in coverage report
```

`npm run verify` must stay green: it covers the engines, every route against a fake exchange
(including exact calibration and the ban guard), a render of every view and drawer, and the
checks in `scripts/check.mjs`. `UPDATE_GOLDEN=1 npm test` rewrites the route snapshot — only
when a response is meant to change.

First run of the Journal needs a history build: open the **Journal** tab and press **Sync
recent**, or `curl "localhost:3000/api/history/sync?start=true&full=true"`. The full build is
about a minute for a book with a few months of activity; afterwards a routine sync is
~10s.

Server runs on `http://localhost:3000` (or `$PORT`).

## Environment variables (`.env`)

| Variable | Description |
|---|---|
| `BINANCE_API_KEY` | Read-only Binance API key |
| `BINANCE_API_SECRET` | Binance API secret (HMAC signing) |
| `HL_WALLET_ADDRESS` | Hyperliquid public wallet address (`0x...`); without it Hyperliquid stays off |
| `PORT` | Optional, defaults to 3000 |
| `DASHBOARD_DATA_DIR` | Optional, where history is cached (defaults to `data/`; the tests use a temp dir) |

Never log or expose these. Never commit `.env`.

## Coding conventions

- ES Modules on the server (`"type": "module"`); classic scripts in the browser, for the reason
  in `docs/frontend.md`
- No TypeScript, no transpilation, no build step, no new dependencies
- All async functions use `async/await`; route errors return `{ ok: false, error: "..." }`
- All exchange access lives in `lib/` — routes shape responses, the frontend only renders and
  never calls an exchange directly
- Backend sends raw floats/numbers; format at render time in the frontend
- `parseFloat()` everywhere on exchange API responses — they return strings
- Funding rate math: `(side === 'Long' ? -1 : 1) * (fundingRate / 100) * sizeUsd` per settlement —
  **positive = received**, negative = paid. `fundingPerDay(p)` in the frontend is the only place
  the daily figure is computed
- Funding **per day** is `rate × (24 / fundingIntervalHours) × notional`, never `× 3` — 8h, 4h
  and 1h symbols all exist, and the declared interval can itself be wrong (`docs/journal.md`,
  *Funding cadence*)
- Null/absent data: return raw `null` from backend, render as `"—"` in frontend via `fmtPnl(null)` → NaN → `"—"`
- A new doc belongs in `docs/`, linked from the table above — keep this file a map

## Rules earned the hard way
- **Never `await` inside a `for` loop over positions or assets.** Fan out with `Promise.all`
  keyed by *asset*, not position. Serial loops were the whole of a 13.4s cold response
- **A grid track needs `min-width: 0`.** It defaults to `min-width: auto`, so one wide table
  widens the track and pushes content out under the sidebar instead of shrinking
- **A range or input the user set is theirs.** Recomputing a "best fit" on the next event
  discards it — auto-fit only when nothing has been chosen, and only ever grow
- **Show the sample size next to every derived number.** A bucket with two trades can read
  a five-figure loss and mean nothing
- **Score models against the exchange's own figures on every request**, and put the error in
  the UI. When a figure is an extrapolation, say so rather than printing false precision
- **Treat a websocket cache as an accelerator, never as truth.** Reconcile against REST on a
  timer; every drift cause then heals itself
- **Equity is the margin balance, never the wallet.** `totalWalletBalance` leaves out
  unrealised PnL; on this book it overstated equity nearly 4×, and stop sizing and
  margin % were computed on it
- **A sign is a glyph, not a colour.** Every local `sign()` helper emits `−`; colour only
  reinforces. The project's own green/red pair fails deuteranopia (ΔE 3.2)
- **Never interpolate user or exchange text into markup unescaped** — `esc()` for attributes
  and error messages. The confluence symbol input reached `value="…"` before the server's
  regex could reject it
- **Cache only success.** A timestamp stamped on a failed fetch turned one 5xx into 24h of
  empty symbol filters and 6h of every symbol assumed to settle every 8h
- **Share reads across tabs.** Anything the 15s poll triggers must go through a shared
  snapshot, or the exchange quota scales with open tabs
- **Refactor against a snapshot.** Moves that should change nothing are checked by the golden
  route snapshot and the page smoke test, not by eye
