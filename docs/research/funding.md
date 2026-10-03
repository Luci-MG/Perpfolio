# Funding — mechanics, endpoints and derived metrics

Research for a better funding view: Binance USDⓈ-M perpetuals (hedge mode, cross margin) and a
read-only Hyperliquid view. Primary sources only (Binance developer docs, Binance Support FAQ,
Hyperliquid docs), fetched 2026-10-03. No account data is used here.

## What this means for the dashboard

| Decision | Recommendation |
|---|---|
| **Next-settlement rate** | Label `lastFundingRate` / stream `r` as **estimated** until `nextFundingTime`. Binance's FAQ says the displayed rate is "an estimation"; the realised rate is the `fundingRate` row in `/fapi/v1/fundingRate` after settlement. There is no separate "predicted rate" endpoint on Binance |
| **Settlements per day** | Always `24 / fundingIntervalHours`, from `fundingInfo` with an 8h default for absent symbols. Re-read it after every settlement where the rate hit cap/floor — the interval can drop to 1h within ~15 min |
| **Interest component** | Do not hard-code 0.01% for 4h/1h symbols. The FAQ only states 0.01% per 8h; read `interestRate` from `premiumIndex` instead |
| **Cost per position** | `sign × rate × markPrice × |qty|` per settlement, sign `−1` for long when rate > 0 (positive = received, as in CLAUDE.md). Notional uses mark price **at settlement**, so the figure for "now" is an estimate twice over (rate and price) |
| **Hedged pair** | Show **net** funding per symbol (long + short legs). Same rate on both legs, so the net is `rate × mark × (qty_S − qty_L)` — zero only when quantities match. The gross on each leg is still worth showing: it is the cost of keeping the hedge |
| **Realised vs estimated** | Realised = `FUNDING_FEE` income rows (90-day window, cached locally). Estimated = rate × notional. Put the two side by side per symbol and show the error, as the margin figures already do |
| **Annualised** | `rate × settlements/day × 365`, labelled as an extrapolation of one interval |
| **Cap proximity** | Show `rate / adjustedFundingRateCap` (or floor). A rate at cap is the trigger for a 1h interval switch — 8× the settlements per day |
| **Hyperliquid** | Hourly, rate on oracle-price notional, one net position per coin (no same-coin hedge). `predictedFundings` gives HL's own estimate, plus its estimate of Binance/Bybit — a third-party figure, label it so |

## 1. How Binance computes the rate

- **Formula.** `F = P̄ + clamp(I − P̄, −0.05%, +0.05%)`, where `P̄` is the average premium
  index and `I` the interest rate. If `I − P̄` lies within ±0.05%, `F = I`.
- **Premium index.** `P = [max(0, impact bid − index) − max(0, index − impact ask)] / index`,
  sampled every 5 s. For intervals longer than 1h the samples are **time-weighted**:
  `P̄ = (1·P₁ + 2·P₂ + … + n·Pₙ) / (1 + 2 + … + n)` — later samples count more. For 1h
  intervals the average is equal-weighted.
- **Interest rate.** "Fixed at 0.03% daily by default (0.01% per funding interval since funding
  occurs every 8 hours)". The FAQ states no figure for 4h/1h intervals; the `interestRate` field
  of `premiumIndex` is the per-symbol value to use.
- **Cap/floor.** `Cap = 0.75 × maintenance margin ratio`, `Floor = −0.75 × MMR` for a listed set
  of symbols; "± 2%" for the other USDⓈ-M perpetuals. Current per-symbol values are in
  `GET /fapi/v1/fundingInfo` (`adjustedFundingRateCap`, `adjustedFundingRateFloor`).
- **Estimated vs charged.** The FAQ: "The funding rate here represents an estimation of the
  last 8 hours of the premium index." The API describes `lastFundingRate` only as "the Latest
  funding rate"; in practice it is the running estimate for the coming settlement, and the
  charged rate is whatever it reads at `nextFundingTime`. No dedicated predicted-rate endpoint
  exists in the USDⓈ-M docs.
- `estimatedSettlePrice` in `premiumIndex` is "only useful in the last hour before the
  settlement starts" (delivery settlement, not funding).

— https://www.binance.com/en/support/faq/introduction-to-binance-futures-funding-rates-360033525031
— https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Mark-Price
— https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Get-Funding-Rate-Info

## 2. Who pays, how much

- **Direction.** Positive rate: longs pay shorts. Negative rate: shorts pay longs. Peer to peer.
- **Amount.** "Funding Amount = Nominal Value of Positions × Funding Rate", nominal value =
  mark price × size. `/fapi/v1/fundingRate` returns the `markPrice` "associated with a particular
  funding fee charge" — the price actually used.
- **Only positions open at settlement pay.** A position closed before the timestamp pays
  nothing; there is "a 15-second deviation in the actual funding fee transaction time" — a
  position opened at 08:00:05 UTC can still be charged.
- **Hedged same-symbol legs** (derived, not stated in the docs). Each leg is a separate position
  charged at the same rate and the same mark price: long pays `r × mark × qty_L`, short receives
  `r × mark × qty_S`. Net is `r × mark × (qty_S − qty_L)`; zero only at equal quantity. The two
  `FUNDING_FEE` rows arrive separately in the income ledger.

— https://www.binance.com/en/support/faq/introduction-to-binance-futures-funding-rates-360033525031
— https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Get-Funding-Rate-History

## 3. Intervals and settlement times

