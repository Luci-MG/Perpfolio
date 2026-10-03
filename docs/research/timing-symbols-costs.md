# Timing, Symbols and Costs — what to show, and how to keep each number honest

Research for the journal's **Timing**, **Symbols** and **Costs** tabs. Context: a few hundred
round trips over a few months, dozens of symbols with a handful of trips each, a hedged book
(same-symbol long and short, cross margin, high leverage), fees and funding attributed per
trip, equity snapshots every 15 minutes while the server runs, a reader in a local timezone.
Sources are the papers, exchange docs, standards and vendor help pages that own each claim,
fetched 2026-10-03. No account data is used here.

Already settled elsewhere and not repeated: intervals for means and win rates, minimum-n
floors, Benjamini–Hochberg, day-clustering and the "exploratory" label are in
[`outcome-factors.md`](outcome-factors.md); returns, drawdown and expectancy in
[`performance-behaviour.md`](performance-behaviour.md); waterfall/bridge layout in
[`overview.md`](overview.md) §3; funding mechanics, intervals and per-day maths in
[`funding.md`](funding.md); market sessions in [`../sessions.md`](../sessions.md).

## Recommendations for this dashboard

### The rule that runs through all three tabs

**A total is a fact; an average is an estimate.** "BTCUSDT lost X over the window" or "Tuesdays
summed to Y" is accounting and needs no correction — only the trip count beside it. "BTCUSDT
trips lose on average" or "Tuesday is my bad day" is an estimate from a small sample and gets
shrinkage, an interval and a minimum n. Every row on these tabs should say which kind of
number it is. *Inference from §2 and §4 below.*

### Timing

| Decision | Recommendation |
|---|---|
| **Clock** | Bucket in the reader's **IANA zone** (`Intl.DateTimeFormat`, as `sessions.js` already does), not a fixed `tzOffsetMin` — a fixed offset moves every trip by an hour across a DST change. Offer UTC as a toggle; mark funding settlement hours (00/08/16 UTC for 8h symbols) on the hour axis |
| **Attribution** | **Entry time** for "when do my decisions work" (hour, weekday, session). **Close time** for the calendar and weekly/monthly totals, because that is when PnL reached the wallet. Label which one each chart uses |
| **Hour of day** | 24 bars of **total net** with n on every bar, plus a **shrunk mean per trip** (§2 formula) as a dot with its interval. Hide the mean below 8 trips; never colour an hour "good/bad" on the raw mean |
| **Day of week** | Same as hour: total + n, shrunk mean + interval. Seven buckets is small enough to show all |
| **Hour × weekday grid** | **Counts only** (activity), sequential single-hue scale. 168 cells from a few hundred trips is ~2 per cell — a PnL grid at that n is noise with colour on it |
| **Calendar** | Keep the daily calendar of net PnL (close time), Monday-first weeks, diverging scale centred on 0 with a glyph sign and the trip count in the cell; untraded days blank, not 0 |
| **Weekly / monthly** | Totals with n trips and n trading days; add net per trading day. No averages across weeks unless ≥ 8 weeks |
| **Multiple comparisons** | 24 + 7 = 31 comparisons on the two marginal charts. Print "31 buckets — about 1–2 will look unusual by chance". Use partial pooling (shrinkage) for the displayed means and BH at q = 0.10 for any "stands out" mark, as in `outcome-factors.md` |

### Symbols

