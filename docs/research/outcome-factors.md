# What correlates with outcome — statistical method notes

Research for a journal view that ranks per-trip factors by their effect on net PnL per trip and
on win rate, with n and an interval. Context: ~250 closed round trips over ~4.5 months, many
symbols, heavy-tailed per-trip PnL, a hedged book. No account data is used here.

## Recommendations for this journal

| Decision | Recommendation |
|---|---|
| **Effect measure (PnL)** | **Difference in mean net PnL per trip**, bucket vs rest of book. Show the **median** beside it and flag the row when the two disagree in sign. Show each bucket's **share of total net PnL**, so one outlier trip is visible. Trimmed mean only as a "robust" secondary column, labelled as a different quantity |
| **Effect measure (win rate)** | Win rate per bucket with a **Wilson score interval**; difference vs rest with **Newcombe's hybrid score interval** (built from the two Wilson intervals) |
| **PnL interval** | **Seeded cluster bootstrap** (resample whole days), percentile interval, B = 2000, fixed seed so the page shows the same numbers on every load. Also compute a **Welch** interval; show the **wider** of the two. Percentile bootstrap under-covers at small n, and Welch is unreliable under heavy skew; the wider one is the honest one |
| **Minimum n** | Hide a bucket below **20 trips or 8 distinct days**. Show 20–39 trips greyed as "thin". Print n (trips and days) on every row |
| **Multiple comparisons** | Label the whole view **exploratory**, print how many comparisons it shows, and use **Benjamini–Hochberg at q = 0.10** only to decide which rows get a "stands out" mark. No Bonferroni: it is built for a different question (any false positive at all) and would hide everything at this n |
| **Leakage** | Split factors into **At entry** (eligible for ranking) and **During the trade** (hold time, adds while underwater, MAE/MFE, funding paid, exit reason). The second group is shown in a separate, labelled section and never ranked together with the first |
| **Confounding** | Marginal comparisons are acceptable if the view says **"association, not cause"**. Add one **stratified** check per row: the same comparison within size terciles and within hedged / unhedged, flagged if the sign flips. Skip multivariable regression for now |
| **Continuous factors** | **Terciles on the full sample**, cut points computed by rule, never chosen after looking. Where a domain threshold already exists in code (ATR regime labels, session boundaries), use that instead. Never search for the "best" cut point |
| **Dependence** | **Cluster by UTC calendar day**, and put both legs of a same-symbol hedge in the same cluster. Effective n is the number of days, not trips |
| **Stability check** | **Chronological 70/30 early/recent split**, reusing the confluence vocabulary: **holds** (same sign), **fades** (sign flips), **thin** (too few recent trips). It is an honesty check, not validation — nothing is fitted |

## 1. Effect measure for heavy-tailed PnL

- **The mean is the target because total PnL is a sum.** Total net PnL over a bucket is exactly
  n × mean; no other location statistic has this property. A factor that changes the median
  but not the mean does not change what the account earns. Expectancy per trade is the mean.
- **The mean is fragile.** It has zero breakdown point: one trip can move it arbitrarily. The
  NIST/SEMATECH handbook lists mean, median and trimmed mean and notes the median and trimmed
  mean are preferred for location when the tails are heavy — but that is about *estimating the
  centre*, not about what sums to the account.
  — NIST/SEMATECH e-Handbook of Statistical Methods, §1.3.5.1 *Measures of Location*.
  https://www.itl.nist.gov/div898/handbook/eda/section3/eda351.htm
- **A trimmed mean estimates a different quantity.** Under skew the population trimmed mean is
  not the population mean, so a trimmed-mean difference answers "does the typical trip differ",
  not "does the bucket earn more". Yuen's trimmed t is the standard two-sample test for it.
  — Yuen, K. K. (1974). The two-sample trimmed t for unequal population variances.
  *Biometrika* 61(1), 165–170. doi:10.1093/biomet/61.1.165
  — Wilcox, R. R. (2022). *Introduction to Robust Estimation and Hypothesis Testing*, 5th ed.,
  Academic Press, ch. 3–5 (trimmed means, their standard errors, two-group comparisons).
- **So:** mean as the headline, median as a disagreement flag, share of total so a single
  outlier explains itself.

## 2. Confidence intervals with small, skewed samples

**Bootstrap.**
- Percentile and BCa intervals are defined in Efron & Tibshirani ch. 13–14; BCa corrects bias
  and skewness with an acceleration estimated by the jackknife, and is second-order accurate
  where the percentile interval is first-order. They recommend B ≈ 1000 or more for interval
  endpoints (vs 50–200 for a standard error), because endpoints live in the tails.
  — Efron, B. & Tibshirani, R. J. (1993). *An Introduction to the Bootstrap*. Chapman & Hall,
  ch. 13–14, 19. doi:10.1201/9780429246593
  — Efron, B. (1987). Better bootstrap confidence intervals. *JASA* 82(397), 171–185.
  doi:10.1080/01621459.1987.10478410
