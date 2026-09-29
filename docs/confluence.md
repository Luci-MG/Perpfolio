# Confluence

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