| Decision | Recommendation |
|---|---|
| **Table columns** | Symbol · trips (and days) · **total net** · gross · fees · funding · **costs as bps of notional** · win rate (Wilson) · **shrunk mean net per trip** with interval · median notional and its spread (size consistency) · ATR% at entry (median) · hedged share |
| **Default sort** | **Total net** (a fact). Allow sorting by shrunk mean, but never by raw mean |
| **Top / bottom** | Show top 5 and bottom 5 by total, plus "rest (k symbols)". Tradervue shows top/bottom 20, Tradezella top/bottom 10 — fine for brokers' larger samples, too many here |
| **Concentration** | Share of **gross absolute PnL** from the top 3 symbols; **HHI of notional traded** (activity concentration) and the "effective number of symbols" `1/HHI`. Do not compute an HHI on signed PnL — shares can be negative and the index loses meaning |
| **Shrinkage** | Efron–Morris / normal-normal shrinkage of each symbol's mean toward the book mean, weight by n (formula in §2). Show the raw mean in a tooltip, labelled |
| **Ranking language** | "Best/worst by total" is allowed. "Your best symbol" from averages is not, unless the symbol's interval excludes the book mean and it survives BH |
| **Funding per symbol** | Net funding per symbol and **funding per hour held** (`Σfunding / Σhold hours`), both legs of a hedge netted — mechanics in `funding.md` |

### Costs

| Decision | Recommendation |
|---|---|
| **Headline cost** | **Total cost in bps of notional traded**: `(fees + funding paid) ÷ Σ notional × 10⁴`, with fees and funding as separate lines. Always defined, comparable across periods |
| **Fee drag vs gross** | Show "costs / gross" **only when gross > 0 and gross ≥ 2 × costs**; otherwise show the two numbers side by side in currency ("gross +a, costs −b, net −c") and no percentage. A ratio whose denominator crosses zero flips sign and explodes |
| **Fee rate check** | Effective fee rate = `Σ commission ÷ Σ quoteQty` per maker and taker side, scored against `/fapi/v1/commissionRate` — print the difference, as the margin figures are scored against Binance |
| **Maker share** | **Notional-weighted**, not fill-count (`makerTaker()` counts fills today). Weekly trend with n fills per week; show what the same notional would have cost all-taker and all-maker |
| **BNB** | When `commissionAsset` is BNB, convert at the fill's time and say so; show whether the discount is on (`/fapi/v1/feeBurn`) |
| **Slippage** | Only where a reference price was captured live at order time: `side × (fill − ref) / ref × 10⁴` bps, notional-weighted. Otherwise say "not measured" — a kline-open reference is an approximation and must be labelled as one |
| **How the wallet got here** | Keep the existing ledger (`journal.md`), and add: an **"other income"** line for every income type not named (insurance clear, rebates, kickbacks, bonuses…), BNB-denominated fees converted, and an explicit **residual** = derived wallet − exchange-reported wallet. Show "reconciled to within $x" rather than asserting a match |
| **Drop** | Fees as a % of net PnL; maker % by fill count as the only maker figure |

## 1. Is there seasonality to find in crypto at all?

- **Volume and liquidity have an intraday shape; returns mostly do not.** On GMT-timestamped
  5-minute Bitcoin data over four years, "volume increases throughout the day and falls from
  around 4 pm until midnight … Realised volatility is fairly consistent throughout the day
  although it is highest during the opening times of the three major global stock markets.
  Also liquidity is highest during the opening times of the major global exchanges and the
  markets tend to be illiquid during the early morning."
  — Eross, A., McGroarty, F., Urquhart, A. & Wolfe, S. (2019). The intraday dynamics of
  Bitcoin. *Research in International Business and Finance* 49, 71–81.
  https://doi.org/10.1016/j.ribaf.2019.01.008
- Across 15 million observations from seven exchanges, time-of-day, day-of-week and
  month-of-year effects are "time-varying … but no consistent or persistent patterns across
  the sample period."
  — Baur, D., Cahill, D., Godfrey, K. & Liu, Z. (2017/2019). *Bitcoin time-of-day,
  day-of-week and month-of-year effects in returns and trading volume.*
  https://ssrn.com/abstract=3088472 (abstract via
  https://research-repository.uwa.edu.au/en/publications/bitcoin-time-of-day-day-of-week-and-month-of-year-effects-in-retu/)
