# Architecture

## Layers

```
server.js                      wiring: static files, routes in order, services when run directly
routes/*.js                    one register(app) per area — request parsing and response shaping only
lib/*.js                       exchange access, caches, snapshots, the history store sync
risk-engine.js calc-engine.js sessions.js vol-estimator.js stop-check.js confluence.js trade-analytics.js trip-context.js habits.js
performance.js stats.js history-store.js
                               pure engines at the root: no network, fully unit-tested
public/index.html              markup only
public/css/app.css             every style; theme tokens on :root
public/js/*.js                 classic scripts, one global scope, loaded in a fixed order
```

`risk-engine.js`, `calc-engine.js` and `sessions.js` stay at the project root because the
browser imports them from `/risk-engine.js`, `/calc-engine.js` and `/sessions.js` — the stress panel and the API run the same file, so they cannot disagree.

## Server modules — imports only point down this list

| Module | Owns | Notes |
|---|---|---|
| `lib/config.js` | `.env`, base URLs, `FETCH_TIMEOUT_MS`, `ROOT_DIR`, `DATA_DIR` | loads `dotenv/config` first, so every importer sees the environment |
| `lib/venues.js` | which exchanges may be called, saved in `data/settings.json` | the request functions refuse a venue that is off |
| `lib/util.js` | `sleep`, `jitter`, `sharedSnapshot`, `once` | `once` holds the single in-flight Map every fetcher shares |
| `lib/binance-client.js` | signing, `binanceFetch`, `bnPublic`, the ban guard, `throttleWeight` | **every** Binance call goes through here |
| `lib/hyperliquid.js` | `hlFetch`, the HL account view | read-only |
| `lib/binance-meta.js` | funding cadence, lot filters, commission, depth, brackets | exists to break the account ↔ stress import cycle |
| `lib/orders-stream.js` | user-data websocket, order cache, 60s reconcile, watchdog | state that reassigns itself lives in one module |
| `lib/binance-account.js` | `getBinanceData()` over the shared snapshot | regular orders rebuilt from the stream cache per read |
| `lib/market-data.js` | 1h candles, both venues | merged so history grows while running |
| `lib/pools.js` | cross pools, calibration against reported figures | used by riskbook, deleverage, hedge ledger |
| `lib/history-sync.js` | income + fill sync into `data/` | `DASHBOARD_DATA_DIR` overrides the folder (tests) |
| `lib/analytics.js` | memoised round trips and statistics | keyed on the sync cursors |
| `lib/confluence-reading.js` | `readConfluence(symbol, tfs)` — one symbol's full reading | used by the Confluence route and the entry capture |
| `lib/stop-suggestion.js` | `suggestStop(position, …)` — vol layers, regime, stop and size | used by the Stops route and the entry capture |
| `lib/equity-snapshots.js` | account value every 15 minutes, both venues | started from `server.js` |
| `lib/entry-context.js` | context captured on each increasing fill, `entryContextByOrder()` | wired to the stream's `onFill` in `server.js` |
| `lib/trip-enrichment.js` | per-trip candles and funding rates during a sync, `enrichedTrips()` | caches computed values only, versioned |
| `lib/confluence-data.js` | klines on any timeframe, positioning series | |

A module that imports a `let` gets a live, read-only binding: reading another module's
state is fine, reassigning it is impossible. That is why the order cache, its stream and
the watchdog share `lib/orders-stream.js`.

## Frontend scripts — load order is part of the contract

`core → venues → tools-nav → sessions-view → positions → tiles-threads → stops → stress → hedge-ledger → confluence-view →
journal → journal-trades → unwind → render → calculators → drawers → boot`

- Classic scripts, not modules: inline `onclick="fn()"` handlers need globals, and classic
  scripts share one global lexical scope for `let`/`const` across files.
- Function declarations hoist only within their own file. Code that **runs at load** may
  only call into earlier files: `core.js` first because state initialisers call `loadPref`;
  `boot.js` last because it registers the global listeners and starts the poll.
- A file that throws while loading leaves its `let`/`const` bindings uninitialised for
  good, and every later access throws — `npm run verify` loads them in order to catch it.
- Never `async` on these tags.

## Tests and checks — `npm run verify`

| Layer | File | What it pins |
|---|---|---|
| Engines | `*.test.js` at the root | the maths, against hand-worked and property cases |
| Routes | `test/routes.test.js` | every route against `test/fake-exchange.js`; calibration must be exact, a 418 must pause every call, output must match `test/golden/routes.json` |
| Page | `test/frontend.smoke.test.js` | the scripts load in `index.html` order in a vm and every view and drawer renders without throwing or printing `undefined`/`NaN` |
| Static | `scripts/check.mjs` | syntax everywhere, assets the page references, the route table in `docs/api.md` against the registered routes, and guards for shipped bugs |

The fake exchange is synthetic — a small hedged book whose "reported" margin figures are
derived with the exchange's own bracket arithmetic. No account data is committed.

`UPDATE_GOLDEN=1 npm test` rewrites the golden snapshot. Do it only when a response is
**meant** to change, and read the diff: the snapshot exists to prove a refactor changed
nothing.

## Recipes

**Add a route.** Put exchange access in the `lib/` module that owns that data (or a new
one, placed in the layer list), then `routes/<area>.js` with `export function register(app)`,
registered in `server.js`. Add a row to the route table in `docs/api.md` — the check fails
until you do — and a case to `test/routes.test.js`; if the fake exchange lacks an endpoint
it returns a 404 naming it.

**Add a positions view** (a way of looking at the book). A button in `tabsHtml` and a branch
in `render.js`, `VIEWS` in `boot.js` and in `test/frontend.smoke.test.js`.

**Add a tool** (a panel that fetches its own data). One entry in `TOOLS` and an icon in
`TOOL_ICON` in `public/js/tools-nav.js` (`binanceOnly` or `exchangeFilter` if they apply) — then a `public/js/<tool>.js` placed before `render.js`, a
`renderX()` branch in `render.js`, its fetch in `setView()`, and `VIEWS` in `boot.js` and the
smoke test. If it has inputs, give its controls a `…-mounted` id and add it to the `mountId`
map in `render()`, or the 15s poll will rebuild it mid-edit.

**Add a confluence signal.** One entry in `CONFLUENCES` in `confluence.js` with a
`scoreAt(x, i, regime)` that reads only bars ≤ `i`. It gets a track record automatically;
the lookahead property test covers it.

**Change a number the exchange also reports.** Read `docs/stress-engine.md` first. The
calibration in `lib/pools.js` must stay at 0% on the live account, and the route test
asserts it against the fake book.
