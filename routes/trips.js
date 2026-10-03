import { enrichedTrips } from '../lib/trip-enrichment.js';

export function register(app) {
  app.get('/api/trips', (req, res) => {
    try {
      const { trips, coverage } = enrichedTrips();
      const days = parseInt(req.query.days, 10);
      const cutoff = days > 0 ? Date.now() - days * 86_400_000 : 0;
      res.json({ ok: true, trips: trips.filter(t => t.closeTime >= cutoff), coverage });
    } catch (err) {
      console.error('[trips]', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
