import * as store from '../history-store.js';
import { jsonOnly } from '../lib/http.js';
import { DATA_DIR, META_FILE, runHistorySync, syncState } from '../lib/history-sync.js';
import { syncTripContext } from '../lib/trip-enrichment.js';
import { isEnabled, venueOffBody } from '../lib/venues.js';

const syncStatus = () => ({ ok: true, state: syncState, store: store.storeStats(DATA_DIR), meta: store.readJson(META_FILE, {}) });

export function register(app) {
  app.get('/api/history/sync', (req, res) => res.json(syncStatus()));

  app.post('/api/history/sync', jsonOnly('1kb'), (req, res) => {
    if (!isEnabled('binance')) return res.status(409).json(venueOffBody('binance'));
    if (!syncState.running) runHistorySync(req.body?.full === true, { afterTrades: syncTripContext });
    res.json(syncStatus());
  });
}
