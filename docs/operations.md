# Operations: order feed, request budget, latency, deployment

## Order cache: the stream is an accelerator, REST is the truth

`bnOrderCache` is fed by the user-data websocket, and a websocket-fed cache drifts the moment
one event is missed — silently, because nothing in the stream tells you it happened. A
phantom AAVE order sat on the dashboard for three days after it had already gone from the
exchange. Five things allowed it, all now fixed:

1. **No reconciliation.** `reconcileOrders()` re-reads `/fapi/v1/openOrders` every 60s and
   replaces the cache wholesale, logging any difference. This is the load-bearing fix: it
   heals *every* drift cause, including ones not anticipated here, within a minute.
   Weight 40/min against a 2400/min budget.
2. **`error` did not reconnect.** A websocket `error` is not guaranteed to be followed by
   `close`, and when it is not the socket is simply dead. An `ECONNRESET` froze the cache for
   three days. The handler now terminates and schedules a reconnect itself.
3. **The keepalive ignored its response.** A failed `PUT /fapi/v1/listenKey` let the key
   expire, after which the stream goes quiet *without closing*. It now checks `res.ok` and
   forces a reconnect.
4. **No stalled-stream watchdog.** `lastWsMessage` is stamped on every frame; 20 minutes of
   silence forces a reconnect.
5. **Terminal statuses were an allowlist.** `['FILLED','CANCELED','EXPIRED','REJECTED']` meant
   a status Binance added later — `EXPIRED_IN_MATCH`, for self-trade prevention — would leave
   the order on screen forever. Anything that is not `NEW` or `PARTIALLY_FILLED` now leaves
   the cache.

6. **A failed seed wiped the cache and never started the reconcile timer** (fixed
   2026-09-29). The timer now starts on every connect whether or not the seed succeeded, and a
   failed seed keeps the previous cache until the next reconcile replaces it.
7. **A quiet account looked like a dead stream.** Only data frames stamped `lastWsMessage`,
   so an idle account was torn down every ~20 minutes. Server pings now stamp it too, and a
   `listenKeyExpired` event forces a reconnect immediately instead of waiting for the watchdog.

`account.orderFeed` in `/api/riskbook` exposes `lastReconcileAt`, `lastDrift` and
`lastWsMessageAgeSec`, so a stale feed is observable rather than silent.

## API budget: where the request quota goes

Audited 2026-09-29 with the weight Binance itself reports: the `x-mbx-used-weight-1m` header
on a weight-1 `/fapi/v1/time` call read before and after each route, so every figure below is
measured rather than taken from the docs (Hyperliquid reports no usage header, so its figures
are computed from its published weights).

**Verdict: comfortably inside every limit — ~12% of Binance's budget and ~15% of
Hyperliquid's with one tab, and since the shared snapshot (below) no more than ~17% / ~22%
however many tabs are open.** Before it, the quota scaled with tabs and ~7 tabs exhausted
Hyperliquid.

### Limits in play
| Limit | Budget | Counted by |
|---|---|---|
| Binance REST weight (per IP) | 2,400 / min | `x-mbx-used-weight-1m`; 429 past it, **418 IP ban** if requests continue |
| Binance `/futures/data/*` | 1,000 / 5 min | separate; weight 0 on the main budget (measured) |
| Binance `fundingRate` + `fundingInfo` | 500 / 5 min | separate; weight 0 on the main budget (measured) |
| Hyperliquid info (per IP) | 1,200 / min | `clearinghouseState`, `spotClearinghouseState` = 2, other info = 20, `candleSnapshot` +1 per 60 bars |

