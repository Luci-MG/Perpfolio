# Dynamic stop width

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
