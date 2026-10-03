# Goals

Goals turn what the journal measures into rules you set for yourself, and score you on them
from the day you set them. Two kinds, chosen deliberately: **process rules** checked against
your trades, and **milestones** with a deadline. Pure profit targets are left out — they
reward forcing trades.

The design was agreed on 2026-10-03; rules and milestones are both built. Milestones live in
`milestones.js`, which `goals.js` calls for every type whose unit is `milestone`.

## Goal types

| Type | Unit | Checked against | Retroactive |
|---|---|---|---|
| Max leverage at entry | trip | entry context `account.leverage` | no — from entry capture on |
| Stop within 5 minutes of entry | trip | entry context `yourStop` | no — from entry capture on |
| Max loss per trade, % of equity at entry (or $) | trip | trip net against the equity snapshot within 15 min of `openTime`, else the wallet curve (marked ≈ wallet) | yes, as far back as the wallet curve |
| No adding while underwater | trip | `addsWhileUnderwater` | yes |
| Max size, × median opening notional | trip | `openNotional` against the median of earlier trips, once there are 10 | yes |
| Max trades per day | day | trips opened per local day; only the trips past the cap are breaches | yes |
| Stop for the day after N losses in a row | trip | losing closes earlier that local day | yes |
| No trading in chosen sessions | trip | `session` | yes |
| Milestone: account value ≥ X, optionally by a date | milestone | equity snapshots, deposits and withdrawals removed | from the first snapshot |
| Milestone: monthly drawdown no worse than −Y% | milestone | equity snapshots, else the wallet curve | yes, on the wallet |

Every rule can be scoped to a session (*Applies: Weekend*), reusing `sessions.js`.

## Scoring

- **Kept or broken** per trip or per day; days start at the reader's local midnight, like the
  Overview periods. A day with no trades is *not applicable*, never kept.
- **Scored from the day the goal was set.** What history before that would have said is shown
  separately, as one line, to help choose a threshold — a goal can never be "kept" before it
  existed.
- **Adherence** = kept ÷ scored, always with n. **Streak** = consecutive kept periods.
- **Cost of breaking it** = (average net of broken trips − average net of kept trips) × broken
  trips — the habit-cost method, labelled an estimate, dimmed with ⚠ under 10 on either side.
- **Editing a threshold re-scores from the same set date**; history never mixes two versions
  of a rule. Pausing keeps the record and stops scoring.
- **Milestones** show progress from the value when set to the target, with deposits and
  withdrawals left out so a transfer never reaches a target. The projection is a least-squares
  line through the daily closes since setting it ("on pace for …"), labelled an extrapolation;
  under 7 days of history it says so instead. A target without a date is never late or
  missed. The drawdown milestone scores each local month from the month it was set; months
  before snapshots began read from the wallet curve, marked ≈ wallet.
- **Order:** rules first, as below; then milestones, the drawdown limit first and account
  targets by target, paused last — so a ladder of targets reads in order.

## Suggestions are honest

The empty state and the add drawer suggest goals from the reader's own history, and **only
goals whose breaches cost money there**. On a real book some textbook rules — capped size,
capped trades a day, a losing-streak stop — can have breaches that *outperformed*; those stay
available, but the preview says "trades that broke this did better than those that kept it"
rather than recommending them. Suggested thresholds come from the reader's own distribution
(for a loss cap, around the 80th–90th percentile of losing trades as % of equity), not
textbook defaults.

## Frontend

**Where:** a Journal sub-tab **Goals**, and one line at the top of Overview —
`Goals today: 3 of 4 kept · ✗ adds underwater` — that opens it. No sidebar change; promoting
Goals to a sidebar tool later is one `TOOLS` entry.

