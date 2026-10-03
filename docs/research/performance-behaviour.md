# Performance and Behaviour — what to show, and how to keep it honest at small n

Research for the journal's **Performance** and **Behaviour** tabs. Context: a few hundred
round trips over a few months, a hedged book (same-symbol long and short, cross margin, high
leverage), equity snapshots every 15 minutes while the server runs, transfers in the income
ledger, stops often absent. Sources are the papers, standards and vendor help pages that own
each claim, fetched 2026-10-03. No account data is used here.

Intervals for means and win rates, minimum-n floors, multiple comparisons and day-clustering
are already settled in [`outcome-factors.md`](outcome-factors.md); this note reuses them and
does not repeat them. Dashboard layout principles (Few, NN/g) are in
[`overview.md`](overview.md).

## Recommendations for this dashboard

| Decision | Recommendation |
|---|---|
| **Headline return** | **Time-weighted return (TWR)** from account-value snapshots, chain-linked daily, transfers removed. Show **money-weighted (IRR)** beside it only as "what your dollars earned" |
| **Daily series** | One return per UTC day: `r_d = (V_end − V_start − F_d) / (V_start + w_d·F_d)` (Modified Dietz, `w_d` = share of the day the flow was in). A day without a snapshot near both boundaries is `null`, never 0. Annualise on **365** days |
| **Drawdown** | From **account value** (incl. unrealised), never from cumulative closed-trip PnL. Show depth, start, trough, recovery date (or "not recovered, N days"), and the underwater curve. Print the expected max drawdown for a zero-edge book of the same volatility next to it |
| **Expectancy** | Keep **mean net per trip** (after fees and funding) as the headline per-trip number, with the day-cluster bootstrap interval from `outcome-factors.md`. Payoff ratio and win rate are its two factors — show them together or not at all |
| **Profit factor** | Keep, but print "—" when there are no losers, and show it only at **n ≥ 30** with its bootstrap interval |
| **Win rate** | Keep, with Wilson interval. Count a **hedge pair as one unit** when both legs overlap in time |
| **Sharpe / Sortino** | Add only with **≥ 60 daily returns**, always with a standard error (Mertens), plus the **probabilistic Sharpe ratio** P(SR > 0). Sortino with downside deviation over **all** days. Label both "daily, annualised ×√365, assumes independent days" |
| **R-multiples** | Only on trips with a real stop at entry, with coverage printed ("R on k of n trips"). Never impute R silently |
| **Streaks** | Show the longest losing streak **next to its expectation under chance** from a shuffle of the same win/loss sequence |
| **Previous period** | Show the difference with n on both sides; mark "within noise" when the difference interval spans 0 |
| **BTC benchmark** | Drop "vs holding BTC" as a headline. Show **beta and correlation** of daily returns to BTC instead; the book's benchmark is flat (0), not long BTC |
| **Habit cost** | Replace "mean gap × n" with a **mechanical counterfactual** per habit where one exists (remove the adds, rescale to usual size), and the group gap with interval where not. Never define a habit by the trip's final outcome and then cost it |
| **Habit presentation** | Each habit row: share of trips (trend by week), cost with interval and n, and a **"make it a goal"** link. Frame as a rule, not a verdict |

## 1. Performance metrics

### Returns with external flows

- GIPS requires **time-weighted returns** for all portfolios except those meeting specific
  criteria, and allows money-weighted returns only when the firm controls external cash flows
  and the fund is closed-end, fixed-life, fixed-commitment or illiquid.
  — CFA Institute (2026). *Overview of the Global Investment Performance Standards* (refresher
  reading). https://www.cfainstitute.org/insights/professional-learning/refresher-readings/2026/overview-of-the-global-investment-performance-standards
- Where valuations are not available at every flow, GIPS accepts a daily-weighted
  approximation (Modified Dietz) within a period, with the portfolio revalued at large flows
  and sub-periods **geometrically linked**.
  — GIPS Standards Q&A, *Cash flows*, Q8 (archived). https://www.gipsstandards.org/?GIPSID=034
