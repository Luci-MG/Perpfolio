# Crypto Portfolio Dashboard — CLAUDE.md

## Project overview
Real-time portfolio dashboard and risk workbench for **Binance USDM Futures** (plus a
read-only **Hyperliquid** view). Node.js Express backend + a single vanilla HTML/CSS/JS file.
No framework, no build step, no dependency beyond express/dotenv/ws.

Not a database, but not stateless either: account history is cached locally as append-only
NDJSON in `data/` (gitignored) because Binance serves income for only three months and fills
only through cursor paging.

The book this was built against is a hedged one — same-symbol long and short on several
symbols, cross margin, high leverage — and much of the design exists because that book breaks
the naive version of each calculation.

### Where things are
| Area | Doc section | Code |
|---|---|---|
| Live positions, orders, margin | *API architecture*, *Frontend* | `server.js`, `public/index.html` |
| Volatility-adjusted stops | *Dynamic Stop Width* | `vol-estimator.js` |
| Stress / liquidation / unwind maths | *Cross-Pool Stress Simulator* onward | `risk-engine.js` |
| Trade history and journal | *Account history, journal and hedge ledger* | `history-store.js`, `trade-analytics.js` |
| Market confluences for one coin | *Confluence* | `confluence.js` |
| Things that bit us | *Order cache*, *Latency*, *Conditioning*, *Ray sampling* | — |
| Request quota per route and tab | *API budget* | — |
| Latest review: fixes and roadmap | *Review 2026-09-29* | — |

**Read before changing anything numeric:** the calibration rules in *Endpoint:
`GET /api/riskbook`*. Every margin figure is scored against Binance's own reported numbers on
every request, and the UI is expected to say so rather than assert correctness.

---

## Project structure
```
crypto-dashboard/
├── server.js          # Express backend — all API fetching, signing, data normalisation
├── risk-engine.js     # Cross-pool stress engine (pure math, shared with the browser)
├── risk-engine.test.js
├── history-store.js   # Append-only NDJSON cache for account history
├── history-store.test.js
├── trade-analytics.js # Round-trip reconstruction and performance statistics
├── trade-analytics.test.js
├── data/              # Cached income + fills (gitignored)
├── vol-estimator.js   # Composite volatility engine for dynamic stops
├── confluence.js      # Market signals per timeframe, regime-gated, self-calibrating
├── confluence.test.js
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
npm test             # node --test — 141 tests across five modules, no dependencies
```

First run of the Journal needs a history build: open the **Journal** tab and press
**Sync recent**, or `curl "localhost:3000/api/history/sync?start=true&full=true"`. The full
build takes about a minute for a book with a few months of activity; afterwards a
routine sync is ~10s because it only touches symbols traded in the last 7 days.

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

---

## Frontend (`public/index.html`)

Single file — HTML + CSS + JS, no build step, no framework.

- Polls `GET /api/dashboard` every **15 seconds** via `setInterval` — skipped while the tab is
  hidden (and re-fetched on return), and never two at once (`pollInFlight`)
- Manual refresh button triggers `fetchData()` immediately
- A failed poll keeps the last good figures on screen and says `Stale — last good HH:MM`
  rather than blanking the status line
- The view, the confluence symbol and its timeframes are remembered per browser
  (`loadPref`/`savePref`, `localStorage` under `dash:*`, every access wrapped so a blocked
  store simply falls back to the defaults)
- Below 900px wide the sidebar stacks under the main column
- Dark mode via `prefers-color-scheme` media query with CSS variables
- `lastData` cached globally so view toggles re-render instantly without re-fetching

### Key JS functions
| Function | Purpose |
|---|---|
| `fetchData()` | Polls `/api/dashboard`, calls `render(data)` |
| `render(data)` | Rebuilds main column + sidebar; **leaves a mounted panel alone** (see below) |
| `setView(v)` | Switches `posView`, lazily fetches that tab's data |
| `renderPositions` / `renderPositionTiles` / `renderOrdersFor` | Tiles, list and order tables |
| `renderMarginHealth(data)` | Sidebar SVG arc gauges for HL and BN margin use |
| `renderSidebarBottomRow(data)` | Funding widget + `renderCalcTiles()` icon block |
| `renderCalcTiles()` | The 3×2 icon grid: three calculators + three drawers |
| `fmt` / `fmtUsd` / `fmtSignedUsd` / `fmtPrice` / `fmtPnl` | Number formatting |
| `liqDist(p)` | `abs(mark − liqPrice) / mark × 100` |

`esc()` escapes anything interpolated into markup from user input or an exchange/server
string — attributes, titles and error messages.

`fmtPnl` renders a negative as a red `$X` with **no minus sign** — colour carries the sign.
That is fine for a PnL column and wrong for anything where the sign is the point, which is
why `fmtSignedUsd` exists. `fmtPrice` scales decimals to the price magnitude; `fmtUsd` is
always 2dp and turns a 1e-5 asset into `$0.00`.

### View tabs — eight
`posView` ∈ `tiles | list | orders | stops | stress | unwind | journal | confluence`, default `tiles`.
`setView(v)` fetches on activation only: `stops` → `/api/volstops`, `stress` → `/api/riskbook`,
`unwind` → `/api/deleverage`, `journal` → `/api/performance`, `confluence` → `/api/confluence`. The
first four share the positions card; the last four replace it and hide the HL/BN filter and exchange header.

**The mounted-panel rule.** The 15s poll calls `render()`, which would rebuild the whole main
column — destroying a slider mid-drag or an input mid-edit. `render()` therefore leaves the
panel alone whenever its mount marker (`#st-mounted`, `#uw-mounted`, `#cf-mounted`,
`#vs-mounted`) is present, unless
`rerenderStress()` set `riskForceRender`. Every deliberate rebuild goes through that helper.

### Sidebar
Top to bottom: `metric-stack` (total equity, uPnL, exposure — each with HL/BN breakdown and a
click-through drawer), `renderMarginHealth()`, then `renderSidebarBottomRow()` — the daily
funding widget beside `renderCalcTiles()`.

**Margin health is an SVG arc gauge, not a donut.** The sweep never exceeds 180°, so the
arc's `large-arc-flag` must always be `0`; it was `pct > 50 ? 1 : 0`, which drew the 225°
complement and painted the fill out of the viewBox for every utilisation between 50% and
100% — exactly the range worth looking at. A `conic-gradient` survives elsewhere, for the
small long/short split donut only.