- Day-of-week evidence is mixed: Caporale & Plastun find no effect for LTC, XRP or DASH and
  higher **Monday** returns for BTC only; Aharon & Qadan (daily data 2010–2017, OLS and GARCH)
  report day-of-week effects in both BTC returns and volatility.
  — Caporale, G. M. & Plastun, A. (2019). The day of the week effect in the cryptocurrency
  market. *Finance Research Letters*. doi:10.1016/j.frl.2018.11.012 (abstract:
  https://econpapers.repec.org/paper/diwdiwwpp/dp1694.htm)
  — Aharon, D. Y. & Qadan, M. (2019). Bitcoin and the day-of-the-week effect. *Finance
  Research Letters* 31, 415–424. doi:10.1016/j.frl.2018.12.004
- **What this means here.** Market-wide calendar effects in returns are weak and unstable, so
  a strong hour-of-day pattern in one trader's PnL is more likely to be about the trader
  (attention, fatigue, which setups get taken when) or about liquidity and volatility at
  that hour than a market anomaly. The useful context to put beside the hour chart is
  **market volume/volatility by hour**, not "BTC tends to rise at …". *Inference.*

## 2. Many small buckets: shrinkage and partial pooling

- **Stein / empirical-Bayes shrinkage toward the grand mean.** Efron & Morris estimate each
  group's mean as `ȳ + (1 − (k − 3)/V)(y_j − ȳ)` with `V = Σ(y_j − ȳ)²` (equal variances,
  k ≥ 4 groups). On 18 batters after 45 at-bats, the shrunk estimates had total squared
  prediction error **5.01 against 17.56** for the raw averages — an efficiency of 3.50 — and
  were closer to the truth for 15 of 18. For unequal sampling variances `D_j` (their §3,
  toxoplasmosis by city) each group shrinks by `D_j / (A + D_j)`, so groups with less data
  move further. They also warn that the rule lowers *total* risk while "permit[ting]
  considerably increased risk to individual components".
  — Efron, B. & Morris, C. (1975). Data analysis using Stein's estimator and its
  generalizations. *JASA* 70(350), 311–319. doi:10.1080/01621459.1975.10479864
  (PDF: https://faculty.ucmerced.edu/jvevea/classes/290_21/readings/week%204/Efron%20and%20Morris.pdf)
- **Partial pooling answers multiple comparisons directly.** "Multilevel models perform
  partial pooling (shifting estimates toward each other), whereas classical procedures
  typically keep the centers of intervals stationary, adjusting for multiple comparisons by
  making the intervals wider … multilevel models address the multiple comparisons problem
  and also yield more efficient estimates, especially in settings with low group-level
  variation."
  — Gelman, A., Hill, J. & Yajima, M. (2012). Why we (usually) don't have to worry about
  multiple comparisons. *Journal of Research on Educational Effectiveness* 5, 189–211.
  doi:10.1080/19345747.2011.618213 (https://arxiv.org/abs/0907.2478)
- The hierarchical normal model with known within-group variances (the "eight schools"
  example) is the textbook version of the same estimator.
  — Gelman, A., Carlin, J. B., Stern, H. S., Dunson, D. B., Vehtari, A. & Rubin, D. B.
  (2013). *Bayesian Data Analysis*, 3rd ed., ch. 5. http://www.stat.columbia.edu/~gelman/book/

**Formula for this dashboard** (normal-normal, method-of-moments; no sampler, no dependency):

```
per bucket j:  n_j trips, mean m_j, sampling variance v_j = s²_pooled / n_j
book mean:     μ = Σ n_j m_j / Σ n_j
between-bucket variance:  τ² = max(0, var_j(m_j) − mean_j(v_j))
shrinkage:     B_j = v_j / (v_j + τ²)
estimate:      θ_j = μ + (1 − B_j)(m_j − μ)
```

When τ² = 0 every bucket collapses to the book mean — which is the honest answer when the
buckets do not differ by more than noise. Use the pooled within-bucket SD (one heavy-tailed
trip should not give its bucket a tiny variance), require **k ≥ 4 buckets**, and keep the
day-clustered interval from `outcome-factors.md` for the displayed range. *The method-of-moments
τ² is a standard simplification, not Efron–Morris's exact estimator.*

## 3. Ranking under uncertainty

- **Raw maps and shrunk maps both mislead.** "Very high (and low) observed rates are found
  disproportionately in poorly-sampled areas. Unfortunately, adjusting the observed rates to
  account for the effects of small-sample noise can introduce an opposite effect, in which the
  highest adjusted rates tend to be found disproportionately in well-sampled areas … adjusted
  rates tend to look too uniform in areas with little data." Highlighting only statistically
  significant areas does not fix it either: with large n "even a small difference … will be
  statistically significant".
  — Gelman, A. & Price, P. N. (1999). All maps of parameter estimates are misleading.
  *Statistics in Medicine* 18, 3221–3234.
  https://sites.stat.columbia.edu/gelman/research/published/allmaps.pdf
- **Applied to symbols, hours and weekdays.** Sort by raw mean and the top and bottom of the
  list are the symbols traded twice. Sort by shrunk mean and the extremes are the symbols
  traded most — not because they are the most extreme, but because only they have the data to
  leave the book mean. Gelman & Price's remedy is to show uncertainty (they use multiple
  imputed maps); the cheap equivalent here is **n and an interval on every row**, a
  **total-based default sort**, and words that do not claim a ranking the data cannot
  support. *Inference.*

## 4. Clock, attribution and calendars

- **Which timestamp.** Tradervue groups its day-of-week and hour-of-day reports "by entry day
  of week" / "by entry hour of day", in US Eastern time, closed trades only.
  — Tradervue. *Days/Times reports*. https://www.tradervue.com/help/reports/reports_dt
  Tradezella lets the reader choose "Entry Time By" or "Exit Time By" in 5/15/30/60-minute
  buckets.
  — Tradezella. *Reports: Day & Time*. https://help.tradezella.com/en/articles/11391581-reports-day-time
- **Local time is a history, not an offset.** The tz database holds "the history of local time
  for many representative locations", including daylight-saving rule changes.
  — IANA. *Time Zone Database*. https://www.iana.org/time-zones
  `byHourOfDay(trips, stamp, tzOffsetMin)` applies one fixed offset to every trip, so a reader
  in a DST zone gets half the year's trips shifted by an hour. `sessions.js` already resolves
  zones with `Intl.DateTimeFormat`; Timing should use the same. *Code reading, 2026-10-03.*
- **Calendar heatmaps.** The calendar layout for daily time series (days in week rows, months
  in blocks) comes from van Wijk & van Selow.
  — van Wijk, J. J. & van Selow, E. R. (1999). Cluster and calendar based visualization of
  time series data. *Proc. IEEE InfoVis '99*, 4–9. doi:10.1109/INFVIS.1999.801851
- **Colour is the weakest channel for magnitude.** Cleveland & McGill rank position on a common
  scale first and colour hue/saturation last for decoding quantities.
  — Cleveland, W. S. & McGill, R. (1984). Graphical perception. *JASA* 79(387), 531–554.
  doi:10.1080/01621459.1984.10478080
  So the hour and weekday charts should be bars (position/length), and the calendar a
  lookup aid with the number in the cell, not the primary comparison.

### Colour-blind-safe encodings

- Okabe & Ito: "one in twelve Caucasian (8%), one in 20 Asian (5%), and one in 25 African (4%)
  males" are red-green colour-blind; "Do not use the combination of red and green. Use magenta
  (purple) and green instead"; and "use not only different colors but also a combination of
  different shapes, positions, line types and coloring patterns".
  — Okabe, M. & Ito, K. (2002/2008). *Color Universal Design (CUD): how to make figures and
  presentations that are friendly to colorblind people*. https://jfly.uni-koeln.de/color/
- ColorBrewer defines **diverging** schemes as putting "equal emphasis on mid-range critical
  values and extremes at both ends", **sequential** as lightness-dominated low-to-high.
  — Harrower, M. & Brewer, C. A. (2003). ColorBrewer.org: an online tool for selecting colour
  schemes for maps. *The Cartographic Journal* 40(1), 27–37; scheme definitions:
  https://colorbrewer2.org/learnmore/schemes_full.html
- Matplotlib: diverging maps are for data with "a critical middle value … or when the data
  deviates around zero"; BrBG and RdBu are good options by its lightness measures; "avoiding
  colormaps with both red and green will avoid many problems"; sequential maps with
  monotonically increasing L* "print in a reasonable manner to grayscale".
  — Matplotlib. *Choosing colormaps*. https://matplotlib.org/stable/users/explain/colors/colormaps.html
- Viridis is designed to be perceptually uniform, readable with colour-blindness and in grey
  scale; cividis was optimised so that red-green colour-blind and normal viewers read it
  nearly identically.
  — Garnier, S. et al. *Introduction to the viridis color maps* (R package vignette).
  https://cran.r-project.org/web/packages/viridis/vignettes/intro-to-viridis.html
  — Nuñez, J. R., Anderton, C. R. & Renslow, R. S. (2018). Optimizing colormaps with
  consideration for color vision deficiency to enable accurate interpretation of scientific
  data. *PLOS ONE* 13(7), e0199239. doi:10.1371/journal.pone.0199239

**Here:** PnL calendar and signed bars use a **blue–orange (or BrBG-like) diverging pair**
centred on 0 with the `−` glyph, consistent with the project's "a sign is a glyph" rule; the
activity grid uses a single-hue sequential scale (viridis/cividis-like). Red/green may stay as
a reinforcing accent only.

## 5. Symbols: concentration, context and what journals show

- **Concentration.** The HHI is calculated "by squaring the market share of each firm … and
  then summing the resulting numbers" — four shares of 30/30/20/20 give 2,600; it runs to
  10,000 for a single firm; the 2023 Merger Guidelines treat > 1,800 as highly concentrated.
  — U.S. Department of Justice, Antitrust Division. *Herfindahl–Hirschman Index*.
  https://www.justice.gov/atr/herfindahl-hirschman-index
  Shares must be non-negative, so apply it to **notional traded** or **trip count**, not to
  signed PnL. `1/HHI` (shares as fractions) reads as "effectively N equal symbols". For PnL,
  use plain top-k shares of gross absolute PnL. The 1,800 threshold is an antitrust
  convention and has no meaning for a portfolio — do not print it. *Inference.*
- **Volatility context.** Tradervue groups performance "by the ATR(14) of the instrument as of
  the trade entry date", by entry as a % of ATR, and by relative volume vs a 50-day average.
  — Tradervue. *Instrument reports*. https://www.tradervue.com/help/reports/reports_ins
  The dashboard already computes ATR regimes (`vol-estimator.js`); a per-symbol median
  **ATR% at entry** column says whether a symbol's losses are about the symbol or about
  trading it in its wildest weeks.
- **What the products put on a symbol page.**

| Product | Symbol view | Small-n handling | Source |
|---|---|---|---|
| **Tradervue** | "Top and bottom 20 symbols … ordered by aggregate or average P&L"; gross/net toggle per report | None stated | tradervue.com/help/reports/reports_ins · help.tradervue.com/article/3417-tracking-commissions-and-fees |
| **Tradezella** | Top 10 / Bottom 10; net P&L, avg net per trade, profit factor, expectancy, win %, trade count, avg hold | "No minimum trade count" in its documentation | help.tradezella.com/en/articles/11391905-reports-symbol |
| **Edgewonk** | Chart Lab "breaks down your performance across the assets you trade"; best 30-minute windows and weekdays | None stated | edgewonk.com/chart-lab |
| **TraderSync** | Help centre not reachable; not cited (as in `overview.md`) | — | — |

None of them shrinks, intervals or flags thin symbols. The gross/net toggle is the one cost
feature they share. **Size consistency** is not a standard journal column; it is proposed here
because one oversized trip can carry a symbol's total, the same concern `outcome-factors.md`
raises with "share of total net PnL". *Inference.*

## 6. Costs

### Binance fees

- **Formula.** For USDⓈ-M contracts, "Position Value = Contract Size × execution price" and
  "Trading Fee = Position Value × trading fee [rate]". A taker trade "executes immediately …
  Market Orders are always taker trades"; a maker order "adds liquidity to the Global Orderbook
  by resting there until it is matched".
  — Binance. *Binance Futures Fee Structure & Fee Calculations* (FAQ, updated 2026-05-01).
  https://www.binance.com/en/support/faq/detail/360033544231
- **BNB discount.** 10% off standard fees when paid in BNB; BNB must be in the USDⓈ-M futures
  wallet, and if it is insufficient "the system will automatically deduct USDT … and you will
  not be entitled to the discount." Futures VIP tiers "mirror the spot market but are generally
  lower" with volume requirements "5 times that of the spot market". — same FAQ.
- **Per-account rate.** `GET /fapi/v1/commissionRate?symbol=` returns `makerCommissionRate`,
  `takerCommissionRate` (and `rpiCommissionRate`); IP weight 20.
  — Binance Developers. *User Commission Rate*.
  https://developers.binance.com/docs/derivatives/usds-margined-futures/account/rest-api/User-Commission-Rate
  `GET /fapi/v1/accountConfig` returns `feeTier`; `GET /fapi/v1/feeBurn` returns whether BNB
  pays fees. — Binance Developers, account endpoints (same section).
- **Fills.** `/fapi/v1/userTrades` returns `commission`, `commissionAsset`, `maker`, `buyer`,
  `realizedPnl`, `quoteQty`, `positionSide`; 7-day windows, last 3 months only.
  — Binance Developers. *Account Trade List*.
  https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Account-Trade-List
- The public VIP table (https://www.binance.com/en/fee/futureFee) renders client-side and
  could not be read; the base-tier figures in `journal.md` (maker 0.02%, taker 0.05%) come from
  the account's own `commissionRate`, which is the number to trust. Do not hard-code a tier
  table — tiers changed in 2026 per Binance announcements.

### Transaction-cost analysis

- **Implementation shortfall.** Perold defines it as the difference between the performance of
  a paper portfolio traded at decision prices and the real one, so it captures commissions,
  price impact, delay and the opportunity cost of orders never filled.
  — Perold, A. F. (1988). The implementation shortfall: paper versus reality. *Journal of
  Portfolio Management* 14(3), 4–9. doi:10.3905/jpm.1988.409150 (paper not read in full;
  definition as restated in Mittal, H., ITG, *Implementation Shortfall — One Objective, Many
  Algorithms*, https://www.cis.upenn.edu/~mkearns/finread/impshort.pdf)
- **Effective spread** (SEC Rule 605 definition): for buys, "double the amount of difference
  between the execution price and the midpoint" of the best bid and offer at the time of order
  receipt, share-weighted.
  — 17 CFR § 242.600(b), *Average effective spread*. https://www.law.cornell.edu/cfr/text/17/242.600
- **Applied here.** The decision price exists only if it was captured when the order was
  placed. The order stream (`lib/orders-stream.js`) sees orders live, so a mark/mid snapshot at
  `NEW` is the honest reference; fills alone carry no mid. Slippage in bps =
  `side × (fill − ref) / ref × 10⁴`, notional-weighted. Unfilled limit orders' opportunity cost
  is real but cannot be scored without a counterfactual path — say "not included".
  *Inference.*

### Which denominator is honest

- **bps of notional** (`cost / Σ|notional| × 10⁴`) is defined whenever anything traded, does
  not change sign, and is the unit the fee schedule itself is quoted in (rate × position
  value, above). It answers "how expensive is my execution".
- **% of gross PnL** answers "how much of my edge do costs eat" but is a ratio of two
  quantities where the denominator can be near zero or negative: at gross +1 and fees 2 it
  prints 200%, at gross −1 it prints a negative drag. Show it only when gross is clearly
  positive (≥ 2× costs); otherwise print the currency figures and no ratio. *Inference
  (arithmetic).*
- **Maker share by notional.** A fill count treats a 1-contract fill like a 1,000-contract one;
  fees scale with position value, so the share that matters for cost is notional-weighted.
  Tradervue's liquidity reports likewise plot "the percentage of entry shares … where you
  added liquidity" and the same for exits — by volume, split entry vs exit.
  — Tradervue. *Liquidity reports*. https://www.tradervue.com/help/reports/liquidity_reports
- **Cost of holding** is funding per hour held, netted across hedge legs — see `funding.md` §7.

### How the wallet got here

- **Income types.** `/fapi/v1/income` lists `TRANSFER`, `WELCOME_BONUS`, `REALIZED_PNL`,
  `FUNDING_FEE`, `COMMISSION`, `INSURANCE_CLEAR`, `REFERRAL_KICKBACK`, `COMMISSION_REBATE` and
  15 further types; history covers the preceding three months.
  — Binance Developers. *Get Income History*.
  https://developers.binance.com/docs/derivatives/usds-margined-futures/account/rest-api/Get-Income-History
  The current code reads `TRANSFER`, `REALIZED_PNL`, `FUNDING_FEE`, `COMMISSION`. Anything
  else (rebates, kickbacks, insurance clearance, bonuses, other-asset flows) must land in an
  **"other"** line, not vanish, or the residual absorbs it silently.
- **Checks worth printing**, each as an absolute difference:
  1. `Σ REALIZED_PNL income` vs `Σ fill realizedPnl` in the window (already done per symbol in
     `journal.md`, *cross-check*);
  2. `Σ COMMISSION income` vs `Σ fill commission` (BNB converted);
  3. derived wallet now vs exchange `totalWalletBalance`;
  4. wallet + `totalUnrealizedProfit` vs account value (margin balance) — "equity is the margin
     balance" per `CLAUDE.md`.
  A non-zero residual is shown as its own step, as `overview.md` §3 already recommends.

## 7. Keep, add, drop

| Tab | Action | Item | Rule |
|---|---|---|---|
| Timing | Change | Hour buckets to IANA zone | `Intl.DateTimeFormat` like `sessions.js` |
| Timing | Add | Shrunk mean per trip per hour/weekday + interval | hide mean < 8 trips; k ≥ 4 |
| Timing | Add | "N buckets — expect ~N/20 by chance" line | always |
| Timing | Add | Hour × weekday **count** grid | sequential scale, no PnL |
| Timing | Keep | Calendar (close time), weekly/monthly totals with n | diverging, centred 0, glyph sign |
| Symbols | Change | Default sort to total net; top/bottom 5 + rest | — |
| Symbols | Add | Shrunk mean, bps cost, funding/hour held, ATR% at entry, size spread | n on every row |
| Symbols | Add | Top-3 share of gross absolute PnL, HHI of notional, `1/HHI` | no antitrust thresholds |
| Costs | Add | Cost in bps of notional (fees, funding separate) | headline |
| Costs | Change | Maker share to notional-weighted, weekly trend | n fills per week |
| Costs | Add | Effective fee rate vs `commissionRate` | show error |
| Costs | Add | "Other income" line and explicit residual in the wallet ledger | — |
| Costs | Add | Slippage | only with a live reference; else "not measured" |
| Costs | Drop | Fees as % of gross when gross ≤ 2 × costs; fees as % of net | — |

## Sources not used as evidence

Third-party fee summaries (Cryptopotato, Finder, TradersUnion), Quantpedia blog summaries of
the calendar-effect papers, and vendor-comparison blogs were read for leads only. The Binance
VIP fee table page renders client-side and could not be read; the PLOS ONE cividis paper was
behind a bot check on PMC and is cited from its bibliographic record; Wong (2011, *Nature
Methods*) was behind a login and is not cited; Perold (1988) is cited through a practitioner
restatement; the full list of 23 Binance income types could not be expanded; TraderSync's help
centre was not reachable. Thresholds (8 trips per displayed mean, gross ≥ 2 × costs, top/bottom
5, k ≥ 4) are judgement calls consistent with `outcome-factors.md`, not findings.