- **Why both here.** The trader controls the flows, so the GIPS rationale for excluding MWR
  (flows are the client's, not the manager's) does not apply. TWR measures trading; MWR shows
  whether deposits arrived before losses. A large gap between them is itself a finding:
  money added before a drawdown. *Inference from the GIPS rationale.*
- **Snapshots are 15-minute and only while the server runs**, so a day's return needs a
  snapshot close to both boundaries. Missing days stay `null` — the same rule the calendar
  already follows for untraded days (`docs/journal.md`).

### Drawdown

- Expected maximum drawdown of a Brownian motion over horizon T: for zero drift
  **E[MDD] = √(π/2)·σ·√T ≈ 1.25·σ√T**; it grows as √T with zero drift, logarithmically with
  positive drift and linearly with negative drift.
  — Magdon-Ismail, M., Atiya, A. F., Pratap, A. & Abu-Mostafa, Y. S. (2004). On the maximum
  drawdown of a Brownian motion. *Journal of Applied Probability* 41(1), 147–161.
  https://www.cambridge.org/core/journals/journal-of-applied-probability/article/on-the-maximum-drawdown-of-a-brownian-motion/F9E3B8A454B020DDEBF0AC3390EF7807
- Consequences: (1) max drawdown is **not comparable across windows of different length** —
  a longer history has a deeper one by construction; (2) a useful honest label is "max
  drawdown X% · a zero-edge book with this volatility would expect ~Y% over this span".
- Drawdown family (duration, average drawdown, pain index, Calmar) is defined in Bacon; Calmar
  divides annualised return by max drawdown and inherits the length dependence above.
  — Bacon, C. R. (2008). *Practical Portfolio Performance Measurement and Attribution*, 2nd ed.,
  Wiley, ch. 4 (drawdown measures).
- **Hedged book:** closed-trip cumulative PnL can look flat while a large unrealised loss sits
  in an open leg (`docs/journal.md`, *How the wallet got here*). A drawdown from closed trips
  therefore understates the real one; only the account-value series is admissible.

### Expectancy, payoff, profit factor, win rate

- Expectancy per trade = win rate × average win − loss rate × average loss — the mean of the
  per-trade distribution; R-multiple expectancy is the same quantity in units of initial risk.
  — Tharp, V. K. (2007). *Trade Your Way to Financial Freedom*, 2nd ed., McGraw-Hill (R-multiples
  and expectancy chapters).
  — Kaufman, P. J. (2019). *Trading Systems and Methods*, 6th ed., Wiley (system performance
  measures).
- Tradervue defines profit factor as total profits ÷ total losses and **does not calculate it
  when all trades win or all lose**; it uses net P&L when that mode is selected.
  — Tradervue. *Report statistics*. https://www.tradervue.com/help/report_stats
- Profit factor is a ratio of two tail-dominated sums; one large loser moves it more than
  dozens of trades. Interval: the same day-cluster bootstrap as the mean. *Inference.*
- Win rate: Wilson interval, as in `outcome-factors.md` (Wilson 1927; Brown, Cai & DasGupta
  2001).
- **Hedged book:** both legs of a same-symbol hedge are separate trips. When they overlap they
  are mechanically opposed, so one tends to win while the other loses; counting them as two
  inflates n and pulls win rate towards 50%. Treat an overlapping pair as one unit for win rate
  and profit factor; keep per-leg trips for execution analysis. *Inference.*

### Sharpe and Sortino at small n

- Sharpe ratio = mean excess return ÷ standard deviation.
  — Sharpe, W. F. (1994). The Sharpe ratio. *Journal of Portfolio Management* 21(1), 49–58.
