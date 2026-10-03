# API: routes, payloads and exchange endpoints

## API architecture

### Hyperliquid
- **Base URL**: `https://api.hyperliquid.xyz/info`
- **Auth**: None required for reads — POST with wallet address in body
- **Endpoints used**:
  - `{ type: "clearinghouseState", user: HL_WALLET }` → positions, margin summary
  - `{ type: "metaAndAssetCtxs" }` → asset metadata + mark prices + funding rates
  - `{ type: "openOrders", user: HL_WALLET }` → pending limit orders

### Binance USDM Futures
- **Base URL**: `https://fapi.binance.com`
- **Auth**: HMAC-SHA256 signed requests. Append `timestamp` + `signature` to every private request. Pass `X-MBX-APIKEY` header.
- **Signing**: `HMAC-SHA256(queryString, BINANCE_API_SECRET)` — see `binanceSign()` in `lib/binance-client.js`
- **Endpoints used**:
  - `GET /fapi/v2/account` → equity, margin used, available balance
  - `GET /fapi/v2/positionRisk` → all open positions with mark price, liq price
  - `GET /fapi/v1/premiumIndex` → funding rates (public, no auth needed)
  - `GET /fapi/v1/openOrders` → pending orders (signed)

### All endpoints
| Route | Purpose | Detail in |
|---|---|---|
| `GET /api/dashboard?fresh=1` | positions, orders, margin — the 15s poll; `fresh=1` skips the 10s shared snapshot | below |
| `GET /api/volstops?risk=&k=` | volatility-adjusted stops, hedge health, regime | *Dynamic Stop Width* |
| `GET /api/riskbook?fresh=1` | cross pools, calibration, stress inputs, depth, taker rates, ADL; `noMark` rows for assets without a usable mark | *Cross-Pool Stress Simulator* |
| `GET /api/deleverage?objective=&target=&maxLoss=&fee=&breakHedges=` | unwind plan per pool; without `fee`, the account's taker rate (`plans[].fee`) | *Unwind planner* |
| `GET /api/performance?days=N&tz=M&session=S` | journal: trip and hedge-unit statistics with intervals, the window before, the daily account series with return, drawdown, Sharpe and beta (a trip curve under a session), streaks against chance, records, habits, sizing, month/hold/side, `timing` (calendar, weekday, hour, grid), `symbols` (rows, rest, concentration), `costs` (summary and the window before, fee check, BNB discount, weekly, maker trend, by symbol, wallet ledger with checks), `openLegCheck` (rebuilt open legs against Binance's at the last sync), periods, wallet and account curves. `zone=` (IANA name) sets the reader's clock, `tz=` is the fallback offset | *Performance* and *Behaviour* in `journal.md` |
| `GET /api/trips?days=N` | every closed round trip with size, costs, funding, price path and market at entry, plus context coverage | *Trades* in `journal.md` |
| `GET /api/goals?zone=&tz=M` | goals scored from their set date, ordered broken → in progress → kept → paused; today's line; suggestions | *Goals* in `goals.md` |
| `GET /api/goals/preview?type=&params=&session=&tz=M` | what a goal would have scored on all history — the add drawer's preview | *Goals* in `goals.md` |
| `POST /api/goals?zone=&tz=` | `{ action: add\|edit\|pause\|resume\|delete, … }`; JSON only; a date is checked against the reader's clock | *Goals* in `goals.md` |
| `GET /api/factors?days=N&session=S&zone=&tz=M` | factors known at entry, each bucket against the rest: average net and win rate with intervals, the rows that stand out, during-trade behaviour apart | *Factors* in `journal.md` |
| `POST /api/annotations` | `{ key, note, tags }` — your note and tags on a closed trip; an empty note with no tags removes them; JSON only. Read back on `/api/trips` | *Notes and tags* in `journal.md` |
| `GET /api/funding` | the open book's funding: rows worst first with hedged pairs netted, each leg's estimated rate, interval, cap distance and 7-day usual rate, totals, the next settlement, realised from the ledger up to the last sync with `coveredDays`, and `differsFromEstimate` against the Binance estimate (`estimatePerDay`), null under a day of ledger. Rate history is cached an hour per symbol | *Funding* in `frontend.md`; mechanics in `research/funding.md` |
| `GET /api/hedgeledger` | locked hedge PnL, carry, margin inflation | *Hedge ledger* |
| `GET /api/history/sync` | sync progress, store stats and meta; never starts one | *history-store* |
| `POST /api/history/sync` | `{ full?: true }`; starts a sync when idle, returns progress; JSON only | *history-store* |
| `GET /api/confluence?symbol=&tfs=&session=` | signals, regime, scores and track records per timeframe | *Confluence* |
| `GET /api/symbols` | trading USDM perpetuals, for the confluence picker | *Confluence* |
| `GET /api/health` | ban state, request weight, order-stream age and drift, snapshot ages, sync — one `ok`/`warn`/`bad` verdict with reasons; no exchange calls | *Operations* |
| `GET /api/venues` | per venue: enabled, configured, snapshot age | *Venue switch* |
| `POST /api/venues` | `{ venue, enabled }` — switch a venue on or off; JSON only | *Venue switch* |
| `GET /calc-engine.js` | the calculators' arithmetic, served to the browser | *Calculators* in `frontend.md` |
| `GET /sessions.js` | trading-session definitions, served to the browser for the clock | `sessions.md` |
| `GET /risk-engine.js` | the engine module, served to the browser | *Cross-Pool Stress Simulator* |

Everything except `/api/dashboard` and `/api/volstops` is Binance-only. `/api/confluence` uses public
endpoints only and works for any USDM perpetual, held or not.

### Single dashboard endpoint
```
GET /api/dashboard
```
Returns unified JSON:
```json
{
  "ok": true,
  "lastUpdated": "ISO timestamp",
  "venues": { "binance": true, "hyperliquid": false },
  "summary": {
    "totalEquity", "totalUpnl",
    "positionCount", "orderCount",
    "hlExposure", "bnExposure", "totalExposure",
    "partial": ["hyperliquid"]          // venues whose read failed: their figures are left out
  },
  "hyperliquid": {
    "equity", "marginPct", "marginUsed", "freeMargin",
    "totalNtlPos", "accountLeverage",
    "positions": [...],
    "orders": [...]
  },
  "binance": {
    "equity", "walletBalance", "marginPct", "marginUsed", "freeMargin", "maintMargin",
    "assets": [{ "asset", "collateral", "wallet", "marginBalance", "unrealizedProfit",
                 "availableBalance", "usdPrice", "usdValue" }],
    "positions": [...],
    "orders": [...]
  }
}
```

`venues` says which exchanges are switched on; an exchange that is off returns an empty
book (zero equity, no positions or orders) — see *Venue switch* in `operations.md`.

**Binance totals are summed across collateral assets.** In single-asset mode Binance's
`total*` fields and `availableBalance` cover USDT only, so a USDC pool would be missing
from equity, margin used, maintenance and free margin. With multi-assets mode off,
`lib/binance-account.js` sums the per-asset rows instead (USD stables only, valued at the
`<ASSET>USDT` mark, else 1). In multi-assets mode the totals are already USD across assets
and are used as reported. `assets` lists every asset with a balance; `collateral` marks the
ones counted.

---

## Position data shape
Each position object (both exchanges, normalised — no realizedPnl):
```js
{
  pair:        "BTC-PERP" | "BTC/USDT",
  type:        "perpetual" | "futures",
  side:        "Long" | "Short",
  leverage:    "5×",
  size:        "0.12 BTC",
  sizeUsd:     7476.00,
  entry:       62400.00,
  mark:        62300.00,
  liqPrice:    54100.00,
  upnl:        -12.00,
  fundingRate: 0.012,         // raw % per settlement, e.g. 0.012 = 0.012%
  fundingIntervalHours: 8,    // 8, 4 or 1 on Binance (checked against the next settlement's hour); 1 on Hyperliquid
  prevDayPx:   61000.00,      // Hyperliquid's previous day price; 0 on Binance
  exchange:    "hyperliquid" | "binance"
}
```
Hyperliquid positions also carry `coin`. Binance positions additionally carry the fields the
stress engine needs: `asset`, `quote`, `symbol`, `positionSide`, `sizeRaw` (signed float —
`size` is a display string), `leverageRaw`, `isolated`, `isolatedWallet`, `reportedMm`,
`reportedIm`, `reportedLiqPrice`, `nextFundingTime`, `adlQuantile` (1–4, Binance's ADL queue).
`binance.walletBalance` on `/api/dashboard` is the wallet without unrealised PnL; `equity` is
the margin balance. On `/api/dashboard` every position also carries `hasStop` — whether a closing `Stop…` order
protects the leg (the rule in `docs/stops.md`) — and `stopKnown`. When a venue's stop orders
could not be read, its block has `stopsKnown: false` and each of its positions `stopKnown: false`,
`stop: null`, `hasStop: null`: unknown, never "no stop". That read is not cached, so the next
request tries again. Each venue block carries `error` (null when read): one venue failing
leaves the other on screen and lists it in `summary.partial`; both failing is a 500. A failed
Binance mark-price read fails the Binance read, since collateral is priced from it.

## Order data shape
Each order object (both exchanges, normalised):
```js
{
  pair:       "BTC-PERP" | "BTC/USDT",
  side:       "Buy" | "Sell",
  type:       "Limit" | "Stop market" | ...,
  price:      62000.00,
  size:       "0.1 BTC",
  reduceOnly: false,
  exchange:   "hyperliquid" | "binance"
}
```
Binance orders additionally carry `asset`, `quote`, `symbol`, `positionSide`, `sizeRaw`,
`stopPrice` (the trigger, or null), `closePosition`, and for trailing stops `activatePrice` and
`callbackRate`.
