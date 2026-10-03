# The journal Overview — what a first screen should hold

Research for remodelling the journal's Overview tab, which currently stacks seven blocks
(goals line, period strip, wallet vs account chart, "Where the account stands", "How it got
here", "Open right now", "Activity") and reads as patchwork. Sources are the authors' own
books and articles, design-system guidelines and the journal vendors' own help pages. No
account data is used here.

## What this means for the Overview

| Decision | Recommendation |
|---|---|
| **Question the first read answers** | *"Am I on track this period, and does anything need me?"* Everything above the fold serves that; the rest is one click away (Few's definition; NN/g inverted pyramid) |
| **Order** | 1. **Needs attention** (0–3 items, or an explicit "nothing needs attention") → 2. **Goal progress** against target → 3. **Period strip** with comparison → 4. **One equity chart** → 5. **Recent trips** (last 5) → 6. a single footer line of activity metadata. Most important top-left, background last (Few; PatternFly; Schade) |
| **Context on every number** | Each period figure shows a comparison: vs the previous like period and/or vs goal, plus n (trips) beside it. A bare "+X this week" fails Few's pitfall #2 and NN/g's "compared to what" rule |
| **Goals** | Render as a bullet-graph-style bar (actual vs target, with the elapsed share of the period marked), not a sentence. Goal progress is what Tradezella's Progress Tracker and Edgewonk's Tiltmeter put on the home view |
| **Needs attention** | A short, prioritised list drawn from the other tabs: a rule broken today, the top habit cost this week, a factor that "fades", a goal off pace. Cap it, rank by cost, link each item to its tab. Never a stream of every flag (alert fatigue) |
| **Remove duplication with the main dashboard** | "Where the account stands" (free margin, open count, locked in hedges) and "Open right now" restate the sidebar and the position tiles. Keep only account value + period change on the Overview; replace the open table with one line ("3 open · uPnL −X · view on dashboard") or drop it |
| **Reconciliation ("How it got here")** | Move to a detail surface — the Costs tab or a drawer opened from account value. On the Overview, at most a one-line bridge or its two largest movers (fees, funding). A full start→end bridge is a calculation scheme, which IBCS and Excel treat as an analysis chart, not a glance item |
| **Charts** | One full chart (account value, wallet as the secondary line). Everything else that wants a trend gets a **sparkline** next to its number, not another chart (Tufte) |
| **Recent trades** | Add the last ~5 closed trips (symbol, side, net, tags/notes icon) — every journal product reviewed leads or closes its dashboard with recent trades; it is the bridge into the Trades tab |
| **Activity block** | Demote to a muted footer line: "N fills · M trips · K trading days · since DATE". It is background, not a finding |
| **Density and grouping** | One screen, no scroll on a laptop if possible. Group by question (on track? / what needs me? / how did it move?) rather than by data source. Remove borders and headings that only separate, not inform (Few: simplicity; NN/g guideline 6/8) |
| **Scorecard metrics** | Win rate and profit factor with n are the standard "health" pair across Tradezella, Edgewonk and Tradervue. Show them only in the period strip, with n; the full distribution stays on Performance |

## 1. Dashboard design principles

**Stephen Few**
- Definition: a dashboard is "a visual display of the most important information needed to
  achieve one or more objectives; consolidated and arranged on a single screen so the
  information can be monitored at a glance." Two consequences for this page: every block must
  serve a stated objective, and anything that needs scrolling or tab-switching to compare is
  not at-a-glance.
  — Few, S. (2006). *Information Dashboard Design: The Effective Visual Communication of Data*.
  O'Reilly. ch. 2. (2nd ed. 2013, Analytics Press.)
- Thirteen common pitfalls; the first two map directly onto the current page: **exceeding the
  boundaries of a single screen** (viewers fall back on short-term memory) and **supplying
  inadequate context for the data** (a measure without comparison, target or trend). Others
  relevant here: excessive detail or precision, meaningless variety, arranging data poorly,
  ineffectively highlighting what is important, cluttering the display with decoration.
  — Few, S. (2006). *Common Pitfalls in Dashboard Design*. Perceptual Edge white paper.
  https://www.perceptualedge.com/articles/Whitepapers/Common_Pitfalls.pdf
- Placement: "Few aspects of visual design emphasize some data above the rest as effectively
  as its location" — always-important data top-left; the guiding principle is "simplicity:
  display the data as clearly and simply as possible, and avoid unnecessary and distracting
  decoration." Bullet graphs and sparklines are his compact forms for target and trend.
  — Few (2006), as quoted in Gabriel-Petit, P. (2007). Book review: *Information Dashboard
  Design*. UXmatters. https://www.uxmatters.com/mt/archives/2007/04/book-review-information-dashboard-design.php
- Bullet graph: a bar for the measure, a tick for the target, shaded bands for qualitative
  ranges — designed to replace gauges on dashboards.
  — Few, S. (2006, rev. 2013). *Bullet Graph Design Specification*. Perceptual Edge.
  https://www.perceptualedge.com/articles/misc/Bullet_Graph_Design_Spec.pdf

*perceptualedge.com sits behind a bot check; the white papers were confirmed by title and
date but quoted via the book and the review above.*

**Edward Tufte**
- Sparkline: "a small intense, simple, word-sized graphic with typographic resolution" that
  "can be everywhere a word or number can be: embedded in a sentence, table, headline". The
  worked example puts history beside the current value so the reader judges deviation without
  opening a separate chart.
  — Tufte, E. (2004). *Sparkline theory and practice*. edwardtufte.com notebook.
  https://www.edwardtufte.com/notebook/sparkline-theory-and-practice-edward-tufte/
  — Tufte, E. (2006). *Beautiful Evidence*. Graphics Press, ch. "Sparklines".
- Data-ink: maximise the share of ink that shows data; erase non-data and redundant data-ink.
  Small multiples: the same frame repeated so the eye compares one change at a time.
  "At the heart of quantitative reasoning is a single question: Compared to what?"
  — Tufte, E. (2001). *The Visual Display of Quantitative Information*, 2nd ed. ch. 4–6.
  — Tufte, E. (1990). *Envisioning Information*. Graphics Press, ch. 4 "Small Multiples", p. 67.

**Nielsen Norman Group**
- Dashboards are "collections of data visualizations, presented in a single-page view that
  imparts at-a-glance information on which users can act quickly." Distinguishes operational
  (time-critical) from analytical dashboards; a journal Overview is analytical. Encode the
  important quantities by position and length; colour reinforces, never carries alone.
  — Laubheimer, P. (2017-06-18). *Dashboards: Making Charts and Graphs Easier to Understand*.
  https://www.nngroup.com/articles/dashboards-preattentive/
- "Numbers are meaningless without context … People need to compare a number against another
  number in order to interpret it."
  — Moran, K. (2022-01-30). *Choosing Chart Types: Consider Context*.
  https://www.nngroup.com/articles/choosing-chart-types/
- Inverted pyramid: "the most important information (or what might even be considered the
  conclusion) is presented first", then supporting details, background last.
  — Schade, A. (2018-02-11). *Inverted Pyramid: Writing for Comprehension*.
  https://www.nngroup.com/articles/inverted-pyramid/
- Progressive disclosure: "Initially, show users only a few of the most important options.
  Offer a larger set of specialized options upon request." Get the split right, make the path
  to the second layer obvious, and stay within two levels.
  — Nielsen, J. (2006-12-03). *Progressive Disclosure*.
  https://www.nngroup.com/articles/progressive-disclosure/
- Guidelines 6 "Reduce clutter without reducing capability", 7 "Ease transition between
  primary and secondary information", 8 "Make important information visually salient" — and
  salience often comes from removing nonessential elements rather than adding emphasis.
  — Kaplan, K. (2020-11-08). *8 Design Guidelines for Complex Applications*.
  https://www.nngroup.com/articles/complex-application-design/

**Design systems**
- "You want the most important cards at the top, with less important cards at the bottom";
  one metric or one closely related group per card; aggregate status cards show a total plus
  only the non-zero exception counts, each linking to its detail view.
  — PatternFly (Red Hat). *Dashboard — design guidelines*.
  https://www.patternfly.org/patterns/dashboard/design-guidelines
- Material and Apple HIG offer only general hierarchy guidance (content first, one concept
  per card); neither has a summary-screen rule beyond Few and NN/g, so they are not relied on.

## 2. How trading-journal products structure their overview

| Product | What leads | Also on the home view | Source |
|---|---|---|---|
| **Tradezella** | Upper row of stat widgets: Net P&L, Account Balance & P&L, Trade Win %, Profit Factor, Day Win %, Avg Win/Loss, Expectancy, streaks, drawdown | Calendar (green/red/grey days), Recent Trades & Open Positions, cumulative P&L chart, Progress Tracker (today's rule score + heat map); fully drag-and-drop | help.tradezella.com/en/articles/7118437-understanding-dashboard-widgets-and-stats · …/10352075-how-to-add-the-progress-tracker-widget-to-your-dashboard · …/9689020-advanced-calendar-widget-in-tradezella-dashboard |
| **Tradervue** | Most recent trading day, then performance over the last week / 5 trading days | Open trades (also to spot missing executions), shared trades with comments; customisable widgets with "Reset to Default". Reports › Overview › Recent: daily P&L, cumulative P&L, volume, win % over 30 days | help.tradervue.com/article/3434-customize-your-dashboard · help.tradervue.com/article/3423-reports-and-statistics |
| **Edgewonk** | Key metrics: net return, win rate, profit factor | Aggregated equity curve, profit calendar, performance charts (Portfolio, 2025-01-22); Tiltmeter for rule-breaking | edgewonk.com/blog/announcing-the-new-portfolio-feature-in-edgewonk |

Common pattern: **(1) a small row of headline numbers — net P&L, win rate, profit factor;
(2) one cumulative curve; (3) a calendar; (4) recent/open trades; (5) a discipline/goal
widget**. None put a cash reconciliation on the dashboard. Tradervue's note that "not everyone
wants to see all of it all the time" is why they all allow hiding widgets — a sign the default
is too full, not a feature to copy here. TraderSync's own help centre could not be reached
(search returns the unrelated Tradesyncer copier), so it is not cited.

## 3. Reconciliation / waterfall displays

- A waterfall (bridge) "shows a running total as values are added or subtracted … useful for
  understanding how an initial value is affected by a series of positive and negative values";
  start and end columns sit on the axis, intermediate steps float.
  — Microsoft Support. *Create a waterfall chart* (Excel).
  https://support.microsoft.com/topic/8de1ece4-ff21-4d37-acd7-546f5527f185
- IBCS files the vertical waterfall under **calculation schemes** (P&L with variance tiers,
  up to 20–25 lines) — an analysis/report layout, not a monitoring element.
  — IBCS Association. *Chart template C12: Vertical waterfalls* (v2.0, 2025-07-14).
  https://www.ibcs.com/?p=3581
- Applying Few's definition and Nielsen's progressive disclosure: a bridge answers *why* the
  headline number moved, which is the second layer. It belongs on the Overview only when its
  answer is the headline (e.g. "fees + funding ate the week's gains"); then show that one
  sentence or the two largest steps and link to the full bridge. **Inference, not a cited
  rule** — no primary source states "waterfalls belong on detail pages" in those words.
- If kept anywhere, render it as a waterfall or a ledger with running total, signs as glyphs,
  and the residual (unexplained) step shown explicitly — consistent with this project's
  "score against the exchange" rule.

## 4. Goals, progress and "what needs attention" at the top

- Goals: Few's bullet graph is the primary form for actual-vs-target on a dashboard; it also
  carries the qualitative band (behind / on pace / ahead). Tradezella's Progress Tracker
  (today's score + heat map of rule adherence) and Edgewonk's Tiltmeter are the vendor
  equivalents, both on the home view.
- Attention items go where Few puts urgent information — the most salient position — but only
  when they exist and only ranked: "guide attention to critical values" rather than "flashing
  endless alerts without prioritization".
  — Laubheimer, P. (2022-12-16). *Alert Fatigue in User Interfaces* (video).
  https://www.nngroup.com/videos/alert-fatigue-user-interfaces/
- An empty alerts area must say so ("There are no alerts"), otherwise users wonder whether it
  failed or was never configured.
  — Kaplan, K. (2021-09-19). *Designing Empty States in Complex Applications: 3 Guidelines*.
  https://www.nngroup.com/articles/empty-state-interface-design/
- PatternFly's aggregate-status pattern (total + non-zero exceptions, each linked) is the
  compact form: "Needs attention · 2" with the two items listed, each opening its tab.

## Sources not used as evidence

Vendor marketing blogs, listicles ("15 dashboard mistakes") and BI-tool tutorials were read
for leads only. Few's white papers are cited by title and date; their text was not retrievable
directly (bot check) and is quoted through the book review. The ordering, caps (0–3 attention
items, last 5 trips) and the placement of the reconciliation are proposals derived from these
sources, not findings.