- Under IID returns the estimator's standard error is ≈ √((1 + SR²/2)/T); annualising by √q is
  valid only without serial correlation, and serial correlation overstated hedge-fund annual
  Sharpe ratios by up to 65%.
  — Lo, A. W. (2002). The statistics of Sharpe ratios. *Financial Analysts Journal* 58(4),
  36–52. doi:10.2469/faj.v58.n4.2453
- With skewness γ₃ and kurtosis γ₄ the variance becomes
  **(1 + SR²/2 − γ₃·SR + (γ₄−3)/4·SR²) / T** (Mertens 2002, as derived in Opdyke 2007).
  — Opdyke, J. D. (2007). Comparing Sharpe ratios: so where are the p-values? *Journal of Asset
  Management* 8(5), 308–336. https://www.efmaefm.org/0EFMAMEETINGS/EFMA%20ANNUAL%20MEETINGS/2007-Austria/papers/0385.pdf
- **Probabilistic Sharpe ratio**: PSR(SR*) = Φ((SR̂ − SR*)·√(T−1) / √(1 − γ₃·SR̂ + (γ₄−1)/4·SR̂²)),
  and the **minimum track record length** for a given confidence; negative skew and fat tails
  lengthen it.
  — Bailey, D. H. & López de Prado, M. (2012). The Sharpe ratio efficient frontier. *Journal
  of Risk* 15(2). https://www.risk.net/journal-risk/2223785/sharpe-ratio-efficient-frontier
- The **deflated** Sharpe ratio further corrects for the number of strategies tried.
  — Bailey, D. H. & López de Prado, M. (2014). The deflated Sharpe ratio. *Journal of Portfolio
  Management* 40(5), 94–107. https://papers.ssrn.com/abstract=2460551
  It is not needed here: the journal reports one realised account, not a selected backtest.
- Sortino: (mean − MAR) ÷ downside deviation, MAR chosen by the investor.
  — Sortino, F. A. & Price, L. N. (1994). Performance measurement in a downside risk framework.
  *Journal of Investing* 3(3), 59–65.
  Bacon computes downside deviation over **all** observations (shortfalls squared, others 0),
  not over the losing days only — the common implementation error.
- **High leverage, cross margin:** returns on equity are fat-tailed and negatively skewed
  (liquidation is a short-option payoff), so the IID-normal SE is too narrow and PSR's skew and
  kurtosis terms matter. Show PSR rather than a bare Sharpe. At 60 daily returns the SE of an
  annualised Sharpe is roughly ±2.5 under IID — print it. *Arithmetic from Lo's formula.*

### R-multiples when stops are often absent

- R is the initial risk: position size × stop distance from entry. In R mode Tradervue
  includes **only** trades with an initial risk set.
  — Tradervue. *Risk reporting*. https://www.tradervue.com/help/risk_reporting
- Tharp's SQN = mean R ÷ SD of R × √n; Tradervue warns it is unreliable below 30 trades. SQN
  is exactly the one-sample t-statistic of mean R, so it is a significance score, not a quality
  grade. — Tradervue, *Report statistics* (above); the t-statistic identity is arithmetic.
- **Here:** trips with a stop at entry are a self-selected subset; their R statistics do not
  describe the book. Show R with coverage, and if a volatility stop from `vol-estimator.js` is
  used as a stand-in, label it **implied R** in its own column.

### Streaks

