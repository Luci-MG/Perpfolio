// server.js — wiring only: static files, the routes in registration order, and the services
// (order stream, watchdog, cache warm-up, listener) that start when this file is run.
// Exchange access lives in lib/, one route area per file in routes/.

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { fundingMeta, getBinanceLeverageBrackets, refreshFundingMeta, refreshSymbolFilters, symbolFilters } from './lib/binance-meta.js';
import { BINANCE_API_KEY, PORT } from './lib/config.js';
import { captureEntryContext } from './lib/entry-context.js';
import { startEquitySnapshots } from './lib/equity-snapshots.js';
import { onFill, reconcileOrders, startBinanceUserDataStream, startStreamWatchdog } from './lib/orders-stream.js';
import { isEnabled } from './lib/venues.js';
import { register as registerDashboard } from './routes/dashboard.js';
import { register as registerVolstops } from './routes/volstops.js';
import { register as registerRiskbook } from './routes/riskbook.js';
import { register as registerHistory } from './routes/history.js';
import { register as registerPerformance } from './routes/performance.js';
import { register as registerHedgeledger } from './routes/hedgeledger.js';
import { register as registerDeleverage } from './routes/deleverage.js';
import { register as registerConfluence } from './routes/confluence.js';
import { register as registerAssets } from './routes/assets.js';
import { register as registerHealth } from './routes/health.js';
import { register as registerVenues } from './routes/venues.js';
import { register as registerTrips } from './routes/trips.js';
import { register as registerGoals } from './routes/goals.js';
import { register as registerFactors } from './routes/factors.js';
import { register as registerAnnotations } from './routes/annotations.js';

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.static(path.join(__dirname, 'public')));
registerDashboard(app);
registerVolstops(app);
registerRiskbook(app);
registerHistory(app);
registerPerformance(app);
registerTrips(app);
registerGoals(app);
registerFactors(app);
registerAnnotations(app);
registerHedgeledger(app);
registerDeleverage(app);
registerConfluence(app);
registerAssets(app);
registerHealth(app);
registerVenues(app);

export { app, reconcileOrders };

// Timers, the websocket and the listener start only when this file is run, so the route
// tests can import the app against a fake exchange without opening real connections.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function startServices() {
  startStreamWatchdog();
  startEquitySnapshots();
  onFill(o => captureEntryContext(o).catch(err => console.warn('[entry] capture failed:', err.message)));

  // Warm the slow, long-lived caches at boot: exchangeInfo is a large payload and the funding
  // table is a second round-trip, and paying for both on a user's first panel open cost 13s.
  if (isEnabled('binance')) (async () => {
    try {
      const [, , brackets] = await Promise.all([
        refreshSymbolFilters(), refreshFundingMeta(), getBinanceLeverageBrackets()
      ]);
      console.log(`[cache] ${Object.keys(symbolFilters).length} symbol filters, `
        + `${Object.keys(fundingMeta).length} funding intervals, `
        + `${Object.keys(brackets || {}).length} margin bracket tables`);
    } catch (err) {
      console.warn('[cache] warm-up failed, will load on demand:', err.message);
    }
  })();

  // Start Binance User Data Stream only when credentials are present
  if (BINANCE_API_KEY) {
    startBinanceUserDataStream();
  } else {
    console.warn('[bnWS] No BINANCE_API_KEY — skipping User Data Stream');
  }

  const server = app.listen(PORT, () => console.log(`Dashboard running → http://localhost:${PORT}`));

  // Exit at once on a restart signal: `npm run dev` starts the new process straight away, and
  // one still holding the port made it fail with EADDRINUSE whenever several files were saved
  // together.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, () => { server.close(); process.exit(0); });
  }
}

if (isMain) startServices();
