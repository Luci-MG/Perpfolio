# Crypto Portfolio Dashboard

Unified real-time dashboard for Hyperliquid + Binance USDM Futures open positions and hedge book.

## Stack
- **Backend**: Node.js + Express (no database needed)
- **Frontend**: Vanilla HTML/CSS/JS served by Express
- **APIs**: Hyperliquid public REST · Binance signed REST (read-only)

---

## Setup

### 1. Install Node.js
Download from https://nodejs.org (v18+ recommended).

### 2. Clone / download this project
```bash
cd crypto-dashboard
npm install
```

### 3. Configure your credentials
```bash
cp .env.example .env
```
Open `.env` and fill in:

| Variable | Where to get it |
|---|---|
| `BINANCE_API_KEY` | Binance → Profile → API Management → Create API → **Read Only** |
| `BINANCE_API_SECRET` | Same page (shown once on creation) |
| `HL_WALLET_ADDRESS` | Your Hyperliquid wallet address (public, e.g. `0xAbc…`) |

**Binance tip**: when creating the API key, enable only "Read Info". Disable spot trading, futures trading, and withdrawals.

### 4. Run locally
```bash
npm start
```
Open http://localhost:3000 in your browser.

For auto-restart on file changes during development:
```bash
npm run dev
```

---

## How it works

```
Browser → GET /api/dashboard
              ↓
         server.js
         ├── Hyperliquid: POST /info (no auth needed)
         └── Binance FAPI: GET /fapi/v2/positionRisk (signed with HMAC-SHA256)
              ↓
         Hedge detection (auto-pairs opposite-side same-asset positions across exchanges)
              ↓
         JSON response → frontend renders dashboard
```

The dashboard auto-refreshes every **30 seconds**.

---

## Deploying online (when ready)

### Railway (easiest)
1. Push this folder to a GitHub repo
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Add your `.env` variables in Railway's dashboard under Settings → Variables
4. Done — Railway gives you a public URL

### Render
Same flow as Railway — connect GitHub repo, add env vars, deploy.

### VPS (DigitalOcean / Hetzner)
```bash
npm install -g pm2
pm2 start server.js --name dashboard
pm2 save
pm2 startup
```

---

## Customising hedge detection

Hedges are auto-detected in `server.js` → `detectHedges()`. The logic:
- Matches positions on the same asset across HL and Binance
- Considers a pair a hedge if they are **opposite sides** (one long, one short)
- Calculates offset ratio = smaller size / larger size

To add manual hedge labels or cross-asset hedges, edit the `detectHedges` function.
