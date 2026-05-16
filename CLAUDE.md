# Crypto Portfolio Dashboard — CLAUDE.md

## Project overview
Unified real-time portfolio dashboard for **Hyperliquid** and **Binance USDM Futures** open positions, open orders, account info, and risk/funding analytics. Node.js Express backend + vanilla HTML/CSS/JS frontend. No database. No framework.

---

## Project structure
```
crypto-dashboard/
├── server.js          # Express backend — all API fetching, signing, data normalisation
├── package.json       # Dependencies: express, dotenv
├── .env               # Secret credentials (never commit this)
├── .env.example       # Credential template
├── README.md
└── public/
    └── index.html     # Entire frontend — rendering, polling, styles (single file)
```

---

## Running the project

```bash
npm install          # first time only
npm start            # production
npm run dev          # development with auto-restart (node --watch)
```

Server runs on `http://localhost:3000` (or `$PORT` env var).

---

## Environment variables (`.env`)

| Variable | Description |
|---|---|
| `BINANCE_API_KEY` | Read-only Binance API key |
| `BINANCE_API_SECRET` | Binance API secret (HMAC signing) |
| `HL_WALLET_ADDRESS` | Hyperliquid public wallet address (`0x...`) |
| `PORT` | Optional, defaults to 3000 |

Never log or expose these. Never commit `.env`.

---

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
- **Signing**: `HMAC-SHA256(queryString, BINANCE_API_SECRET)` — see `binanceSign()` in `server.js`
- **Endpoints used**:
  - `GET /fapi/v2/account` → equity, margin used, available balance
  - `GET /fapi/v2/positionRisk` → all open positions with mark price, liq price
  - `GET /fapi/v1/premiumIndex` → funding rates (public, no auth needed)
  - `GET /fapi/v1/openOrders` → pending orders (signed)

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
    "positions": [...],
    "orders": [...]
  },
  "binance": {
    "equity", "marginPct", "marginUsed", "freeMargin", "maintMargin",
    "positions": [...],
    "orders": [...]
  }
}
```

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

---

## Frontend (`public/index.html`)

Single file — HTML + CSS + JS, no build step, no framework.

- Polls `GET /api/dashboard` every **15 seconds** via `setInterval`
- Manual refresh button triggers `fetchData()` immediately
- Dark mode via `prefers-color-scheme` media query with CSS variables
- `lastData` cached globally so view toggles re-render instantly without re-fetching

### Key JS functions
| Function | Purpose |
|---|---|
| `fetchData()` | Fetches API, calls `render(data)` |
| `render(data)` | Builds metric tiles, positions/orders section, insights, widgets |
| `setView(v)` | Switches `posView` ∈ `{'tiles','list','orders'}`, updates tab active state, re-renders |
| `renderPositions(positions)` | Delegates to tile or list view based on `posView` |
| `renderPositionTiles(positions)` | Grid of position cards (default view) |
| `renderOrdersFor(orders)` | Table of open orders for one exchange |
| `renderInsights(hlPos, bnPos)` | Visual risk card grid — one card per position |
| `renderWidgets(data)` | Margin health donuts + daily funding cost bars |
| `fmt(n, d)` / `fmtUsd(n)` / `fmtPnl(n)` | Number formatting helpers |
| `liqDist(p)` | `abs(mark - liqPrice) / mark * 100` — liquidation distance % |

### Metric tiles (top row)
1. **Total equity** — with HL / BN breakdown
2. **Unrealised PnL** — with HL / BN breakdown
3. **Open positions** — count with HL / BN breakdown
4. **Open orders** — count with HL / BN breakdown
5. **Gross exposure** — notional USD with HL / BN breakdown

### 3-way view toggle (Tiles | List | Orders)
- Default: **Tiles**
- `setView(v)` updates `posView`, toggles `.active` class on `.view-tab` buttons, re-renders via `render(lastData)`
- Orders view shows per-exchange order tables (pair, side, type, price, size, reduce-only)

### Risk & funding overview (visual cards)
`renderInsights()` produces `.rvc-grid` of cards, sorted by proximity to liquidation:
- **Danger bar**: fills toward 100% as position approaches liq (`barWidth = 100 - dist`, capped 0–100)
- Bar color: red < 10%, amber < 30%, green ≥ 30%
- Shows: notional, entry/current, liq price, uPnL, rate/8h, daily cost

### Margin health (donut charts)
CSS `conic-gradient` donuts showing margin utilisation % for HL and BN side-by-side.
Color: red > 80%, amber > 50%, exchange color otherwise.

### Daily funding cost chart
Horizontal bar chart — one row per position, bar width proportional to daily cost vs max.
Green = receiving funding, Red = paying funding.

---

## CSS variables / theming
```css
--hl: #7f77dd        /* Hyperliquid purple */
--bn: #ef9f27        /* Binance amber */
--success: #1d9e75   /* green */
--danger:  #e24b4a   /* red */
--warning: #ba7517   /* amber */
```
Dark mode overrides via `@media (prefers-color-scheme: dark)`.

Key layout classes: `.metric-grid`, `.metric .breakdown`, `.b-row`, `.view-tabs`, `.view-tab`, `.pos-tile-grid`, `.pos-tile`, `.rvc-grid`, `.rvc`, `.donut`, `.donut-hole`, `.fviz-row`, `.two-col`, `.card`.

---

## Known gaps / not yet implemented

- **Binance spot** — only USDM futures; spot endpoint is `/api/v3/openOrders`
- **PnL history / charts** — no time-series data stored
- **WebSocket streaming** — currently REST polling; could switch to HL WebSocket (`wss://api.hyperliquid.xyz/ws`) and Binance user data stream for lower latency
- **Authentication** — no login; assumes private/local deployment
- **Alerts** — liq proximity warnings visible in risk cards but no push/sound alerts

---

## Deployment notes

- **Local**: `npm start` → `http://localhost:3000`
- **Railway / Render**: push to GitHub, add env vars in dashboard, deploy
- **VPS**: use `pm2 start server.js --name dashboard`
- The app serves `public/index.html` as a static file — no separate frontend deployment needed

---

## Coding conventions

- ES Modules (`import`/`export`) — `"type": "module"` in `package.json`
- No TypeScript, no transpilation, no build step
- All async functions use `async/await`, errors surfaced to `/api/dashboard` as `{ ok: false, error: "..." }`
- Keep all exchange-fetching logic in `server.js` — frontend only renders, never calls exchanges directly
- Backend sends raw floats/numbers; format at render time in the frontend
- `parseFloat()` everywhere on exchange API responses — they return strings
- Funding rate math: `(side === 'Long' ? -1 : 1) * (fundingRate / 100) * sizeUsd` — positive result = paying out
- Null/absent data: return raw `null` from backend, render as `"—"` in frontend via `fmtPnl(null)` → NaN → `"—"`
