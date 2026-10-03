# Sessions

Trading sessions by each market's own clock, in `sessions.js` at the root — served to the
browser at `/sessions.js`, so the clock and the analytics run the same definition.

## Definition

| Market | Local hours | Zone |
|---|---|---|
| Tokyo | 09:00–18:00 | `Asia/Tokyo` (no daylight saving) |
| London | 08:00–17:00 | `Europe/London` |
| New York | 08:00–17:00 | `America/New_York` |

Markets count as open on their local weekdays only. Each moment gets one label:
**Europe + US** while London and New York are both open, else **US**, **Europe** (London takes
over from Tokyo at its open), **Asia**, or **Off-hours** — the weekday gap after New York
closes and the whole weekend. `Intl.DateTimeFormat` with each zone handles daylight saving,
so the week in autumn when only London has moved is right without a table of dates. Fixed
UTC buckets (Asia 22–08, Europe 08–14, US 14–22, used until 2026-10-03) drifted by an hour
twice a year and had no overlap.

## Session clock
One line in the main header bar, between the HL/BN filter and the view tabs (`sessions-view.js`, rendered into the section bar and refreshed in place): the session now, the nearest market close
(or open, off-hours), and the next change with its countdown, in the reader's local time; the
tooltip lists each market's next open or close. It updates every minute in the browser and
costs no request.

## Session filter
One choice — All, Asia, Europe, Europe + US, US, Off-hours — remembered per browser, shown as
a control in the views that honour it:

| View | With a session |
|---|---|
| Journal (Performance, Behaviour, Timing, Symbols) | `/api/performance?session=` keeps trips **opened** in it; habit costs follow |
| Journal Trades | filtered in the browser on each trip's `session` |
| Journal Overview | not filtered, and says so — income and the equity curves are the whole account |
| Confluence | the verdict adds the composite's record on 1h (else 15m) bars **closing** in it; 4h and 1d bars span sessions |
| Stops | not filtered, and says so — the hit rate's 24h windows cover every session |
| Positions, Orders, Stress, Unwind | live state; no session |