**Scoreboard rows**, one line per goal, milestones in their own block:
```
GOALS                                   today 3 of 4 kept · this week 86%
│ ✗ No adds underwater        broke today       71% n=41   ▮▯▮▮▯▮▯  ▸ │
│ ● Max 6 trades a day        4/6 today         95% n=21d  ▮▮▮▮▮▮●  ▸ │
│ ✓ Max leverage 10×          kept · 14d        92% n=38   ▮▮▮▮▮▯▮  ▸ │
│ ‖ No weekend trading        paused            67% n=9w   ▯▮▮▮▯▯·  ▸ │
│ ◎ Account ≥ $X by 31 Dec    ████████░░░░ 64%  on pace for 12 Jan    │
```
Order: broken → in progress → kept → paused, then creation order within each group.

**States** — shape and colour together:

| State | Mark |
|---|---|
| kept | ✓ green |
| broken | ✗ red — red only ever means broken |
| in progress | ● muted, with "4/6" |
| not applicable | · muted |
| paused | ‖ muted, row dimmed |
| milestone on pace / late / reached | ◎ green / ◔ amber / ★ green |

**Expanded row:** an 8-week calendar (one cell per day or week), the breaches list (time,
trade, what broke, cost; *open ›* jumps to that trade in Trades), the broken-against-kept
line with n, the pre-set history line, and *Edit · Pause*. A milestone expands into a mini
chart: the account line since setting it, a dashed projection to the target, the deadline.

**Empty state:** two or three suggestions from the costliest habits, each one click, with the
threshold prefilled from history; nothing switches on by itself.

**Add / edit drawer** (like the hedge ledger):
```
ADD GOAL
Type      [ Max loss per trade          ▾ ]
Limit     [ 0.7 ] % of equity at entry    ( ) or [ $ ____ ]
Applies   [ All sessions ▾ ]   from [ today ]

On your last N trades this would have been:
  kept 88% · broken 31 times · breaking trades averaged −$… vs +$…
  ▮▮▮▮▯▮▮▯▮▮▮▮▯▮  (last 14 days)
                                            [ Cancel ]  [ Add goal ]
```
The preview re-scores as the threshold changes, so a strict-but-reachable level is found
before committing to it.

## Engine, storage, API

- **`goals.js`** at the root, pure: a `GOAL_TYPES` table — `{ id, label, unit, needs,
  check(trip|day, params, context), describe(params) }` — like `HABITS`, so a new goal is one
  entry. `scoreGoal(goal, trips, context)` returns status, adherence, n, streak, the period
  strip, breaches and cost; `previewGoal` scores history with no set date.
- **`data/goals.json`** (gitignored), written by `lib/goals-store.js` through a temp file and a
  rename: `[{ id, type, params, session, setAt, pauses: [{ from, to }], history: [{ params,
  session, until }] }]`. `pauses` keeps every paused stretch so a resumed goal never scores the
  gap; `history` keeps the versions an edit replaced.
- **`GET /api/goals`** — goals with their scores; **`POST /api/goals`** — add, edit, pause,
  delete; JSON only, like `/api/venues`, so another site cannot change them. **`GET
  /api/goals/preview?type=&params=`** — the drawer's live preview.
- Trips come from `enrichedTrips()`, days from `periodStarts` with the reader's `tz`, sessions
  from `sessions.js`, milestones from `readEquitySnapshots()` and `walletCurve`.

## Tests the build must have

- Every goal type on hand-built trips, including session scoping and local-day boundaries.
- Scored-from-set-date: a breach before `setAt` never counts; editing re-scores, pausing
  freezes.
- Cost sign and the thin flag; suggestions exclude goals whose breaches outperformed.
- Milestone progress, projection, and the under-7-days state.
- Route: JSON-only POST (415, 400), persistence, preview.
- Smoke: every state renders, rows order as specified, the drawer preview updates, the
  Overview line, the empty state; no `undefined`/`NaN`.

## Open

- **Forward-only goals start empty.** Leverage and stop-within-5-minutes need entry context,
  captured only while the server runs; the tab says so until the first capture.
- **Alerts** on a broken goal belong to the *server-side alerts* card, not here.