- **Small n warning.** The percentile interval is too narrow in small samples (the bootstrap
  distribution has spread roughly √((n−1)/n) of the truth, plus skew not captured); Hesterberg
  reports it is less accurate than the t-interval for small samples and under-covers badly.
  — Hesterberg, T. C. (2015). What teachers should know about the bootstrap. *The American
  Statistician* 69(4), 371–386. doi:10.1080/00031305.2015.1089789 · arXiv:1411.5279
- **Heavy tails.** With infinite variance the bootstrap of the mean is inconsistent. Crypto
  per-trip PnL is heavy-tailed but bounded by account size, so this is a caution, not a
  blocker: it is why the share-of-total column and the median flag exist.
  — Athreya, K. B. (1987). Bootstrap of the mean in the infinite variance case. *Annals of
  Statistics* 15(2), 724–731. doi:10.1214/aos/1176350371
- **Determinism.** The bootstrap is Monte Carlo; fixing the seed makes it reproducible without
  changing its statistical properties (Efron & Tibshirani ch. 19 discuss the Monte Carlo error
  as a function of B). Node has no seeded RNG, so a small PRNG (e.g. mulberry32 or xorshift128+,
  a dozen lines) is needed. B = 2000 × ~30 rows × ~250 trips is ~15M draws — well under a second.
- **BCa is feasible** (the jackknife over clusters is n_days extra means), but its acceleration
  estimate is itself noisy at small n; given the "show the wider of bootstrap and Welch" rule,
  percentile is enough to start. Upgrade to BCa if rows commonly sit at n 20–40.

**Student t / Welch.**
- Welch's interval handles unequal variances, which buckets will have. It relies on the CLT for
  the mean; under strong skew its coverage is asymmetric at small n.
  — Welch, B. L. (1947). The generalization of 'Student's' problem when several different
  population variances are involved. *Biometrika* 34(1–2), 28–35. doi:10.1093/biomet/34.1-2.28
- Taking the wider of Welch and bootstrap is a conservative pragmatic rule, not a named method;
  say so in the doc that ships with the view.

**Minimum n.** No primary source gives a universal cut-off. Hesterberg's simulations show
percentile-bootstrap under-coverage persisting well past n = 30 for skewed data. 20 is a floor
for showing anything; 40 is where a row stops being "thin". These are judgement calls,
consistent with the project rule "show the sample size next to every derived number".

**Win rate.**
- Wilson score interval: invert the score test; stays inside [0, 1] and behaves at small n.
  — Wilson, E. B. (1927). Probable inference, the law of succession, and statistical inference.
  *JASA* 22(158), 209–212. doi:10.1080/01621459.1927.10502953
- The Wald interval p̂ ± z·√(p̂(1−p̂)/n) has erratic, often poor coverage even at large n; Wilson
  (or Jeffreys) is recommended for n ≤ 40 and generally.
  — Brown, L. D., Cai, T. T. & DasGupta, A. (2001). Interval estimation for a binomial
  proportion. *Statistical Science* 16(2), 101–133. doi:10.1214/ss/1009213286
- For a *difference* of two win rates, Newcombe's method 10 combines two Wilson intervals and
  performs well among eleven methods compared.
  — Newcombe, R. G. (1998). Interval estimation for the difference between independent
  proportions: comparison of eleven methods. *Statistics in Medicine* 17(8), 873–890.
  doi:10.1002/(SICI)1097-0258(19980430)17:8<873::AID-SIM779>3.0.CO;2-I
- Wilson assumes independent trips; with day clusters it is too narrow. Either use the cluster
  bootstrap for win rate too, or keep Wilson and state the assumption.

## 3. Multiple comparisons and data snooping

- **Scale of the problem.** ~15 factors × 2–4 buckets is 40–60 comparisons. At 95% intervals,
  2–3 will exclude zero by chance alone.
- **Bonferroni** controls the family-wise error (any false positive). At m = 50 it demands
  per-test α = 0.001 — nothing at this n will pass, which hides real signal along with noise.
- **Benjamini–Hochberg** controls the false discovery rate (expected share of flagged rows that
  are false), is more powerful, and is proven under independence (and positive dependence).
  Procedure: sort p-values, flag the largest k with p(k) ≤ (k/m)·q.
  — Benjamini, Y. & Hochberg, Y. (1995). Controlling the false discovery rate: a practical and
  powerful approach to multiple testing. *JRSS B* 57(1), 289–300.
  doi:10.1111/j.2517-6161.1995.tb02031.x
  — Benjamini, Y. & Yekutieli, D. (2001). The control of the false discovery rate in multiple
  testing under dependency. *Annals of Statistics* 29(4), 1165–1188. doi:10.1214/aos/1013699998
  (buckets of one factor are dependent; BY is the conservative fallback).