- **Default:** every 8h at **00:00, 08:00, 16:00 UTC**. Some symbols run 4h or 1h.
- **Switch to 1h:** automatic, "within approximately 15 minutes after the previous funding rate
  settlement reaches the funding rate cap or floor" (from 8h or 4h).
- **Revert:** if a 1h symbol's rate is ≤ |0.025%| for 16 consecutive cycles, the frequency
  reverts to every 4h on the 17th cycle.
- **`fundingInfo`** returns only "symbols that had FundingRateCap/FundingRateFloor /
  fundingIntervalHours adjustment" — absence means defaults, not missing data. Fields:
  `symbol`, `adjustedFundingRateCap`, `adjustedFundingRateFloor`, `fundingIntervalHours`,
  `disclaimer` (ignore). Weight 0, but shares the 500/5min/IP limit with `/fapi/v1/fundingRate`.
- **Pitfall.** `nextFundingTime` already reflects the current interval; deriving the interval
  from the gap between two history rows is a cross-check, not a source (see
  `docs/journal.md`, *Funding cadence*).

— https://www.binance.com/en/support/faq/introduction-to-binance-futures-funding-rates-360033525031
— https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Get-Funding-Rate-Info

## 4. History endpoints

| Endpoint | Limits | Notes |
|---|---|---|
| `GET /fapi/v1/fundingRate` | `limit` default 100, max 1000; shares **500/5min/IP** with `fundingInfo` | No start/end → most recent 200. Over-limit range → returns `startTime` + `limit`. Ascending. Fields `symbol`, `fundingRate`, `fundingTime`, `markPrice`, `rateType` (`Regular` / `Special`) |
| `GET /fapi/v1/income` (`incomeType=FUNDING_FEE`) | Weight 30; `limit` default 100, max 1000 | "Income history only contains data for the last three months". No start/end → last 7 days. `tranId` unique per income type per user |

- `rateType: Special` marks a stock-dividend-generated entry; exclude it from rate statistics.

— https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Get-Funding-Rate-History
— https://developers.binance.com/docs/derivatives/usds-margined-futures/account/rest-api/Get-Income-History

## 5. Websocket

- `<symbol>@markPrice` (3000 ms) or `<symbol>@markPrice@1s` (1000 ms); an all-market variant
  exists (second link below).
- Payload: `p` mark price, `ap` mark price moving average, `i` index price, `P` estimated settle
  price, **`r` funding rate**, **`T` next funding time**, `st` symbol type.
- `r` is the same quantity as `lastFundingRate`, pushed every 1–3 s — it is the live estimate,
  so the view can update without polling. Per CLAUDE.md, the stream is an accelerator:
  reconcile against `premiumIndex` on the 15s snapshot.

— https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Mark-Price-Stream
— https://developers.binance.com/docs/derivatives/usds-margined-futures/websocket-market-streams/Mark-Price-Stream-for-All-market

## 6. Hyperliquid

- **Hourly,** at one-eighth of the 8h-basis rate. Same shape as Binance:
  `F = P̄ + clamp(I − P̄, −0.0005, 0.0005)`, premium sampled every 5 s and averaged over the hour.
- **Interest:** 0.01% per 8h = 0.00125% per hour ("11.6% APR paid to short").
- **Cap:** 4% per hour.
- **Notional:** "The spot oracle price is used to convert the position size to notional value,
  *not the mark price*."
- **Info endpoint** (`POST /info`):
  - `metaAndAssetCtxs` → per-asset `funding` (current rate), `premium`, `oraclePx`, `markPx`.
  - `predictedFundings` → per coin, per venue (`HlPerp`, `BinPerp`, `BybitPerp`)
    `{fundingRate, nextFundingTime}`. HL's rate is hourly, Binance/Bybit are per their interval.
  - `userFunding` (`user`, `startTime`, optional `endTime`) → `delta.{coin, usdc, szi,
    fundingRate, nSamples}` with `time`; **500 elements per response**, page by `startTime`.
  - `fundingHistory` (`coin`, `startTime`, `endTime`) → `{coin, fundingRate, premium, time}`.

— https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding
— https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals

## 7. Derived metrics and pitfalls

| Metric | Definition | Pitfall |
|---|---|---|
| **Per settlement** | `sign × r × mark × |qty|` | `r` and `mark` both move until settlement |
| **Per day** | `per settlement × 24 / fundingIntervalHours` | Interval can change mid-day after a cap hit |
| **Annualised** | `r × 24 / intervalHours × 365` | One interval extrapolated a year; say so |
| **Net per hedged symbol** | `Σ legs` | Gross per leg hides behind a small net; show both |
| **% of equity / margin** | per-day ÷ margin balance (not wallet) | CLAUDE.md: equity is the margin balance |
| **Time to settlement** | `nextFundingTime − now` | Charge lands up to ~15 s after the timestamp |
| **Cap proximity** | `r / cap` or `r / floor` | `fundingInfo` omits default-cap symbols (±2% or 0.75×MMR) |
| **Realised vs estimated** | ledger `FUNDING_FEE` vs `rate × notional` at each `fundingTime` | Use history `markPrice`; income only reaches back 3 months |
| **Basis / premium** | `(mark − index) / index` from `premiumIndex` | Drives `P̄`; a lead indicator for the next estimate |

- A sample-size rule applies: an average realised rate over two settlements is not a rate.
- Hyperliquid realised funding uses oracle notional; comparing it to a Binance estimate on mark
  notional mixes two prices.