### Drawers
All at body level, outside `#sidebar`, so the poll's sidebar rebuild cannot wipe them:
`openUpnlDrawer` · `openExpDrawer` · `openFundDrawer` (pre-existing) and `openLiqDrawer` ·
`openSimDrawer` · `openHlDrawer` (this session). Each follows the same overlay + `.open`
class pattern.

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

**Grid overflow:** `.app-layout` uses `minmax(0, 1fr)` and `.main-col` carries `min-width: 0`.
A CSS grid track defaults to `min-width: auto`, so one wide table widens the track and pushes
content out under the sidebar rather than shrinking or scrolling. Any new wide element inside
a grid needs `min-width: 0` on its track.

Key layout classes: `.metric-grid`, `.metric .breakdown`, `.b-row`, `.view-tabs`, `.view-tab`, `.pos-tile-grid`, `.pos-tile`, `.rvc-grid`, `.rvc`, `.donut`, `.donut-hole`, `.fviz-row`, `.two-col`, `.card`.

`renderCalcTiles()` is the icon-button block beside the funding tile: a `repeat(3, 1fr)` grid
holding five tools and one reserved slot, two rows tall so it matches the funding tile's
height. A tile either carries `tab` (opens the calculator modal) or `action` (raw onclick,
used by the two drawers).

---

## Dynamic Stop Width (volatility-adjusted stops)

Composite volatility estimate that adapts stop distance + position size per open position. Dollar risk stays constant; stop width and size float with the regime.

### Module: `vol-estimator.js` (ESM)
Pure functions, no I/O. Layers (Phases 1–3 implemented; Kronos L5 not built):
- `computeATR(candles, 14)` — L1 base, ATR as % of close
- `getBBWAdjustment(candles, bbwHistory)` / `computeBBW` / `buildBbwSeries` — L2 squeeze multiplier
- `getFundingAdjustment(rate8h)` — L3 crowded-positioning multiplier (rate as fraction, e.g. 0.00012)
- `getCrossAssetAdj(btcCandles, assetCandles, btcAtrHistory)` / `buildAtrSeries` — L4 BTC→alt vol lead
- `computeCompositeVol({atrPct, bbwAdj, fundingAdj, crossAssetAdj, kronosVol})` — `atr × bbwAdj × fundingAdj × crossAdj`
- `classifyRegime(vol, volHistory)` → `low|medium|high|extreme` (relative percentile bands)
- `shouldTakeEntry(regime, strategy)` — entry gate
- `computeDynamicStop({entryPrice, accountSize, riskPct, compositeVolPct, k, regimeLabel, direction})` — stop/size engine.
  Stop and target are rounded relative to price magnitude (2→8 decimals); a flat 2-decimal
  round returns `0` for a 1e-5 asset and erases a sub-dollar one. The frontend renders them
  with `fmtPrice()` for the same reason.
- `assessHedgePair({x, y, longAsset, shortAsset, longNotional, shortNotional})` — correlation
  (72h vs 20d), beta of the short leg on the long leg, implied vs actual short notional,
  residual delta → `intact | degrading | broken | thin | unknown`
- `matchHedgeLegs(longs, shorts, dust)` — partitions net-long against net-short legs so each
  dollar is hedged once; returns the pairs plus the unmatched remainder
- `weightedSeriesMean(entries)` — notional-weighted mean of vol histories, aligned from the
  most recent element backwards
- `synthSeriesFromPosition(ctx)` — **backfill**: synthesizes a candle series from entry/mark/prevDayPx when real candles are unavailable

### Candle sourcing (`server.js`)
- Binance: `GET /fapi/v1/klines?symbol=&interval=1h&limit=200` (public)
- Hyperliquid: `POST /info {type:"candleSnapshot", req:{coin, interval:"1h", startTime, endTime}}`
- Fetched by **exchange symbol**, never by the normalised `pair` label — `baseAsset('ZEC/USDC')`
  cannot strip a non-USDT quote and would request `ZEC/USDCUSDT`, silently pushing every
  USDC-margined position onto synthetic candles
- Normalised to `{t, open, high, low, close, volume}` oldest→newest
- In-memory `candleCache` keyed `exchange:symbol`, 60s TTL, **merges** new candles into cached series so history grows across runtime (better BBW percentile + regime bands). Capped at 720 bars (~30d).

### Hedge health (in `/api/volstops` → `combined`)
**Correlation risk lives between assets, never within one.** The original check grouped
positions by base asset and compared an asset's long leg with its own short leg, so the
correlation was ~1.0 by construction and no warning could ever fire. The order it runs in
now matters:

1. **Net per asset.** Two legs of the same symbol collapse into a single delta — they
   cannot decorrelate from themselves. `nettedSymbols` reports these so it is clear they
   were considered, not skipped.
2. **Restate as BTC-equivalent** (`net × beta_vs_BTC`) so legs of different volatility can
   be compared on the same terms.
3. **Match into a partition** with `matchHedgeLegs`, largest legs first, so each dollar is
   hedged exactly once. An all-pairs cross product instead charges the same short notional
   against every long it happens to sit opposite — it produced "VIRTUAL long / ETH short:
   oversized by 1705%" for a small leg whose real counterparty was the BTC long.
4. **Assess correlation per matched pair** (72h against 20d, timestamp-aligned). Sizing is
   deliberately *not* a per-pair verdict; it is answered once, at book level, by the
   unmatched remainder.

`nakedBtcEquiv` (the unmatched remainder) and `betaAdjustedNet` (the sum of BTC-equivalent
deltas) are computed by independent paths and **must agree** — a standing cross-check on
the whole pipeline.

### Portfolio regime
`classifyRegime` is fed the portfolio's **own** vol history, built by `weightedSeriesMean`
over each position's `buildCompositeVolSeries`. Previously it was handed the cross-section
of the same positions it was measuring: under 10 positions the history was `[]` and the
function returned `'medium'` by its own guard, and at 10 or more a notional-weighted mean
of N values necessarily lands between their 25th and 75th percentiles — so the badge read
"Medium" for any book in any market. `regimeBasis` now exposes the bar count and the
percentile the current reading sits at, so the label is falsifiable.

### Endpoint: `GET /api/volstops?risk=&k=`
- `risk` = fraction (0.01 = 1%), `k` = stop multiplier (default 1.5)
- Account size = live exchange equity per position (auto)
- Returns `{ ok, params, combined, positions }`:
  - `combined`: `portfolioRegime` + `regimeBasis`, `portfolioVolPct`, `totalDollarRisk`,
    `totalEquity`/`hlEquity`/`bnEquity`, `regimeCounts`, `netByAsset`, `betaByAsset`,
    `rawNet`, `betaAdjustedNet`, `nakedBtcEquiv`, `nettedSymbols`, `hedgePairs`, `hedgeWarnings`
  - `positions[]`: stop/size fields + `regimeLabel`, `layers{atrPct,bbwAdj,fundingAdj,crossAdj,...}`, `backfilled[]` tags