- **Data snooping.** When many rules are tried on one dataset, the best one's performance must be
  judged against the whole search; White's Reality Check bootstraps the maximum over all
  candidates. Bailey & López de Prado deflate a Sharpe ratio by the number of trials; Bailey et
  al. estimate the probability that the in-sample best is below median out of sample.
  — White, H. (2000). A reality check for data snooping. *Econometrica* 68(5), 1097–1126.
  doi:10.1111/1468-0262.00152
  — Bailey, D. H. & López de Prado, M. (2014). The deflated Sharpe ratio: correcting for
  selection bias, backtest overfitting and non-normality. *Journal of Portfolio Management*
  40(5), 94–107. doi:10.3905/jpm.2014.40.5.094
  — Bailey, D. H., Borwein, J., López de Prado, M. & Zhu, Q. J. (2017). The probability of
  backtest overfitting. *Journal of Computational Finance* 20(4), 39–69. doi:10.21314/JCF.2016.322
- **Proportionate here.** The journal does not pick a strategy and deploy capital on it
  automatically; it prompts a person to look. Reality Check / DSR / PBO are built for selecting
  among many fitted strategies and are out of proportion. Proportionate: (a) intervals on every
  row, (b) a visible "N comparisons — expect about N/20 to look significant by chance" line,
  (c) BH at q = 0.10 for the "stands out" mark, (d) the early/recent stability check (§7), which
  is the cheap analogue of out-of-sample testing. The factor list is fixed in code, so the
  number of comparisons is honest — adding factors later raises m and must be reflected.

## 4. Look-ahead and post-entry variables

- A factor must be known **at the moment of entry** to be a candidate cause of the outcome.
  Variables determined after entry are partly *consequences* of how the trade is going, so
  conditioning on them biases the comparison even if they are measured perfectly.
  — Rosenbaum, P. R. (1984). The consequences of adjustment for a concomitant variable that has
  been affected by the treatment. *JRSS A* 147(5), 656–666. doi:10.2307/2981697
  — Hernán, M. A. & Robins, J. M. (2020/updated). *Causal Inference: What If*. Chapman & Hall/CRC,
  ch. 7 (confounding) and ch. 8 (selection bias — conditioning on a common effect).
  https://miguelhernan.org/whatifbook
  — Montgomery, J. M., Nyhan, B. & Torres, M. (2018). How conditioning on posttreatment variables
  can ruin your experiment and what to do about it. *AJPS* 62(3), 760–775. doi:10.1111/ajps.12357
- In predictive terms this is **leakage**: a feature that encodes the target.
  — Kaufman, S., Rosset, S., Perlich, C. & Stitelman, O. (2012). Leakage in data mining:
  formulation, detection, and avoidance. *ACM TKDD* 6(4), 15. doi:10.1145/2382577.2382579

| At entry — rank these | During the trade — separate, labelled section |
|---|---|
| Session at entry, day of week (entry time) | Hold time (a loser held to stop vs a winner cut early) |
| ATR regime, BTC trend at entry (bars closed before entry) | Adds while underwater (only possible if price went against you) |
| Size vs trailing median (median of trips *before* this one) | MAE / MFE |
| Side, leverage, margin % at entry | Funding paid/received (scales with hold time) |
| Hedged at entry (opposite leg open at entry time) | Exit reason, number of partial exits |
| After a loss / after a win (previous trip *closed* before entry) | Hedged at any point during the trip |
| Confluence score at entry (later) | |

Two subtle cases: **size vs median** must use a trailing median, or the bucket boundary leaks
future trips; **after a loss/win** must use the last trip whose *close* precedes this entry,
not the last trip by open time. Market factors must use bars that closed before entry.

## 5. Confounding

- Factors overlap (weekend trips may be larger; hedged trips may be longer). A marginal
  comparison mixes the factor's association with everything correlated with it. Hernán & Robins
  ch. 7 defines this as confounding and ch. 4 shows stratification as the model-free remedy;
  with no randomisation, nothing here licenses a causal claim, so "association, not cause" is
  the correct label, not a hedge.
- **Stratification** is feasible and transparent at this n if limited to one or two strata
  variables (size tercile, hedged yes/no). Its use here is a sign-flip check (Simpson's
  paradox), not a pooled adjusted estimate — strata of ~30 trips give wide intervals.
