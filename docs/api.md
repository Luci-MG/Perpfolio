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
| `GET /api/dashboard` | positions, orders, margin — the 15s poll | below |
| `GET /api/volstops?risk=&k=` | volatility-adjusted stops, hedge health, regime | *Dynamic Stop Width* |
| `GET /api/riskbook` | cross pools, calibration, stress inputs, depth, ADL | *Cross-Pool Stress Simulator* |
| `GET /api/deleverage?objective=&target=&maxLoss=&fee=&breakHedges=` | unwind plan | *Unwind planner* |
| `GET /api/performance?days=N` | journal: round trips, breakdowns, equity curve | *Account history* |
| `GET /api/hedgeledger` | locked hedge PnL, carry, margin inflation | *Hedge ledger* |
| `GET /api/history/sync?start=true&full=true` | starts a history sync, returns progress | *history-store* |
| `GET /api/confluence?symbol=&tfs=` | signals, regime, scores and track records per timeframe | *Confluence* |
| `GET /api/symbols` | trading USDM perpetuals, for the confluence picker | *Confluence* |
| `GET /api/health` | ban state, request weight, order-stream age and drift, snapshot ages, sync — one `ok`/`warn`/`bad` verdict with reasons; no exchange calls | *Operations* |
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
  "summary": {
    "totalEquity", "totalUpnl",
    "positionCount", "orderCount",
    "hlExposure", "bnExposure", "totalExposure"
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
  fundingRate: 0.012,         // raw %, e.g. 0.012 = 0.012%
  funding8h:   "+0.0120%",    // formatted string with sign
  exchange:    "hyperliquid" | "binance"
}
```
Binance positions additionally carry the fields the stress engine needs:
`asset`, `quote`, `symbol`, `positionSide`, `sizeRaw` (signed float — `size` is a display
string), `isolated`, `isolatedWallet`, `reportedMm`, `reportedLiqPrice`.

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
Binance orders additionally carry `asset`, `quote`, `symbol`, `positionSide`, `sizeRaw`.
