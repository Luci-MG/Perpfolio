import * as store from '../history-store.js';
import { DATA_DIR, META_FILE, runHistorySync, syncState } from '../lib/history-sync.js';
import { syncTripContext } from '../lib/trip-enrichment.js';
import { isEnabled, venueOffBody } from '../lib/venues.js';

export function register(app) {
  // Starts a sync when idle and reports progress; the panel polls the same URL.
  app.get('/api/history/sync', async (req, res) => {
    if (req.query.start === 'true' && !isEnabled('binance')) return res.status(409).json(venueOffBody('binance'));
    if (req.query.start === 'true' && !syncState.running) runHistorySync(req.query.full === 'true', { afterTrades: syncTripContext });
    res.json({
      ok: true,
      state: syncState,
      store: store.storeStats(DATA_DIR),
      meta: store.readJson(META_FILE, {})
    });
  });
}