- The longest run in n Bernoulli trials grows like log₁/ₚ(n·q) (p = probability of the
  streak's outcome); for p = ½ Schilling's rule of thumb is log₂(n/2) ± 3.
  — Schilling, M. F. (1990). The longest run of heads. *College Mathematics Journal* 21(3),
  196–207.
- With a 50% loss rate over 250 trips, a 7-trip losing streak is the *expected* longest. Show
  the observed streak against the distribution from shuffling the same sequence (B = 2000,
  fixed seed), which accounts for the real loss rate.
- Conditioning on streaks in a finite sequence is biased: the proportion of wins after a run of
  wins is expected to be *below* the base rate under independence.
  — Miller, J. B. & Sanjurjo, A. (2018). Surprised by the hot hand fallacy? A truth in the law
  of small numbers. *Econometrica* 86(6), 2019–2047. doi:10.3982/ECTA14943
  — Gilovich, T., Vallone, R. & Tversky, A. (1985). The hot hand in basketball. *Cognitive
  Psychology* 17(3), 295–314.
  So "win rate after 3 losses" must be compared with its shuffled expectation, not with the
  overall win rate.

### Comparing periods, and a benchmark

- People expect small samples to resemble the population ("law of small numbers").
  — Tversky, A. & Kahneman, D. (1971). Belief in the law of small numbers. *Psychological
  Bulletin* 76(2), 105–110.
- A period chosen because it was extreme will look better or worse next time by regression to
  the mean alone.
  — Barnett, A. G., van der Pols, J. C. & Dobson, A. J. (2005). Regression to the mean: what it
  is and how to deal with it. *International Journal of Epidemiology* 34(1), 215–220.
- **BTC as benchmark** answers "should I have held BTC?", a question about a directional,
  unlevered book. A hedged book targets near-zero delta; a beta and correlation to BTC daily
  returns say how directional it actually was, which is the useful number. *Inference.*

## 2. Behaviour

### Disposition effect

- Coined as selling winners too early and riding losers too long.
  — Shefrin, H. & Statman, M. (1985). The disposition to sell winners too early and ride
  losers too long. *Journal of Finance* 40(3), 777–790.
- Measured as **PGR − PLR**: on each sale date, realised gains ÷ (realised + paper gains)
  versus the same for losses, across every position held that day.
  — Odean, T. (1998). Are investors reluctant to realize their losses? *Journal of Finance*
  53(5), 1775–1798. https://faculty.haas.berkeley.edu/odean/papers/disposition/disposition.html
- Professional futures traders also hold losers longer than winners; relative discipline
  predicts later success.
  — Locke, P. R. & Mann, S. C. (2005). Professional trader discipline and trade disposition.
  *Journal of Financial Economics* 76(2), 401–444. doi:10.1016/j.jfineco.2004.01.004
- Propensity to sell jumps at zero return and is roughly flat over wide ranges of losses.
  — Kaustia, M. (2010). Prospect theory and the disposition effect. *JFQA* 45(3), 791–812.
- **For round trips:** the cheap measure is **median hold of losers ÷ median hold of
  winners** with n on each side. PGR/PLR is feasible because snapshots and prices give each
  open position's paper PnL at every close; on a hedged book compute it per pair, since a
  hedge always has one leg in paper loss.

### Overtrading

- Households that trade most earned 11.4% a year against the market's 17.9%; trading
  frequency is unrelated to **gross** returns and strongly related to **net**.
  — Barber, B. M. & Odean, T. (2000). Trading is hazardous to your wealth. *Journal of Finance*
  55(2), 773–806.
- Most day traders lose and keep trading.
  — Barber, B. M., Lee, Y.-T., Liu, Y.-J. & Odean, T. (2014). The cross-section of speculator
  skill: evidence from day trading. *Journal of Financial Markets* 18, 1–24.
- **Here:** bucket days by trip count (terciles) and show gross and net per trip side by side.
  Overtrading in Barber & Odean's sense is gross flat, net falling.

### Revenge, tilt, break-even and house money

- CBOT local traders with morning losses were ~16% more likely to take above-average
  afternoon risk.
  — Coval, J. D. & Shumway, T. (2005). Do behavioral biases affect prices? *Journal of
  Finance* 60(1), 1–34.
- After prior losses, gambles offering a chance to break even are especially attractive; after
  gains, risk seeking increases ("house money").
  — Thaler, R. H. & Johnson, E. J. (1990). Gambling with the house money and trying to break
  even. *Management Science* 36(6), 643–660. doi:10.1287/mnsc.36.6.643
- Loss chasing is a DSM-5 gambling-disorder criterion; most studies measure it by self-report,
  few by behavioural data, and within-session and between-session chasing are distinct.
  — Banerjee, N. et al. (2023). Loss chasing: a scoping review. *Journal of Gambling Studies*.
  https://link.springer.com/article/10.1007/s10899-022-10144-4
- **Operational definitions** (all at decision time):
  - *Revenge*: a trip opened within T minutes of closing a loser, sized > 1.5× the median of
    trips opened **before it** (`medianSizesBefore` already avoids look-ahead).
  - *Control*: trips opened within T minutes of closing a **winner** — without it, "fast
    re-entry" and "after a loss" are confounded. Running the same test after wins is the
    house-money check.
  - *Tilt*: a day where cumulative realised loss crosses a threshold and is followed by ≥ 3 more
    trips. Score the trips **after** the crossing against the day's earlier ones.
  - *Time-of-day fatigue*: no trading-specific primary source was found beyond Coval &
    Shumway's within-day effect. Treat "hours since the session's first trip" as an at-entry
    factor on the Factors tab, under its multiple-comparison rules.

### Adding while underwater, holding past the stop

- Both are already decision-time events in the data: an add fill below the running average,
  and price trading through a stop (the real one from `stop-check.js`, or the suggestion,
  labelled as such) with the position still open.

### Costing a habit without fooling yourself

The current cost is (mean net with habit − mean net of comparison) × trips with the habit.
Three problems:

1. **Selection on outcome.** "Winner turned loser" and "held losers longer" are defined by
   the final result; comparing them with other losers attributes to the habit what is partly
   just the loss. Their "cost" is close to tautological. Show them as **counts and shares**,
   not dollar costs. *Inference, following the leakage rule in `outcome-factors.md` §4.*
2. **The counterfactual is unstated.** The group gap assumes the habit's trips would have
   behaved like the comparison trips. A **mechanical counterfactual** is sharper where it
   exists:
   - *Added while underwater:* replay the trip without the add fills (initial size, same exits
     pro rata). Cost = actual net − replayed net.
   - *Bigger after a loss:* rescale the trip to the prior median size. Cost = net × (1 −
     median/actual). This is exact for linear PnL, ignoring fee tiers.
   These answer "what did *this* habit cost on *these* trips", not "are these trips different".
3. **No interval.** Use the day-cluster bootstrap from `outcome-factors.md`; hide below 10 on
   either side, grey 10–19, and print n and days on every row.

### Presenting habits so they change behaviour

- Across 607 effect sizes, feedback interventions **reduced** performance in about a third of
  cases; feedback that draws attention to the self rather than the task weakens the effect.
  — Kluger, A. N. & DeNisi, A. (1996). The effects of feedback interventions on performance.
  *Psychological Bulletin* 119(2), 254–284.
- If-then plans ("if I am down on the trip, then I do not add") raise goal attainment over
  goal intentions alone.
  — Gollwitzer, P. M. (1999). Implementation intentions. *American Psychologist* 54(7),
  493–503.
- **So:** describe the action, not the trader ("adds while underwater", not "revenge trader");
  show the share of trips with the habit **by week** so improvement is visible; offer "make it
  a goal" that creates the matching rule in Goals, scored from that day.

## 3. What journal products put on these pages

| Product | Performance | Behaviour / discipline | Source |
|---|---|---|---|
| **Tradervue** | Total and average daily P&L, avg win/loss, max consecutive wins/losses, P&L SD, **probability of random chance** (one-tailed t-test), K-ratio, Kelly, profit factor, hold time by outcome, MAE/MFE; SQN only in R mode, "not reliable with less than 30 trades" | Tags; R mode excludes trades without initial risk | tradervue.com/help/report_stats · tradervue.com/help/risk_reporting · help.tradervue.com/article/3440-mfe-and-mae-calculations |
| **Edgewonk** | Weekly, monthly and session reports; Edge Finder "scans your journal to uncover strengths, weaknesses" | **Tiltmeter**: red with frequent rule violations, green with adherence; revenge trading and cutting winners named as targets | edgewonk.com/features · edgewonk.com/blog/mastering-trading-discipline-with-edgewonks-tiltmeter |
| **Tradezella** | Risk report: R-multiple buckets, average planned vs realised R (only trades with stop inputs) | Zella Scale: potential vs actual P&L per trade | help.tradezella.com/en/articles/6509413-reports-risk · …/7218420-zella-scale-maximize-your-trade-insights |

Tradervue alone shows a significance figure; none shows intervals on win rate or expectancy.
TraderSync's help centre was not reachable (as in `overview.md`), so it is not cited.

**Showing uncertainty.** Encoding mean and error changes decisions; gradient and violin plots
beat bar-plus-error-bar for inference (Correll, M. & Gleicher, M. (2014). Error bars
considered harmful. *IEEE TVCG* 20(12), 2142–2151). Quantile dotplots let lay readers count
outcomes and reduced estimate variance (Kay, M., Kola, T., Hullman, J. & Munson, S. (2016).
When (ish) is my bus? *CHI 2016*. https://idl.uw.edu/papers/when-ish-is-my-bus). Spiegelhalter
recommends stating uncertainty in words alongside numbers (Spiegelhalter, D. (2017). Risk and
uncertainty communication. *Annual Review of Statistics and Its Application* 4, 31–60).
Applied here: a faded interval band behind each bar, and words — "within noise", "thin" —
beside numbers.

## 4. Keep, add, drop

| | Metric | Formula / rule | Min sample |
|---|---|---|---|
| Keep | Mean net per trip | Σnet / n, day-cluster bootstrap CI | show ≥ 10, CI ≥ 20 |
| Keep | Win rate | wins / n, Wilson CI, hedge pair = 1 unit | ≥ 10 |
| Keep | Payoff ratio | avg win / \|avg loss\| | ≥ 10 wins and ≥ 10 losses |
| Keep | Profit factor | Σwins / \|Σlosses\|, "—" if no losers | ≥ 30 |
| Keep | Underwater curve | V_t / max(V_≤t) − 1 on account value | any |
| Change | Max drawdown | account value only; add duration, recovery, E[MDD] at zero edge | any, with span |
| Change | Habit cost | mechanical counterfactual where defined; group gap with CI otherwise | 10 per side |
| Change | Outcome-defined habits | counts and shares only, no dollar cost | — |
| Add | TWR | Π(1 + r_d) − 1, Modified Dietz per day | ≥ 7 covered days |
| Add | MWR | IRR of transfers + end value | — |
| Add | Sharpe ± SE, PSR | Mertens SE; PSR(0) | ≥ 60 daily returns |
| Add | Sortino | downside dev over all days, MAR = 0 | ≥ 60 daily returns |
| Add | Streak vs chance | observed vs shuffled distribution | ≥ 30 trips |
| Add | Disposition ratio | median hold losers / winners | ≥ 10 each |
| Add | Overtrading | gross and net per trip by day-activity tercile | ≥ 8 days per tercile |
| Add | BTC beta / correlation | OLS of daily r on BTC daily r | ≥ 30 days |
| Drop | Return vs holding BTC | wrong benchmark for a hedged book | — |
| Drop | Bare annualised Sharpe | never without SE | — |
| Drop | SQN as a grade | it is a t-statistic | — |

## Sources not used as evidence

Vendor marketing pages, review sites and trading-education blogs (SQN glossaries, "revenge
trading" articles) were read for leads only. Gambling loss-chasing literature is cited for its
definitions, not as evidence about traders. Thresholds (T minutes, 1.5× size, ≥ 60 days,
≥ 30 trips for streaks and profit factor, ≥ 8 days per tercile) are judgement calls consistent
with `outcome-factors.md`, not findings. The general-p longest-run approximation is Schilling's;
its p = ½ rule was confirmed against a secondary summary because the paper's PDF could not be
read.