- **Backfill rules** (never skip a position / never show `—`): missing candles → synthetic series (tag `candles`); missing funding → `1.0` (tag `funding`); no BTC candles → cross `1.0` (tag `crossAsset`); short BBW/regime history → neutral + tags; missing equity → total equity / exposure fallback (tag `equity`). Per-position try/catch so one failure can't break the panel.

### Frontend (`public/index.html`)
- 4th view tab **Stops** (`posView==='stops'`); `fetchVolStops()` runs only when the tab is active (not on the 15s poll) to limit candle API load
- `renderVolStops()` → `volControlsHtml()` (risk%/k inputs) + `renderVolCombined()` (combined panel) + grid of `renderVolTile()` per-position cards
- Reuses the HL/BN `exchFilter`; `setVolRisk()` / `setVolK()` re-fetch on change.
  `renderVolCombined` recomputes `$ risk`, equity and the regime spread from the *filtered*
  positions — the server's totals cover every venue and would disagree with the tiles
  below. `renderHedgeHealth` deliberately does not filter (a hedge spans the whole book)
  and is labelled as such.
- State: `volStopData`, `volRiskPct` (default 1.0), `volK` (default 1.5), `volLoading`
- Regime colors: low=success, medium=text2, high=warning, extreme=danger; `est` chip when `backfilled[]` non-empty

---

## Cross-Pool Stress Simulator (Binance USDM)

Interactive what-if on the Binance cross-margin pool: move any coin's price and watch
the shared collateral pool drain, with markers showing the exact price at which the pool
is exhausted and liquidation begins. Hyperliquid is deliberately out of scope — it is an
independent pool with an independent liquidation event.

### Module: `risk-engine.js` (ESM)
Pure functions, no I/O. **Shared verbatim with the browser** (served at `/risk-engine.js`),
so the panel and the API cannot disagree.

