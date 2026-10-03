# Frontend

## Files

`public/index.html` holds markup only, `public/css/app.css` every style, and `public/js/` the
behaviour as sixteen **classic** scripts loaded in this order — no build step, no framework:

| # | File | Holds |
|---|---|---|
| 1 | `core.js` | preferences, shared view state, `fmt*` / `esc` / badges — load-time code in later files calls these |
| 1b | `venues.js` | status bulb, exchange switches, `venueOn()` / `offOr()` / `venueOffHtml()` |
| 1c | `tools-nav.js` | `TOOLS`, the tool widgets and narrow-screen strip, `openTool()` |
| 2 | `positions.js` | `setView`, HL/BN filter, positions list and tiles, orders table |
| 3 | `tiles-threads.js` | hedge popups, tile drag and focus, the hedge-thread SVG |
| 4 | `stops.js` | Stops tab |
| 5 | `stress.js` | Stress tab |
| 6 | `hedge-ledger.js` | hedge-ledger drawer |
| 7 | `confluence-view.js` | Confluence tab (the engine is the server's `confluence.js`) |
| 8 | `journal.js` | Journal tab |
| 8b | `journal-trades.js` | Journal's Trades table: `TRADE_COLUMNS`, sort, filters, CSV |
| 9 | `unwind.js` | liquidation-after-close and unwind-simulator drawers, Unwind tab |
| 10 | `render.js` | sidebar widgets, `render()`, `fetchData()` and the poll guard |
| 11 | `calculators.js` | context menu and the calculator modal — page code only; the arithmetic is `/calc-engine.js` |
| 12 | `drawers.js` | exposure, uPnL and funding drawers |
| 13 | `boot.js` | global listeners, first poll, refresh timer — must stay last |

Why classic scripts and why the order matters: [`architecture.md`](architecture.md).

- Polls `GET /api/dashboard` every **15 seconds** via `setInterval` — skipped while the tab is
  hidden (and re-fetched on return), and never two at once (`pollInFlight`)
- Manual refresh button triggers `fetchData()` immediately
- Each successful poll also reads `/api/health`; the header chip beside *Last updated* appears
  only when the server reports a problem (docs/operations.md, *Health*)
- A failed poll keeps the last good figures on screen and says `Stale — last good HH:MM`
  rather than blanking the status line
- The view, the confluence symbol and its timeframes are remembered per browser
  (`loadPref`/`savePref`, `localStorage` under `dash:*`, every access wrapped so a blocked
  store simply falls back to the defaults)
- Below 900px wide the sidebar stacks under the main column
- Dark mode via `prefers-color-scheme` media query with CSS variables
- `lastData` cached globally so view toggles re-render instantly without re-fetching

### Key JS functions
| Function | Purpose |
|---|---|
| `fetchData()` | Polls `/api/dashboard`, calls `render(data)` |
| `render(data)` | Rebuilds main column + sidebar; **leaves a mounted panel alone** (see below) |
| `setView(v)` | Switches `posView`, lazily fetches that tab's data |
| `renderPositions` / `renderPositionTiles` / `renderOrdersFor` | Tiles, list and order tables |
| `renderMarginHealth(data)` | Sidebar SVG arc gauges for HL and BN margin use |
| `renderSidebarBottomRow(data)` | Funding widget + `renderCalcTiles()` icon block |
| `renderCalcTiles()` | The 3×2 icon grid: three calculators + three drawers |
| `fmt` / `fmtUsd` / `fmtSignedUsd` / `fmtPrice` / `fmtPnl` | Number formatting |
| `liqDist(p)` | `abs(mark − liqPrice) / mark × 100` |

`esc()` escapes anything interpolated into markup from user input or an exchange/server
string — attributes, titles and error messages.

`fmtPnl` renders a negative as a red `$X` with **no minus sign** — colour carries the sign.
That is fine for a PnL column and wrong for anything where the sign is the point, which is
why `fmtSignedUsd` exists. `fmtPrice` scales decimals to the price magnitude; `fmtUsd` is
always 2dp and turns a 1e-5 asset into `$0.00`.

### Views: positions tabs and tools
`posView` ∈ `tiles | list | orders | stops | stress | unwind | journal | confluence`, default `tiles`.
**Positions views** (Tiles, List, Orders) are the tab strip in the main column. **Tools** (Stops,
Stress, Unwind, Journal, Confluence) are the `TOOLS` table in `tools-nav.js`, opened from the
sidebar's tool widgets; `isToolView()` / `toolFor()` read that table, so no other file lists them.
`setView(v)` fetches on activation only: `stops` → `/api/volstops`, `stress` → `/api/riskbook`,
`unwind` → `/api/deleverage`, `journal` → `/api/performance`, `confluence` → `/api/confluence`.
Tools replace the positions card and its exchange header; only Stops (`exchangeFilter: true`)
keeps the HL/BN filter.

**Tool widgets.** One tile per tool — icon and name, nothing else — in a grid of three over
two, between uPnL/Exposure and Margin health. The open tool is outlined; clicking it again
returns to the last positions view (kept in memory, remembered across reloads). A
Binance-only tool is dimmed while Binance is off. Below 900px wide the sidebar stacks under
the content, so the same buttons render as a strip above it.

**The mounted-panel rule.** The 15s poll calls `render()`, which would rebuild the whole main
column — destroying a slider mid-drag or an input mid-edit. `render()` therefore leaves the
panel alone whenever its mount marker (`#st-mounted`, `#uw-mounted`, `#cf-mounted`,
`#vs-mounted`, `#jr-mounted`) is present, unless
`rerenderStress()` set `riskForceRender`. Every deliberate rebuild goes through that helper.

### Status bulb and exchange switches
The dot beside *Last updated* is a button. It opens a popover with one row per exchange: a
switch, `synced Ns ago` or `off`, and that exchange's health reasons. Switching calls
`POST /api/venues` and re-polls at once; switching Binance off asks first, because it also
closes the order stream. A venue without credentials in `.env` shows a disabled switch.

| Bulb | Means |
|---|---|
| pulsing amber | fetching |
| solid | idle, every exchange on |
| ring | one exchange off |
| grey ring | every exchange off |
| amber / red | the health verdict is `warn` / `bad` |

With an exchange off its sidebar rows read `off`, its HL/BN filter chip disappears, and
Stress, Unwind and the hedge ledger (Binance-only) show a *Switch Binance on* panel instead
of fetching. Journal still reads its local cache; *Sync* says Binance is off.

### Sidebar
Top to bottom: `metric-stack` (total equity, uPnL, exposure — each with HL/BN breakdown and a
click-through drawer), `renderToolsNav()`, `renderMarginHealth()`, then `renderSidebarBottomRow()` — the daily
funding widget beside `renderCalcTiles()`.

**Margin health is an SVG arc gauge, not a donut.** The sweep never exceeds 180°, so the
arc's `large-arc-flag` must always be `0`; it was `pct > 50 ? 1 : 0`, which drew the 225°
complement and painted the fill out of the viewBox for every utilisation between 50% and
100% — exactly the range worth looking at. A `conic-gradient` survives elsewhere, for the
small long/short split donut only.

### Calculators
One modal, three tabs (P&L, Avg down/up, Liq price), and a **position picker** at the top:
*Manual* or any open position. Picking one fills every tab — side, entry, mark, actual
leverage and size, and Binance's maintenance rate for that size tier — through one
`fillFromPosition(p)`. Opening from a tile's context menu pre-picks that position; from the
sidebar it starts on Manual.

- **Arithmetic lives in `calc-engine.js`** at the root, served at `/calc-engine.js` and
  unit-tested in Node; `calculators.js` only reads inputs and writes results.
- **Liq price is account-aware for a Binance position**: `riskEngine.liquidationDetail` on
  the position's own cross pool (found by key, so a USDC leg uses the USDC pool), with every
  other leg, hedge and tier — the Stress tab's solve, number for number — beside Binance's
  reported figure, and the ill-conditioned note when a near-flat book makes it a region rather
  than a price. *What if I add* re-solves after `addToPosition`. Manual and Hyperliquid use the
  isolated estimate, labelled as such.
- **Avg** adds *liq after this add* for a Binance position.
- The book is the Stress tab's `riskBook`, loaded on first use like the liquidation drawer;
  no new route or poll.

The flat formula it replaced (entry ± 1/leverage with a fixed 0.5% rate) was 54–98% away
from Binance's reported price on every leg of the live book that has one, and showed a
price on eight legs where Binance reports none.

### Drawers
All at body level, outside `#sidebar`, so the poll's sidebar rebuild cannot wipe them:
`openUpnlDrawer` · `openExpDrawer` · `openFundDrawer` (pre-existing) and `openLiqDrawer` ·
`openSimDrawer` · `openHlDrawer` (this session). Each follows the same overlay + `.open`
class pattern.

---

## CSS variables / theming
```css
--hl: #7f77dd        /* Hyperliquid purple */
--bn: #ef9f27        /* Binance amber */
--success: #1d9e75   /* green */
--danger:  #e24b4a   /* red */
--warning: #ba7517   /* amber */
```
Dark mode overrides via `@media (prefers-color-scheme: dark)`.

**Grid overflow:** `.app-layout` uses `minmax(0, 1fr)` and `.main-col` carries `min-width: 0`.
A CSS grid track defaults to `min-width: auto`, so one wide table widens the track and pushes
content out under the sidebar rather than shrinking or scrolling. Any new wide element inside
a grid needs `min-width: 0` on its track.

Key layout classes: `.metric-grid`, `.metric .breakdown`, `.b-row`, `.view-tabs`, `.view-tab`, `.pos-tile-grid`, `.pos-tile`, `.rvc-grid`, `.rvc`, `.donut`, `.donut-hole`, `.fviz-row`, `.two-col`, `.card`.

`renderCalcTiles()` is the icon-button block beside the funding tile: a `repeat(3, 1fr)` grid
holding five tools and one reserved slot, two rows tall so it matches the funding tile's
height. A tile either carries `tab` (opens the calculator modal) or `action` (raw onclick,
used by the two drawers).