- **Multivariable regression** is easy to code without dependencies (OLS via normal equations,
  or logistic via IRLS, a few dozen lines), but: ~15 factors expand to ~30 dummy parameters;
  common guidance is ≥ 10–20 observations (or events) per parameter, which ~250 trips cannot
  support, and OLS on heavy-tailed PnL is dominated by a few trips.
  — Peduzzi, P. et al. (1996). A simulation study of the number of events per variable in
  logistic regression analysis. *J Clin Epidemiol* 49(12), 1373–1379.
  doi:10.1016/S0895-4356(96)00236-3
  — Harrell, F. E. (2015). *Regression Modeling Strategies*, 2nd ed., Springer, §4.4 (limiting
  model complexity). doi:10.1007/978-3-319-19425-7
- **Recommendation:** marginal + one stratified sign check now; revisit regression with a
  pre-chosen 4–6 factors once there are 500+ trips.

## 6. Dependence between trips

- Bootstrap and Wilson intervals assume independent observations. Hedged legs opened together,
  pyramided entries and same-day clusters share market moves, so effective n is smaller and
  naive intervals are too narrow.
- For grouped data, resample whole groups (the cluster / hierarchical bootstrap): Davison &
  Hinkley §3.8 show resampling at the top level preserves within-group correlation. For serially
  dependent series, ch. 8 covers block resampling; Künsch introduced the moving-block bootstrap.
  — Davison, A. C. & Hinkley, D. V. (1997). *Bootstrap Methods and their Application*. Cambridge
  University Press, §3.8 and ch. 8. doi:10.1017/CBO9780511802843
  — Künsch, H. R. (1989). The jackknife and the bootstrap for general stationary observations.
  *Annals of Statistics* 17(3), 1217–1241. doi:10.1214/aos/1176347265
- With few clusters, cluster-robust inference degrades; the cluster bootstrap behaves better
  than analytic cluster SEs but still needs a reasonable number of clusters.
  — Cameron, A. C., Gelbach, J. B. & Miller, D. L. (2008). Bootstrap-based improvements for
  inference with clustered errors. *Review of Economics and Statistics* 90(3), 414–427.
  doi:10.1162/rest.90.3.414
- **Here:** cluster = UTC calendar day of entry, with both legs of a same-symbol hedge forced
  into the earlier leg's day. ~139 days is enough clusters overall; per bucket, require ≥ 8 days.
  A bucket concentrated in 3 days is 3 observations, whatever its trip count.

## 7. Stability / out-of-sample check

- The standard remedy for optimistic in-sample estimates is to evaluate on data not used to
  form the conclusion; for time-ordered data the holdout must be the later period, never a
  random split.
  — Hastie, T., Tibshirani, R. & Friedman, J. (2009). *The Elements of Statistical Learning*, 2nd
  ed., Springer, ch. 7 (model assessment; §7.10.2 "the wrong and right way to do cross-validation").
  https://hastie.su.domains/ElemStatLearn/
  — Tashman, L. J. (2000). Out-of-sample tests of forecasting accuracy: an analysis and review.
  *International Journal of Forecasting* 16(4), 437–450. doi:10.1016/S0169-2070(00)00065-0
- **Reasonable here, with caveats.** Factors and bucket rules are fixed in code, not fitted, so
  the 70/30 split checks *stability*, not overfitting — the same framing `docs/confluence.md`
  already uses. With ~75 recent trips most buckets will be "thin" on the recent side; sign
  agreement is the only test the recent window can bear. Bucket cut points (terciles) must be
  computed on the early window and applied unchanged to the recent window, or the split leaks.
  Trader behaviour drifts (the person reading the journal changes how they trade), so "fades"
  is informative in itself.

## 8. Bucketing continuous factors

- Choosing the cut point that maximises the difference (minimum p-value) inflates false
  positives severely — Altman et al. report type I error around 40% at a nominal 5% — and
  overstates the effect. Cut points must be fixed before looking.
  — Altman, D. G., Lausen, B., Sauerbrei, W. & Schumacher, M. (1994). Dangers of using "optimal"
  cutpoints in the evaluation of prognostic factors. *JNCI* 86(11), 829–835.
  doi:10.1093/jnci/86.11.829
- Categorising a continuous variable throws away information; it is acceptable for display but
  not the most efficient analysis.
  — Royston, P., Altman, D. G. & Sauerbrei, W. (2006). Dichotomizing continuous predictors in
  multiple regression: a bad idea. *Statistics in Medicine* 25(1), 127–141. doi:10.1002/sim.2331
- **Rule:** terciles (three buckets keep ~80 trips each at this n; quartiles drop to ~60 and
  thin out after day-clustering). Use existing domain thresholds where the code already defines
  them (ATR regime labels, session boundaries, funding sign) so the journal and the rest of the
  dashboard agree. The rule is the same for every continuous factor and is not tuned per factor.

## Sources not used as evidence

Blog posts, trading-education material on "expectancy" and vendor docs were not cited; every
claim above points to the paper or book that owns it. Thresholds marked as judgement calls
(min n 20 / 40, ≥ 8 days, B = 2000, q = 0.10, wider-of-two rule) are proposals, not findings.