- `pickTier(brackets, notional)` / `maintMargin(notional, tier)` — `notional × mmr − cum`
- `upnl(pos, price)` — signed size, linear USDT contract
- `initialMargin(pos, price)` — `notional / leverage` (the position's own leverage setting)
- `evalPool(pool, prices, opts)` → `{ equity, mm, buffer, marginRatio, usedPct, liquidated, positions[] }`
- `netDeltas(pool, prices)` — signed USD delta per asset
- `applyStops(pool, from, to)` → `{ pool, fired[] }` — reduce-only triggers crossed on the path
- `scanRay(pool, base, dir, opts)` → `{ breachLambda, breachPrices, minBuffer, samples }`
- `killPrices(pool, asset, base, opts)` → up/down threshold price + `minBufferUp/Down`;
  `opts.metric` selects `'buffer'` (liquidation, default) or `'free'`
- `killPricesBoth(pool, asset, base, opts)` → both thresholds, walking each direction once
- `rayCap(dir, opts)` — how far a ray may run before some price would reach zero
- `freezeTiers(pool, prices)` / `crossesTier(pool, asset, prices, price)` — the
  exchange-style frozen-tier reading, and whether a threshold crosses a bracket
- `liquidationAfterCloses(pool, prices, closes, opts)` — per-asset liquidation before and
  after a set of closes, with the room gained and which assets stopped existing
- `liquidationDetail(...)` — the solve plus its conditioning (see *Conditioning*)
- `alignedReturns(a, b)` — returns paired on equal timestamps
- `drainPer1Pct(pool, asset, base)` — buffer cost of a ±1% move
- `scenarioDir(pool, mode, {betas, sign, prices})` — `uniform` | `adverse` | `btcBeta`
- `cascade(pool, prices)` — force-close largest-MM-first until solvent
- `closePositions(pool, prices, closes, feeRate)` → `{ pool, realized, notionalClosed, fees }`
- `grossNetDelta(pool, prices)` — Σ|net delta| per asset
- `deleverageCeiling(pool, prices, opts)` / `deleverageCandidates(…)` / `deleveragePlan(…)`
- `beta`, `stdev`, `dailySigmaPct` — market stats (reuses
  `computeReturns` from `vol-estimator.js`)

### The math
```
notional_i = |q_i| × P
upnl_i     = q_i × (P − entry_i)
tier_i     = bracket containing Σ|notional| over the symbol   (both hedge legs)
mm_i       = max(0, notional_i × mmr − cum)                   (MMR/cum applied PER leg)
im_i       = notional_i / leverage_i
equity     = crossWalletBalance + Σ upnl_i
buffer     = equity − Σ mm_i                → liquidation at buffer ≤ 0
free       = equity − Σ im_i − freeReserved → no capacity to open or transfer at free ≤ 0
```
Two thresholds, one scan primitive. **Free margin is hit well before liquidation** and is
the number that governs whether a position can be opened or collateral transferred out.

### Per-leg `cum`, and why the exchange's own liq price differs
Two questions only bite above tier 1, and both are settled empirically:

- **`cum` is deducted per leg, not per symbol.** One hedged symbol's combined notional sits in a
  `cum = 100` tier: per-leg reproduces the reported maintenance margin to 0.0000%,
  per-symbol is off by 9.0%. A book entirely inside tier 1 (`cum = 0`)
  cannot test this — a 0% maintenance-margin match there proves nothing about `cum`.
- **The engine re-tiers; the exchange's published `liquidationPrice` does not.** Binance
  computes maintenance margin as `notional × MMR(at the level of position notional) −
  maintenance amount(at that level)`, so its live engine re-tiers as notional moves, but
  the liquidation price it publishes freezes the tier at the current notional. Where a
  threshold crosses a bracket the two legitimately differ — 1.33% on one symbol, re-tiered
  against frozen. `freezeTiers` reproduces the published figure to **0.000%**,
  which is what validates the arithmetic; the re-tiered figure is what should actually
  happen, so it is the one shown, annotated `· exch <price>`.

`freeReserved` covers the price-invariant holds — open-order initial margin plus anything
else the exchange withholds — and is **anchored** by the server to the reported
`availableBalance` rather than guessed: `freeReserved = equity(marks) − im(marks) − availableBalance`.
Order margin is locked at each order's own price, so it does not move with the marks. The
price-varying half (`im_i = notional/leverage`) is modelled exactly and checked separately
against the reported `positionInitialMargin`, so the anchor cannot mask a simulation error.
Observed live: per-position initial margin reproduces `notional/leverage` to 8 decimals,
and the residual hold came within a few percent of the reported open-order margin.
Maintenance margin is **non-linear in price** (notional crosses bracket tiers), so every
threshold is found by scanning a price ray and bisecting the first breach — never by an
analytic solve. Along a ray the buffer is concave (it can rise before it falls), so
bisection anchored at the far end can return the wrong root.

### Ray sampling — four things it has to get right
1. **Fine near the mark, coarse far out**: 0.25% steps to ±30%, then 1% steps. Between the
   discontinuities in 3 and 4 the buffer is concave and free margin linear, so a coarse grid
   cannot skip a crossing; bisection then refines to ~1e-9.
2. **Range bounded by price positivity, not a magic number**: `rayCap` runs a downside ray
   to −99.9% and an upside ray to +300%. An earlier fixed ±90% cap made the engine report
   BTC as "unreachable" when Binance's own liquidation price sat at −92.7%.
3. **Trigger prices sampled explicitly** when `honorStops` is on. A firing take-profit
   removes that leg's maintenance margin, so the buffer jumps *upward* discontinuously —
   the one place concavity breaks. Without sampling the approach to each trigger a breach
   can sit entirely between two grid points and the scan reports the later, more
   flattering one. Regression-tested: a breach at 110.10 masked by a stop at 110.20 was
   previously reported as 111.29.
4. **Bracket floors sampled explicitly** (`tierBreakpoints`). The tier is picked from the
   symbol's *combined* notional but `cum` is subtracted *per leg*, so when a hedge crosses a
   floor its maintenance margin **drops** and the buffer jumps upward — concavity breaks
   there too. Found in the 2026-09-29 review: long 230 / short −250 at 100, a true breach at
   104.15 (+4.15%) was reported at 106.38 (+6.38%), the flattering later crossing. Floors
   are solved in closed form along the ray (notional is linear in λ) for the combined basis,
   or per leg in per-side mode, and λ just below and at each is scanned.

### Pools are per collateral asset
With `multiAssetsMargin: false` (the default), **each margin asset is its own cross pool**.
A USDC-margined contract (e.g. `ZECUSDC`) is backed by the USDC wallet alone — a USDT
balance of any size is no protection. `buildPools()` groups by quote asset and reads each
pool's collateral from `account.assets[]`. Multi-assets mode collapses them into one pool
and raises a banner, since collateral haircuts are not modelled.

### Endpoint: `GET /api/riskbook`
Returns `{ ok, pools[], account, isolated[] }`. Each pool carries `pool` (engine shape),
`marks`, `opts`, `stats` (beta/σ/bars per asset), `state` (equity/mm/im/free/buffer),
`baseline` (liquidation and free-margin thresholds, σ, buffer and free drain per 1%, net
delta — sorted nearest-kill first), `hedgedSymbols`, `calibration`, `liqCheck`. The frontend
simulates locally from this payload.

- Brackets from `GET /fapi/v1/leverageBracket` (signed), cached 24h. If unavailable, the
  rate is inferred from the reported per-position maintenance margin with `cum = 0` and
  the pool is tagged `estimatedBrackets`.
- Beta uses `alignedReturns`, which pairs candles on equal timestamps. Slicing series tails
  by recency silently pairs different hours whenever one symbol's cache is staler.
- Reduce-only orders feed the stops path. `closePosition` orders carry quantity 0 on the
  exchange and close whatever is left, so they are flagged rather than filtered out by a
  `q > 0` test. The WS path needs both halves of that: `PARTIALLY_FILLED` updates `sizeRaw`
  rather than just the display string, and the synthetic order rebuilt from
  `ORDER_TRADE_UPDATE` carries `closePosition: o.cp` — without it, a close-position stop
  placed while the server is running is honoured only after a restart, so the same book
  gives two different kill prices.
- **Calibration is a feature, not a test.** Binance reports `maintMargin` per position and
  `marginBalance` per asset; every response scores the model against both, picks the
  tier-lookup mode (`combined` vs `perSide`) that reproduces the exchange, and the UI shows
  a red banner instead of plausible-looking fiction when `trustworthy` is false.
  Verified live: maintenance margin, initial margin (`imErrPct` — the check that matters
  for free margin), equity and free margin all at **0%**, and `liqCheck` reproduced every
  published `liquidationPrice` to **0.000%** on the frozen-tier reading. Binance sometimes
  publishes an absurd sentinel (~8.2e8) for a position it considers unreachable;
  `reportedLiq()` filters it, and `modelSaysUnreachable` reports the engine's own verdict
  separately so agreement and disagreement stay distinguishable.

### Frontend (`public/index.html`)
5th view tab **Stress** (`posView === 'stress'`), fetched on activation only.
`fetchRiskBook()` dynamic-imports `/risk-engine.js`.

- `renderStress()` → banner + controls + `renderStressPool()` per pool (pool header,
  `renderStressRow()` per asset, `renderScenarioTable()`)
- `updateStress()` patches individual DOM nodes on every slider frame — it must **never**
  call `render()`, which rebuilds the whole dashboard and the hedge-thread SVG.
  rAF-coalesced; ~11ms per frame, ~22ms for a full render. `walkRay` finds both thresholds
  in a single pass per direction — scanning them separately cost 15ms/frame.
- The 15s dashboard poll must **not** rebuild this panel: replacing the markup mid-drag
  destroys the slider being dragged. `render()` leaves the panel mounted whenever
  `#st-mounted` exists, unless `rerenderStress()` set `riskForceRender` — so every
  deliberate rebuild (fetch, toggle, range, reset, link) goes through that helper and the
  poll only refreshes `#st-age`. A `Refresh marks` button re-reads the book.
- Assets whose positions have closed are pruned from `riskShift`/`riskLink`/`riskBeta` on
  each fetch; otherwise a closed asset keeps dragging the beta chain and forcing the
  range open.
- State: `riskBook`, `riskShift` (asset → % move, kept as percentages so a book refresh
  preserves the scenario), `riskLink` (beta chain membership), `riskBeta`, `riskRange`
  (auto-opened to the tier containing the nearest kill), `riskHonorStops`, `riskStressCorr`
- Beta linking: dragging a linked asset sets a driver in BTC terms and moves every other
  linked asset by `driver × beta`. Unlinked assets move alone (manual what-if).
- Range (30/50/80/120%) **only ever grows**, and only when a shift would not fit — so a
  thumb never misreports the real move. `afterStressChange` must not recompute the
  smallest tier that fits: that discards a range the user picked, snapping ±50% back to
  ±30% on the next nudge of any slider. `riskRangeExplicit` likewise stops a marks refresh
  from overwriting a chosen range. Shrinking belongs to Reset alone, which clears the flag
  and re-fits to the nearest kill.
- Two marker pairs sit on the slider track: red ▲▼ for liquidation, amber △▽ for free
  margin hitting zero. Off-range markers pin to the edge at 45% opacity. A direction that
  cannot reach a threshold reports the worst value it would leave.
- Pool header shows collateral, equity, maintenance margin, buffer, **free margin** and
  pool-used %. Each row shows both thresholds per direction plus `per +1%` sensitivity for
  buffer and free margin together.
- Scenario table: uniform ±, adverse basket, BTC ± × beta — each showing where free margin
  runs out, where liquidation hits raw and with reduce-only stops honoured, plus a `snap`
  button that moves every slider to that kill. When **with stops is worse**, a take-profit fires on a hedge leg first and
  leaves the remaining side naked.
- Cascade appears automatically when the current state is liquidated (no toggle) —
  largest-MM-first, labelled approximate because Binance's ordering is not public.

### Limits stated in the UI
Mark price only (no basis blowout); no liquidation fees or slippage; stops-honoured is
path-dependent and applies each asset's crossings independently; betas come from 200×1h
candles and converge to 1 in a crash (hence the β→1 toggle); isolated positions are
excluded and listed separately. Two further gaps, documented rather than modelled: a
resting order that is **not** reduce-only would add exposure if it filled during the
shock, and `freeReserved` is anchored at fetch time, so the free-margin figure goes stale
when orders are placed or cancelled. Cascade ordering is a largest-maintenance-margin
heuristic because Binance does not publish its own.

## Unwind planner (Binance USDM)

Which positions to close, in what order, to free margin or restore liquidation buffer.

### What a close actually does
```
equity          unchanged   — realised PnL replaces unrealised one for one
free margin    += initial margin released
buffer         += maintenance margin released
gross exposure  changes by the leg's delta (down for a naked leg, UP for a hedge leg)
```
`closePositions` **must** credit realised PnL to collateral. Dropping a position without it
inflates equity by that position's loss — on a book carrying a large unrealised loss it reported
free margin five times the true figure. That is the first
thing the tests pin.

### The ceiling comes first
Free margin is `equity − initial margin − reserved`, and closing never changes equity, so
**free margin can never exceed `equity − reserved`** however much is closed.
`deleverageCeiling` reports it and `targetAboveCeiling` flags a request that no combination
of closes can satisfy — the honest answer to "how do I get to more free margin than I have equity" on any
book is that closing cannot do it.

### Where the margin actually is
A same-symbol hedge pays initial margin on **both** legs (verified: `notional/leverage` per
leg, no netting) while contributing no net delta. On this book three matched hedges hold
over 90% of the total initial margin at zero directional exposure, so the matched
portion is the whole optimisation.

### Exposure is a guardrail, not a tie-breaker
`allowBreakingHedges` defaults to **false**. Ranking by margin released and falling back to
unsafe closes when no safe one qualifies is how a planner ends up proposing to shut the
*profitable* leg of a hedge under a realised-loss cap: at a stressed mark it freed a little
buffer while leaving a large leg naked and liquidation at +5%. When constraints are mutually
unsatisfiable the planner takes no step and returns `blocked` with the reason, the loss the
cheapest exposure-neutral close would realise, and the gain it refused.

### Endpoint: `GET /api/deleverage`
`objective=free|buffer`, `target`, `maxLoss`, `fee`, `breakHedges`. Greedy, re-deriving
candidates against the evolving book each step so bracket tiers and part-closed legs are
accounted for. Returns `ceiling`, `before`/`after`, `steps[]` (with legs, gain, `deltaShift`,
realised, cumulative), `blocked`, `remaining[]` and `thresholdsAfter[]`. Uses the tier mode
the stress calibration chose, so both endpoints agree on maintenance margin.
Only a realised **loss** is capped — taking a profit is never blocked.

### Frontend
6th view tab **Unwind** (`posView === 'unwind'`), fetched on activation. Same
mounted-panel guard as the Stress tab (`#uw-mounted`) so the 15s poll cannot rebuild the
panel and drop input focus mid-edit.

### Liquidation after close (sidebar drawer)
Close a subset of positions, get the liquidation price the **exchange** would then show for
everything left. Reached from the icon block in the sidebar (`renderCalcTiles`, scissors) →
`openLiqDrawer()` → `#liqDrawer`, computed client-side from `riskBook` so there is no second
code path.

Built on `liquidationPriceAnalytic`, a closed-form solve of `equity(P) = maintenanceMargin(P)`
with the asset's legs carrying `P` and every other position frozen at its mark:
```
A  = Σ_legs (q_l − |q_l|·mmr_l)
C  = WB + Σ_others (upnl_j − mm_j) − Σ_legs q_l·E_l + Σ_legs cum_l
P* = −C / A          A = 0, or P* ≤ 0  →  null (no positive price liquidates the book)
```
Two deliberate choices make it match what Binance publishes rather than what its live engine
does: the **margin tier is frozen** at the current notional, and the solve is **linear**, so
it does not clamp a leg's maintenance margin at zero the way a scan of the true non-linear
surface does. Binance's formula does not clamp either. `killPrices` over `freezeTiers` solves
the same definition by scanning, giving two independent implementations.

Verification, since the account is read-only and no position can actually be closed:
- **Against the exchange, live**: worst error **2.1e-8%** on every symbol checked —
  the same price to the last published digit. The panel recomputes this on every open and shows it as a badge,
  so the claim is checkable rather than asserted.
- **Against the ray scan**: agreement to 8e-11% across every leave-one-out close. The scan
  reports `none` where a threshold sits beyond its ±300% range (HYPE at +797%), which is
  why the analytic form is the primary.
- **Against the definition**: `equity == mm` to ~1e-11 at every price the tool reports,
  re-checked for each close in the drawer test.
- **Against Binance's published approximation** `Entry × (1 − 1/lev + mmr)`: agreement to
  first order for a single position collateralised at its own initial margin.

The insight the panel exists to surface: closing a position releases its maintenance margin,
which pushes every *other* asset's liquidation **further away**; only the symbol that loses a
hedge leg moves **closer**. Closing all longs on a hedged book took ETH from +135.7% to
+10.4% and HYPE from +797.5% to +22.0% while gaining room on everything else — the panel
raises a banner naming every asset that moved toward the mark.

### Unwind simulator (sidebar drawer)
The hand-driven counterpart to the tab: the tab computes an optimal plan, the drawer lets
you build one leg by leg. Reached from the icon block in the sidebar (`renderCalcTiles`,
sliders) → `openSimDrawer()` → `#simDrawer`, following the same overlay/drawer pattern as the
uPnL, exposure and funding drawers (so the 15s poll, which rebuilds the sidebar, cannot touch
it — the drawer lives at body level).

- Per symbol: `close long` / `close short` / `matched`, with a 0–100% slider. `matched`
  closes `min(|long|, |short|) × pct` on both legs, so the legs stay hedged against each
  other down to whatever is left.
- Presets: `TP the hedge longs`, `TP the hedge shorts`, `Close matched`, `Close everything`.
- Readout: free margin, buffer, realised, notional and fees, net delta **per coin** before
  → after, and gross exposure — the number that exposes an asymmetric unwind.
- **Then the market moves**: a ±50% slider applied to whatever is still open, reporting
  uPnL on the remainder, equity, buffer, free margin and the liquidation thresholds left.
  This is the point of the tool — closing one side of a hedge converts a flat book into a
  directional one, and the thresholds say how much room the remaining side has.
- `updateSimOutcome()` patches `#simOut` alone so that slider stays smooth; the rest of the
  body is rebuilt only on a selection change.
- State: `simSel` (symbol → {side, pct}), `simMove`. Fee rate is shared with the Unwind
  tab's `uwFee`.

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
A routine resync touches only symbols traded in the last 7 days plus anything open (~10s);
`?full=true` forces all of them.

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
- **Orphan fills are excluded, and counted.** A hedge-mode fill that reduces a side with
  nothing open closes a position opened before the earliest reachable fill. It used to push
  size negative and later "close" as a fabricated trip. It now goes to `orphans`, and the Journal footer states
  how large that bucket is.

Statistics over those trips: `summarise(trips)` (win rate, payoff, expectancy, profit
factor, median hold) and `bySymbol(trips)`, which is `summarise` grouped and sorted worst
first. `behaviourSplit(trips)` returns the added-while-underwater partition as two
`summarise` results. From the income ledger: `equityCurve(income)` (daily and cumulative PnL
with running drawdown, green/red day counts, best and worst day) and `incomeTotals(income)`
(per-type totals plus fee drag as a share of gross realised).

Breakdowns for the journal sections: `byDayOfWeek` / `byHourOfDay` / `byHoldTime` / `bySide`
/ `byMonth`, each bucket carrying its trip count and a `thin` flag below 10 trips;
`streaks`; `sequenceEffect` (size after a win against size after a loss — revenge trading
shows up as a *bigger* position, not a worse one); `sizeDistribution`; `makerTaker`;
`records`; and `calendar(income)`, which lays Monday-first weeks and leaves an untraded day
`null` rather than zero so "no trading" never reads as "flat".

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
- `GET /api/history/sync[?start=true][&full=true]` — starts a sync when idle, returns
  progress, the store's file/byte counts and the cursors
- `GET /api/performance[?days=N]` — 28 sections: round trips, behaviour split, equity curve,
  calendar, per-symbol, per-hold-time/day/hour/side/month, streaks, sequence effect, size
  distribution, execution, records, fees and funding per symbol, trip lists
- `GET /api/hedgeledger` — locked PnL per pair, residual exposure, carry per day, margin
  inflation under a pump

### Journal tab (7th) — seven sections
Sub-tabs (`jrTab`): **Overview · Performance · Behaviour · Timing · Symbols · Costs · Trades**.

**Overview is the account, not the closed trades.** Round-trip statistics alone mislead while
a large position is still open: the closed-trip net (plus the orphan fills) can be a fraction
of the unrealised loss the account carries on top of it. The front page reconciles the whole thing —

```
wallet at the start of the window   (derived from the ledger)
+ deposits and withdrawals
+ realised PnL
− fees
− funding
= wallet now
+ open positions, unrealised
= account value
```

— then lists what is open, the locked hedge portion, and activity totals. The starting wallet
is derived as `wallet − Σledger`, so it is exact only for the window income covers.
`jrLockedFromPositions()` computes the hedge lock from the dashboard poll, with no extra
request.

`history-store.js` exports the filesystem primitives the sync is built from:
`readNdjson` / `appendNdjson(file, rows, keyOf)` (dedupes on the caller's key, so a re-run
adds nothing), `readJson` / `writeJson` for the cursor file, `tradesFile(dir, symbol)` which
strips path characters so a malformed symbol cannot escape `data/`, `ensureDir`, and
`storeStats(dir)` for the file, byte and symbol counts the sync endpoint reports.

| section | contents |
|---|---|
| Overview | account value, the reconciliation above, open positions, activity |
| Performance | hero stats, cumulative curve + underwater panel + daily bars, month by month, records |
| Behaviour | added-while-underwater split, hold-time buckets, long vs short, streaks, size after a win vs a loss, size distribution |
| Timing | calendar heatmap, day of week, hour of day |
| Symbols | full per-symbol table with concentration |
| Costs | maker/taker split, fees by symbol, funding by symbol |
| Trades | recent 25, worst 10, best 10 |

**Two stacked panels, never two y-axes.** Daily results are bars whose *direction* encodes
sign: the project's green/red pair measures ΔE 3.2 under deuteranopia, far below the ΔE 8 at
which colour may carry meaning alone, so geometry does the work and colour only reinforces
it. `jrDivergingBars` applies the same rule everywhere — bars grow left or right from a
centre line, and **every bucket shows its trip count**, with fewer than 10 dimmed and marked
⚠. A five-figure number from two trades is noise, and the count is what says so.

`jrSym()` keeps the quote on non-USDT pairs: stripping both collapsed `BTCUSDT` and
`BTCUSDC` into a single label that then appeared twice in the costs list.

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

### Latency: warm the slow caches at boot, fan out the rest
`/api/riskbook` took **13.4s** on its first call. The costs were `exchangeInfo` (2.6s, ~1MB),
`leverageBracket` for all symbols (2.5s, 942KB) and per-asset candle, depth and commission
fetches issued **serially in a loop**. All three long-lived tables are now warmed in a
boot-time `Promise.all` (905 filters, 790 funding intervals, 1,039 bracket tables), and the
per-asset work fans out one request per *asset* rather than per position. Cold is now 5.5s,
warm 0.5–2s. When changing this path, keep the fan-out: a `for` loop with an `await` inside
was the single largest cost.

### Conditioning: when a liquidation price stops being precise
`P* = −C / A`, so `dP*/dC = −1/A` — every dollar of equity moves the liquidation price by
`1/|A|` dollars. As a book approaches delta-neutral the solve lands far outside any observed
price and that ratio grows, so the figure becomes directional rather than exact.
`liquidationDetail()` returns `coefficient`, `sensitivityPerDollar`, `multipleOfMark`,
`movePerOnePctEquity` and flags `illConditioned` when a 1% equity wobble moves it more than
5%, or it sits beyond 3× / below ⅓ of the mark.

Observed live on a tightly hedged book: BTC solves at **9.8× the mark**, where **thousands of
dollars of liquidation price ride on 1% of equity** — which is the whole explanation for its 6.6%
difference from Binance's published figure, while ETH at 6.3× differs by 0.6%. Neither is a
modelling error; both are extrapolation. The drawer reports well-conditioned solves as a
sync badge and ill-conditioned ones separately, so the panel never claims precision it does
not have. `liqCrossCheck` uses the closed form for exactly this reason — the ray scan caps
at +300% and silently stopped validating anything past it.

### ADL
`adlQuantile` rides along on each position. On a hedged book this matters more than usual:
auto-deleveraging closes *profitable* positions, so it takes the winning leg and leaves the
loser naked. The Stress tab warns at quantile ≥ 3.

## Confluence (Binance USDM, any perpetual)

Independent signals on one coin (default `BTCUSDT`), scored bullish / bearish / neutral per
timeframe (15m · 1h · 4h · 1d), and each shown next to **its own track record on that coin**.

### Module: `confluence.js` (ESM)
Pure functions, no I/O. Indicators: `ema`, `rma`, `rsi` (Wilder), `macd`, `atrSeries`,
`supertrend`, `adx`, `bollinger`, `donchian`, `swingStructure` (confirmed fractals only),
`anchoredVwap`, `flowImbalance`, `rollingZ`, `alignToCandles`. `buildIndicators(candles,
{tf, deriv, fundingIntervalMs})` computes every series once; the registry reads it.

**The registry is the extension point.** `CONFLUENCES` holds `{ id, name, source, needs,
scoreAt(x, i, regime), gated? }`. `scoreAt` scores *any* bar, not just the last, which is what
makes calibration free: a new signal is one entry and gets a track record automatically.

| source (weight) | signals |
|---|---|
| Trend 0.20 | EMA 20/50/200 stack · Supertrend 10×3 |
| Momentum 0.12 | RSI 14 (thresholds by regime) · MACD 12/26/9 histogram |
| Mean reversion 0.10 | Bollinger %B — gated off in a trend or a squeeze |
| Flow 0.18 | CVD 20-bar imbalance · taker buy/sell 3-bar, both as z-scores |
| Structure 0.15 | anchored VWAP (UTC day/week/month/year by timeframe) · Donchian 20 + swings |
| Leverage 0.18 | OI × price quadrant (contracts, not value) · funding + basis z, contrarian beyond ±1 |
| Positioning 0.07 | top-trader position L/S minus all-account L/S, z |

- **One vote per source.** Collinear signals are averaged inside their source first, so five
  flavours of trend cannot outvote flow. A missing input is `n/a` and leaves Σw — absence is
  never counted as neutral agreement.
- **ADX is the regime, never a vote.** > 25 trend: trend ×1.5, mean reversion off. < 20 range:
  trend ×0.5, mean reversion ×1.5, RSI fades 30/70. Squeeze (bandwidth below the 10th
  percentile of 120 bars) switches mean reversion off and raises a badge.
- **Crowding cap**: funding/basis z > +2 with a score > +0.5 caps it at +0.3 (mirror for shorts).
- **Alts**: a timeframe disagreeing with a clear BTC read (|s| ≥ 0.3) at 72h correlation > 0.7
  is halved.
- **1d leverage and positioning are shown but not scored** — Binance keeps 30 days of
  `/futures/data/*`, which is ~30 daily points.
- **Flow is z-scored, not thresholded.** A fixed ±10% imbalance scale almost never fired on
  4h/1d (n = 21 and 0 over 1,000 bars); against its own 200-bar history it fires on every
  timeframe.

### Calibration: the panel states each signal's record, it does not assert it
`calibrate(x)` replays every signal and the composite over the fetched history: an active
reading shown as ▲/▼ (|s| ≥ 0.25, the same threshold as the displayed state) hits when its
sign matches the close 6 bars later. `expected` is what a coin-flip with the same long/short mix
would score given the period's up-bar share, and **`edge = hit − expected`** — so a long-only
signal in a bull market does not get credit for the drift.

**Significance uses an effective sample.** 6-bar forward windows overlap, so consecutive
readings share most of their outcome. On 60 pure random walks the composite edge had an sd of
0.045 against a naive binomial 0.022, and 20% of seeds cleared "2 SE". Each record therefore
carries `nEff = n ÷ horizon`, a 95% Wilson interval on it (`wilson()`), and `significant` only
when that interval excludes `expected`; the UI marks those ✓/✗ and nothing else. With 48
signal × timeframe cells, two or three will still clear by luck — the intro says so. Earlier
thresholds (|s| ≥ 0.5) silently dropped every mixed EMA stack and every OI covering/flush
reading from calibration, so the record described a different subset than the one on screen.

Observed live on BTCUSDT: most edges sit within ±4 points of zero, and the 15m EMA stack runs
**−10pt** (15m trends mean-revert). That is the expected result for public indicators on a
liquid market and exactly why the number is on screen.

Lookahead is tested as a property: scoring bar *k* on the full series equals scoring a series
cut at *k*, with positioning rows stamped at the bar boundary. Derivative rows align to the
kline `closeTime` (open + interval − 1ms), and the anchored-VWAP slope is never compared across
an anchor reset.

### Server
`getKlinesTf(symbol, interval)` — 1,000 bars with taker-buy volume (kline field 9), forming bar
split off as `live`, TTL 60s–10min by timeframe; kept separate from `getBinanceKlines` so the
stops and stress paths are untouched. `publicGet(path, params, ttl)` — cached public GET with
stale fallback. One `Promise.all` fans out every kline, positioning and funding call. Symbols are
validated against `exchangeInfo` (`contractType: PERPETUAL`); `refreshSymbolFilters` now keeps
`contractType`, `status` and `quoteAsset`. Cold BTC request ~1.6s.

### Frontend
8th tab **Confluence**, `#cf-mounted` so the poll cannot reset the picker. Symbol input with a
datalist of every trading perp, quick buttons for BTC and each held symbol (•), timeframe chips.
Header tiles per timeframe (score as a diverging bar, regime, ADX, source counts, composite
record, squeeze / crowded / BTC-disagrees badges); a matrix of source rows and signal rows ×
timeframes, each cell ▲/▼/–/off/n/a with value, note and `hit% · n · edge`. State: `cfData`,
`cfSymbol`, `cfTfs`, `cfSymbols`, `cfLoading`.

### Not built (candidates for custom confluences)
Liquidation heatmap (no REST history; needs a `!forceOrder@arr` collector) · volume profile ·
order-book imbalance (spoofable, snapshot only) · BTC-dominance proxy · session effects ·
a user-defined rule builder (`{indicator, op, value}` entries fit the registry shape) · alerts.

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

### Still open
- **Show `usedWeight1m` and the ban state in the UI** — the server tracks both; nothing
  renders them yet. A `/api/health` route (ban, weight, websocket age, reconcile drift, cache
  ages) is the natural home.

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

## Known gaps / not yet implemented

- **Binance spot** — only USDM futures; spot endpoint is `/api/v3/openOrders`
- **Hyperliquid is read-only and unmaintained** — it still renders, but none of the risk,
  unwind, journal or ledger tooling covers it, by decision
- **HL equity uses the *spot* USDC balance** (`server.js`, `getHyperliquidData`) — wrong for
  liquidation purposes, since HL perp margin comes from the perp account. Deliberately left:
  with perp value 10,000 and 12 USDC in spot it reports `equity: 12`, `marginPct: "16666.7"`
- **HL funding is hourly, Binance's is 8h/4h/1h** — the dashboard's daily funding now uses each
  position's `fundingIntervalHours` (HL positions carry `1`), but the stops engine still feeds
  HL rates to `getFundingAdjustment` as if 8h, so the L3 layer is inert on HL
- **`hedgeWarnings` in `/api/volstops`** is fixed, but `checkHedgePairHealth`'s old
  same-asset pairing is the pattern to avoid if that code is ever revisited
- **Authentication, and the server listens on every interface** — `app.listen(PORT)` binds
  `0.0.0.0` with no login and no Host check, so anyone on the same network (or a public
  Railway/Render deploy) can read positions, orders and the whole trade history, and any web
  page can start a history sync with a GET. A loopback default (`HOST` env to override) and a
  POST for sync start were proposed in the 2026-09-29 review and deliberately not applied;
  revisit before any deployment beyond this machine
- **Reconcile can race a websocket event** — a CANCELED arriving while the 60s snapshot is in
  flight is overwritten by the pre-cancel snapshot; a phantom order can show for up to a
  minute and a false drift is logged. Self-heals on the next reconcile
- **Stress slider cost grows with book size** — ~11ms/frame on this book, but a probe with 15
  assets / 25 legs / 10-tier brackets measured 43–57ms. A piecewise-analytic kill price (the
  buffer is linear between tier floors, clamp kinks and triggers) would be exact and cheaper
- **The unwind planner treats a cross-asset hedge as two naked legs** — `grossNetDelta` works
  per asset, so closing the BTC side of a BTC-long / ETH-short pair scores as de-risking.
  `/api/volstops` already restates legs in BTC-beta terms; the planner does not
- **Journal: all timing buckets are UTC**, the "all" window mixes a four-month trip span with a
  three-month income span, and the history sync's "recent" window is a fixed 7 days — a sync
  after a two-week gap misses symbols traded 8–14 days ago that are now flat (Full rebuild
  catches them)
- **Alerts** — thresholds are visible in the Stress tab but there is no push or sound
- **No streaming for market data** — positions and marks are a 15s REST poll. Only the
  Binance user-data stream is a websocket, and *that* is an accelerator over a 60s REST
  reconcile rather than a source of truth (see *Order cache*)
- **Stress simulator: Hyperliquid** — engine is per-pool, so HL slots in by building a pool
  with `collateral = crossMarginSummary.accountValue − Σ uPnL` and `mm = notional / (2 × maxLeverage)`
- **Stress simulator: two-coin heatmap** — a 2D margin-ratio grid with the liquidation
  contour would show joint extremes the one-coin-at-a-time view hides
- **Stress simulator: funding drag** — a days-held slider subtracting accrued funding from
  pool collateral before the shock
- **Unwind planner: the plan's own steps price at the mark** — the drawers walk live depth
  (*Execution cost*), but `deleveragePlan`'s step ordering still uses a flat fee rate, so a
  step that looks cheap could fill worse than stated
- **Unwind planner: partial-size search** — candidates are whole legs or the full matched
  portion of a hedge. A continuous search over close fractions would find cheaper steps
- **Unwind planner: no execution** — it produces a plan only; nothing is ever sent to an
  exchange. Note the safety is in the code, not the key: the account reports `canTrade: true`
- **Journal: income capped at 3 months** by Binance, so the equity curve stops there while
  round-trip statistics reach further; the panel states both spans
- **Journal: positions opened before the earliest reachable fill** are excluded from round
  trips; their closing fills are reported as an orphan bucket rather than dropped
- **Depth is a snapshot** — it shows what the book can absorb now, not during a move
- **Journal has no manual annotation** — no per-trade notes, tags, screenshots or emotional
  state. Everything shown is derived from exchange records, which is why it can be
  reconciled; anything hand-entered would need storage the store does not yet have
- **Timing breakdowns are UTC** with no session or local-time grouping

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
- Funding rate math: `(side === 'Long' ? -1 : 1) * (fundingRate / 100) * sizeUsd` per settlement —
  **positive = received**, negative = paid. `fundingPerDay(p)` in the frontend is the only place
  the daily figure is computed, and the list column is labelled Daily funding (it said Daily cost,
  against its own sign)
- Null/absent data: return raw `null` from backend, render as `"—"` in frontend via `fmtPnl(null)` → NaN → `"—"`
- Funding **per day** is `rate × (24 / fundingIntervalHours) × notional`, never `× 3` — 8h, 4h
  and 1h symbols all exist, and the declared interval can itself be wrong (*Funding cadence*)

### Rules earned the hard way
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
