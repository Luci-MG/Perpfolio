# Dynamic stop width

## Dynamic Stop Width (volatility-adjusted stops)

Composite volatility estimate that adapts stop distance + position size per open position. Dollar risk stays constant; stop width and size float with the regime.

### Module: `vol-estimator.js` (ESM)
Pure functions, no I/O. Layers (Phases 1–3 implemented; Kronos L5 not built):
- `computeATR(candles, 14)` — L1 base, ATR as % of close
- `getBBWAdjustment(candles, bbwHistory)` / `buildBbwSeries` — L2 squeeze multiplier
- `getFundingAdjustment(rate8h)` — L3 crowded-positioning multiplier (rate as fraction, e.g. 0.00012).
  `suggestStop` passes each position's rate restated per 8 hours (`rate × 8 / fundingIntervalHours`),
  so 1h and 4h Binance symbols and Hyperliquid's hourly rate are judged on the same scale
- `getCrossAssetAdj(btcCandles, assetCandles, btcAtrHistory)` / `buildAtrSeries` — L4 BTC→alt vol lead
- `computeCompositeVol({atrPct, bbwAdj, fundingAdj, crossAssetAdj, kronosVol})` — `atr × bbwAdj × fundingAdj × crossAdj`
- `classifyRegime(vol, volHistory)` → `low|medium|high|extreme` (relative percentile bands)
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

### Candle sourcing (`lib/market-data.js`)
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
percentile the current reading sits at, so the label is falsifiable. Today's reading and its
history are both weighted by each leg's real notional; the reading used to be weighted by the
*suggested* size, which shrinks with volatility, so it leaned toward "low".

### Endpoint: `GET /api/volstops?risk=&k=`
- `risk` = fraction (0.01 = 1%), `k` = stop multiplier (default 1.5)
- Account size = live exchange equity per position (auto)
- Returns `{ ok, params, combined, positions }`:
  - `combined`: `portfolioRegime` + `regimeBasis`, `portfolioVolPct`, `totalDollarRisk`,
    `totalEquity`/`hlEquity`/`bnEquity`, `regimeCounts`, `netByAsset`, `betaByAsset`,
    `rawNet`, `betaAdjustedNet`, `nakedBtcEquiv`, `nettedSymbols`, `hedgePairs`, `hedgeWarnings`,
    `stopVerdicts` (count per verdict)
  - `positions[]`: stop/size fields + `regimeLabel`, `layers{atrPct,bbwAdj,fundingAdj,crossAdj,...}`, `backfilled[]` tags,
    and the real stop: `yourStop{price,distancePct,atrMultiple,hit}`, `verdict`, `ratio`, `lockedPct`
- **Backfill rules** (never skip a position / never show `—`): missing candles → synthetic series (tag `candles`); missing funding → `1.0` (tag `funding`); no BTC candles → cross `1.0` (tag `crossAsset`); short BBW/regime history → neutral + tags; missing equity → total equity / exposure fallback (tag `equity`). Per-position try/catch so one failure can't break the panel.

### Your real stop against the suggestion (`stop-check.js`)
Pure and unit-tested; the route passes it the orders and candles it already has, so it costs
no request.

- **Which order is your stop** — on the closing side of that leg: a `Stop market` or `Stop`
  (stop-limit) order, nearest the mark, or a `Trailing stop market`. Take-profits and
  reduce-only limits never count — a resting reduce-only limit can only sit on the profit
  side, so it is a take-profit however it was meant; it is listed in the tooltip instead.
  **Coverage** sums the leg's stop quantities (a `closePosition` stop covers all); under 95%
  is `partial`. Hyperliquid order sizes are not known, so coverage there is null. One rule everywhere: the Stops tab, the
  entry capture and the tiles' "no stop" badge (`hasStop` on `/api/dashboard`). The badge used
  to count any reduce-only order, so a reduce-only limit sitting in profit — a take-profit —
  passed as a stop.
