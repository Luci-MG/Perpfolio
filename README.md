# Perpfolio

A self-hosted risk dashboard for **Binance USDM futures**, with a read-only Hyperliquid view.
Built for hedged, cross-margined books. It reads your account and never places orders.

| | |
|---|---|
| **Positions** | live positions, orders and margin, refreshed every 15s |
| **Stops** | volatility-adjusted stop width and size per position |
| **Stress** | move any price and watch the margin pool; exact liquidation and free-margin thresholds |
| **Unwind** | which positions to close, and in what order, to free margin or restore buffer |
| **Journal** | round trips, performance, behaviour, timing and costs, from your own fills |
| **Confluence** | 12 signals across 15m–1d for any perpetual, each with its measured hit rate |

Every margin figure is checked against what Binance itself reports, on every request, and the
error is shown in the UI.

## Quick start

```bash
npm install
cp .env.example .env    # add your keys
npm start               # http://localhost:3000
```

| Variable | |
|---|---|
| `BINANCE_API_KEY` / `BINANCE_API_SECRET` | a **read-only** key: enable *Read Info* only |
| `HL_WALLET_ADDRESS` | optional, a public `0x…` address |
| `PORT` | optional, default `3000` |
| `HOST` / `ALLOWED_HOSTS` | optional; the server listens on `127.0.0.1` — see `docs/operations.md` before changing it |

The Journal needs a one-time history sync: **Journal → Sync recent**.

## Security

There is no login. Anyone who can reach the port can read the account, so run it locally or on a
trusted network. Use a key without trading or withdrawal permissions.

## Development

```bash
npm run dev      # restart on change
npm run verify   # static checks and the full test suite
```

Node 20 or later. The only dependencies are Express, dotenv and ws, and there is no build step. Design
notes are in [`docs/`](docs/); start with [`docs/architecture.md`](docs/architecture.md).
