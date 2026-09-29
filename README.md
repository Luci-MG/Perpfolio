# Crypto Portfolio Dashboard

Real-time dashboard and risk workbench for **Binance USDM Futures**, built for a hedged
book — same-symbol long and short, cross margin, high leverage. Includes a read-only
Hyperliquid view.

Runs locally. Reads your account; never places an order.

## Stack
- **Backend**: Node.js + Express — `express`, `dotenv`, `ws`, nothing else
- **Frontend**: vanilla HTML/CSS/JS — markup, one stylesheet, thirteen plain scripts; no framework, no build step
- **APIs**: Binance signed REST + user-data websocket · Hyperliquid public REST
- **Storage**: append-only NDJSON in `data/` (gitignored) for trade history — no database

---

## Setup

**1. Node.js v18+** — https://nodejs.org

**2. Install**
```bash
cd crypto-dashboard
npm install
```

**3. Credentials**
```bash
cp .env.example .env
```

| Variable | Where to get it |
|---|---|
| `BINANCE_API_KEY` | Binance → API Management → Create API |
| `BINANCE_API_SECRET` | Same page, shown once |
| `HL_WALLET_ADDRESS` | Your Hyperliquid wallet address (public, `0x…`) |
| `PORT` | Optional, defaults to 3000 |

**Enable "Read Info" only.** Disable spot trading, futures trading and withdrawals. This app
never calls a trading endpoint, but that safety lives in the code — restrict the key so it
does not depend on the code being right.

**4. Run**
```bash
npm start        # http://localhost:3000
npm run dev      # auto-restart on change
npm run verify   # static checks + 152 tests (engines, every route, every view), no dependencies
```

**5. Build the trade history** (once, for the Journal)

Open the **Journal** tab → **Sync recent**, or:
```bash
curl "localhost:3000/api/history/sync?start=true&full=true"
```
The full build takes about a minute and writes ~10MB to `data/`. After that a routine sync
takes ~10s because it only re-reads symbols traded in the last week.

---

## What's in it

The main column has eight tabs; the sidebar has six tool buttons.

| Tab | What it answers |
|---|---|
| **Tiles / List / Orders** | what is open right now, and at what price |
| **Stops** | volatility-adjusted stop width and size per position |
| **Stress** | drag any coin's price and watch the shared margin pool drain, with markers where it liquidates |
| **Unwind** | which positions to close, in what order, to free margin or restore buffer |
| **Journal** | the account's history: account reconciliation, performance, behaviour, timing, symbols, costs, trades |
| **Confluence** | pick any Binance perp (default BTC): 12 signals in 7 sources across 15m/1h/4h/1d, regime-gated, each with its own hit rate, edge over chance and a ✓/✗ only when that edge is statistically real |

Sidebar tools (the icon block beside *Daily funding*):

| | |
|---|---|
| **P&L · Avg Down/Up · Liq Price** | quick calculators |
| **Liquidation after close** ✂ | pick positions to close, get the exchange's liquidation price for everything left |
| **Unwind simulator** 🎚 | close legs by hand and see what it frees, then move the market |
| **Hedge ledger** ▦ | how much of the loss is already locked, what the hedge costs to hold, and how its margin inflates in a pump |

Positions, orders and margin refresh every **15 seconds** (paused while the tab is hidden). The
heavier panels load when you open their tab. The server shares one account read across every
open tab for 10 seconds, so extra tabs cost no extra exchange quota, and a Binance rate-limit
or ban pauses every call until it lifts. The last tab, coin and timeframes you used are
remembered in the browser. A small chip beside *Last updated* appears whenever the server
reports a problem — a rate-limit pause, a quiet order stream, stale data — with the reasons on
hover.

---

## A note on the numbers

Margin and liquidation figures are scored against Binance's own reported values on **every
request** — maintenance margin, initial margin, equity, free margin and the published
liquidation price. The panels show that error rather than asserting they are right, and the
Stress tab refuses to show thresholds at all if the model cannot reconcile.

Where a figure is an extrapolation rather than a forecast — a liquidation price many
multiples away from the mark — it is labelled as one.

Trade history is cross-checked the same way: every fill's realised PnL lands in exactly one
place — a closed round trip, one still open, or an "orphan" bucket for fills that closed a
position opened before the earliest history Binance still serves — and the Journal says how
big that bucket is.

Equity is the exchange's margin balance (wallet plus unrealised PnL), and daily funding uses
each symbol's own settlement interval (8h, 4h or 1h; Hyperliquid hourly).

---

## Deploying

Local is the intended setup. The server listens on every network interface and has **no
authentication** — anyone who can reach the port (including other devices on your Wi-Fi) can
read your account and start a history sync. Keep it behind a firewall or on a trusted network.

- **Railway / Render**: push to GitHub, add the `.env` variables in the dashboard, deploy
- **VPS**: `npm install -g pm2 && pm2 start server.js --name dashboard && pm2 save`

`public/` (markup, `css/`, `js/`) is served by Express, so there is no separate frontend deploy.

---

## Architecture and design notes

`CLAUDE.md` is the map and the rules; the detail is in `docs/`, one file per area:
`architecture.md` (how the modules fit, and recipes for adding a route, a tab or a signal),
`api.md`, `frontend.md`, `stress-engine.md` (the margin maths and how it is calibrated),
`unwind.md`, `journal.md`, `confluence.md`, `stops.md`, `operations.md` (order feed, request
budget, deployment), `changelog.md` (what the latest review fixed, and the roadmap) and
`known-gaps.md`.