- **Distance is from the current mark**, the risk carried now; the suggestion's distance
  (k × composite vol) is compared on the same basis. `atrMultiple` is that distance in 1h ATRs.
- **Not by session.** The hit rate counts 24h windows, which always cover every session, so
  the session filter does not apply here and the tab says so.
- **The hit rate is measured, not modelled** — the share of 24h windows on the symbol's own
  held 1h candles (200 at start, growing to 720 while the server runs) whose move against the
  leg reached the distance. Windows overlap, so the tooltip gives windows and the roughly
  windows ÷ 24 independent ones; a normal-returns formula would understate fat tails.

| Verdict | Rule (constants in `stop-check.js`) |
|---|---|
| `none` | no stop, and no opposite same-symbol leg |
| `partial` | the stops cover under 95% of the leg |
| `trailing` | only a trailing stop — its distance is not fixed, so it is never judged tight or wide |
| `set` | a fixed stop with no suggestion to judge it against (the tiles, from orders alone) |
| `hedged` | no stop, opposite same-symbol leg open — not flagged |
| `breakeven` | stop within ±0.05% of entry (about one taker fee, and tick rounding) — risks nothing, so never tight or wide |
| `locks` | stop further past entry in the profit direction; `lockedPct` |
| `tight` | under 0.5× the suggestion, or hit in more than 60% of windows |
| `wide` | over 2× the suggestion |
| `ok` | otherwise |

### On the position tiles
Every 15s poll judges each leg from its orders alone (`legProtection` → `stop` on
`/api/dashboard`): `set`, `breakeven`, `locks`, `trailing` or `partial`. Width needs the
suggestion and the hit rate, so `tight` and `wide` come from the Stops tab's data once it has
loaded, and only while that judgement was made against the same stop price — a moved stop
falls back to the plain mark. `stopMarkHtml(p)` draws one mark for tiles and the List view:

| Mark | Means |
|---|---|
| green shield ✓ | safe — the stop cannot lose: breakeven (at entry) or locks profit |
| grey shield | a stop is set but still risks a loss (set, ok, trailing); the tooltip gives the loss if hit |
| amber shield ! | partial, or judged too tight / too wide on the Stops tab |
| red ring | no stop and not hedged |
| nothing | no stop, hedged — the thread colour says so |

Green means *nothing to worry about*, so only a stop that cannot lose earns it; a stop below a
long's entry protects but still risks the gap, and reads grey. The tooltip carries the stop
price and distance, the loss if hit, coverage, the take-profit and, for a width verdict, its
ratio, hit rate and how long ago the Stops tab judged it.

### Frontend (`public/js/stops.js`)
- 4th view tab **Stops** (`posView==='stops'`); `fetchVolStops()` runs only when the tab is active (not on the 15s poll) to limit candle API load
- `renderVolStops()` → `volControlsHtml()` (risk%/k inputs) + `renderVolCombined()` (combined panel) + grid of `renderVolTile()` per-position cards
- Reuses the HL/BN `exchFilter`; `setVolRisk()` / `setVolK()` re-fetch on change.
  `renderVolCombined` recomputes `$ risk`, equity and the regime spread from the *filtered*
  positions — the server's totals cover every venue and would disagree with the tiles
  below. `renderHedgeHealth` deliberately does not filter (a hedge spans the whole book)
  and is labelled as such.
- State: `volStopData`, `volRiskPct` (default 1.0), `volK` (default 1.5), `volLoading`
- Regime colors: low=success, medium=text2, high=warning, extreme=danger; `est` chip when `backfilled[]` non-empty
- Each tile shows **Your stop** — price, distance from mark, ATRs, ratio to the suggestion, the
  24h hit rate — with the verdict as the only coloured element; the combined panel adds a
  *Your stops* cell ("2 without a stop · 2 too tight"), counted over the filtered positions
