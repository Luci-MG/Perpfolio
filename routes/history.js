import * as store from '../history-store.js';
import { DATA_DIR, META_FILE, runHistorySync, syncState } from '../lib/history-sync.js';

export function register(app) {
  // Starts a sync when idle and reports progress; the panel polls the same URL.
  app.get('/api/history/sync', async (req, res) => {
    if (req.query.start === 'true' && !syncState.running) runHistorySync(req.query.full === 'true');
    res.json({
      ok: true,
      state: syncState,
      store: store.storeStats(DATA_DIR),
      meta: store.readJson(META_FILE, {})
    });
  });
}