### Measured Binance weight per route
| Route | Cold | Warm (cached) | What drives it |
|---|---|---|---|
| `/api/dashboard` | 60 | **0 within 10s** | account 5 + positionRisk 5 + premiumIndex (all symbols) 10 + openAlgoOrders ≈40, shared snapshot |
| `/api/volstops` | 108 | 0–60 | snapshot + 1h klines (2 each), 60s cache |
| `/api/riskbook` | 208 | 16 | snapshot + commissionRate 20/asset (24h), depth 2/asset (10s), brackets (24h); `?fresh=1` (Refresh marks) forces a new read: 60 |
| `/api/deleverage`, `/api/hedgeledger` | 60 | 0 within 10s | share the snapshot |
| `/api/confluence` (BTC / alt) | 20 / 35 | 0 | 1,000-bar klines = 5 each, TTL 1–10 min; positioning series weigh 0 |
| `/api/performance`, `/api/symbols` | 0 | 0 | local store / cached exchangeInfo |
| order reconcile (timer) | 40 / min | — | `openOrders` without a symbol |
| boot / each `node --watch` restart | ≈45 | — | exchangeInfo 1, brackets 1, listenKey, openOrders seed 40 |

The individual figures behind those totals, also measured: `premiumIndex` all symbols 10 (1
with a symbol), klines `limit=200` 2 and `limit=1000` 5, `depth limit=50` 2, `exchangeInfo` 1.
`openAlgoOrders` is inferred as 40 from the dashboard's measured 60 less its three known parts.

### Steady state and headroom
- **Binance, one tab:** 60 × 4 polls + 40 reconcile ≈ **280 / min (12%)**. Measured idle drift
  with one tab open: 65 weight in 20s, consistent.
- **Hyperliquid, one tab:** clearinghouseState 2 + metaAndAssetCtxs 20 + openOrders 20 +
  spotClearinghouseState 2 = 44 per poll ≈ **176 / min (15%)**, plus ~24 per HL position per
  minute while the Stops tab is open.
- **Clicking through every panel once:** ≈ +500 Binance weight in that minute. Harmless.
- **History full sync:** serial, and `throttleWeight()` pauses 20s whenever the reported weight
  passes 1,800 — the header is IP-wide, so the tabs' own usage is already inside that check.
- **Confluence browsing:** 16 `/futures/data` calls per cold symbol; flicking through ~60
  symbols inside five minutes would reach that separate 1,000 cap. Not realistic in normal use.

### Tabs no longer multiply the cost (fixed 2026-09-29)
Every account-reading route used to call both exchanges fresh, so each open tab, window or
device added its full cost and ~7 tabs exhausted Hyperliquid. Now:

- **`sharedSnapshot(fetcher, 10s)`** holds one in-flight request and one recent result for the
  raw REST reads (`bnRaw`: account, positionRisk, premiumIndex, algo orders, fundingInfo;
  `hlRaw`: the four HL info calls). Regular orders are still rebuilt from `bnOrderCache` on
  every read, so the websocket's freshness is not held back. Rejections are never cached.
  Worst case is one read per 10s whatever the tab count: **≤ ~400 Binance / min (17%)** and
  **≤ ~264 Hyperliquid / min (22%)**. Measured: repeat calls inside the window cost 0.
- **The browser skips the poll while the tab is hidden** and never overlaps two polls.
- **`once(key, fn)`** dedupes concurrent identical market-data fetches (klines, HL candles,
  confluence klines, positioning series), so the two legs of a hedge share one request.

### A ban stops everything, not just the signed path
`noteBinanceResponse()` reads `x-mbx-used-weight-1m` from **every** Binance response, and on a
418 or 429 sets `bnBannedUntil` from `Retry-After` (120s / 60s when absent). `binanceFetch` and
the new `bnPublic()` — now used by premiumIndex, klines, depth, exchangeInfo, fundingInfo and
every confluence series — refuse to send until it passes. The old signed path retried a 429
four times and public calls ignored status entirely, so a ban could be extended by the next
poll. Every fetch also carries a 10s `AbortSignal.timeout`, so a hung socket cannot hang a route.

### Health: `GET /api/health`
One verdict — `ok`, `warn` or `bad`, with a reason per finding — on whether the figures on
screen can be trusted, built from state the server already holds, so it makes **no exchange
call** and rides along with every dashboard poll. `lib/health.js` (`assessHealth`, pure and
unit-tested) applies the thresholds:

