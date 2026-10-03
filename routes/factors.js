import { SESSIONS } from '../sessions.js';
import { outcomeFactors } from '../outcome-factors.js';
import { enrichedTrips } from '../lib/trip-enrichment.js';
import { readerClock } from '../lib/util.js';

const CACHE_SIZE = 8;
const cache = new Map();

const fingerprint = trips => `${trips.length}:${trips.reduce((m, t) => Math.max(m, t.closeTime), 0)}`;

function remember(key, compute) {
  if (!cache.has(key)) {
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value);
    cache.set(key, compute());
  }
  return cache.get(key);
}

export function register(app) {
  app.get('/api/factors', (req, res) => {
    try {
      const days = parseInt(req.query.days, 10);
      const cutoff = days > 0 ? Date.now() - days * 86_400_000 : 0;
      const session = SESSIONS.includes(req.query.session) ? req.query.session : null;
      const tz = readerClock(req.query);
      const { trips: all, version } = enrichedTrips();
      const trips = all.filter(t => t.closeTime >= cutoff && (!session || t.session === session));
      const key = [version, days > 0 ? days : 0, session, tz.zone ?? tz.offsetAt(0), fingerprint(trips)].join('|');
      res.json({ ok: true, session, ...remember(key, () => outcomeFactors(trips, { tz, session, all })) });
    } catch (err) {
      console.error('[factors]', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