| Finding | Level |
|---|---|
| Binance paused after a 418/429 (with seconds left) | bad |
| request weight ≥ 1,800 of 2,400 (the sync throttle's ceiling) | bad |
| request weight ≥ 1,200 | warn |
| order stream not connected, or quiet > 10 min (Binance on) | warn |
| last reconcile found drift | warn |
| an account snapshot older than 2 min (exchange on) | warn |
| last history sync failed | warn |

The header chip beside *Last updated* is hidden while the verdict is `ok`; otherwise it shows
⚠ or ⛔ with the issue count, and every reason in its tooltip.

### Trip context sync
The history sync's last phase fetches candles per closed trip: one path request (≤1,500 bars,
weight 10) and one 20-bar ATR request (weight 1) per trip, BTC 1h history once, and funding
rates only for symbols with hedged settlements. Every request passes `throttleWeight()`; the
first run on a few hundred trips took a few minutes and stayed far below the limit. Results are
cached per trip, so later syncs fetch only new trips.

### Entry capture: `onFill`
`lib/orders-stream.js` exposes `onFill(listener)`; `server.js` registers
`captureEntryContext`, so the stream never imports the journal. Each increasing order costs
one Confluence reading (about 20 public calls, mostly cached), two cached kline reads and one
account read five minutes later — about nine orders a day on this book.

### Venue switch: an exchange that is off costs nothing
`lib/venues.js` holds one switch per exchange, saved in `data/settings.json`; without a
saved choice an exchange is on when its credentials are in `.env`, so Hyperliquid stays off
with no `HL_WALLET_ADDRESS`. Switched from the status bulb or `POST /api/venues`.

| Off | Effect |
|---|---|
| Hyperliquid | `getHyperliquidData()` returns an empty book; no account read, no candles — before this, an empty wallet still sent four calls per poll with `user: ''` |
| Binance | empty book; user-data stream closed and its listenKey released; reconcile, keepalive and watchdog idle; boot warm-up skipped; riskbook, deleverage, hedge ledger and sync start answer `409 { disabled: true }` |

`hlFetch` and the signed `binanceFetch` refuse a venue that is off, so a call path the
gate misses fails loudly instead of spending quota; the route tests assert zero requests per
switched-off venue across every route. Public Binance market data (`bnPublic`) stays
available, so Confluence works with Binance off. Switching Binance on reconciles the order
cache at once and reopens the stream. `POST /api/venues` takes `application/json` only: a
cross-site page cannot send that without a CORS preflight, which the server never answers.

### Restarts under `npm run dev`
`node --watch` starts the new process at once. When several files were saved in the same
second, the old process still held the port and the restart failed with `EADDRINUSE`; the
server now closes and exits immediately on SIGTERM/SIGINT.

### Latency: warm the slow caches at boot, fan out the rest
`/api/riskbook` took **13.4s** on its first call. The costs were `exchangeInfo` (2.6s, ~1MB),
`leverageBracket` for all symbols (2.5s, 942KB) and per-asset candle, depth and commission
fetches issued **serially in a loop**. All three long-lived tables are now warmed in a
boot-time `Promise.all` (905 filters, 790 funding intervals, 1,039 bracket tables), and the
per-asset work fans out one request per *asset* rather than per position. Cold is now 5.5s,
warm 0.5–2s. When changing this path, keep the fan-out: a `for` loop with an `await` inside
was the single largest cost.

## Deployment notes

- **Local**: `npm start` → `http://localhost:3000`
- **Railway / Render**: push to GitHub, add env vars in dashboard, deploy
- **VPS**: use `pm2 start server.js --name dashboard`
- **Keep it running to capture context at entry**: it is recorded from the live order stream,
  so trades placed while the server is stopped have none (`docs/journal.md`). Locally,
  `pm2 start server.js --name perpfolio` or a `launchd` agent keeps it up between sessions
- Express serves `public/` (markup, `css/app.css`, `js/*.js`) as static files — no separate frontend deployment needed
