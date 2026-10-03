import { SESSIONS } from '../sessions.js';
import { outcomeFactors } from '../outcome-factors.js';
import { enrichedTrips } from '../lib/trip-enrichment.js';

const CACHE_SIZE = 8;
const cache = new Map();

const tagsOf = trips => trips.filter(t => t.tags?.length).map(t => `${t.key}=${t.tags.join(',')}`).join(';');

const fingerprint = trips =>
  `${trips.length}:${trips.reduce((m, t) => Math.max(m, t.closeTime), 0)}:${trips.filter(t => t.entry).length}:${tagsOf(trips)}`;

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
      const tzOffsetMin = parseInt(req.query.tz, 10) || 0;
      const trips = enrichedTrips().trips.filter(t => t.closeTime >= cutoff && (!session || t.session === session));
      const key = [days > 0 ? days : 0, session, tzOffsetMin, fingerprint(trips)].join('|');
      res.json({ ok: true, session, ...remember(key, () => outcomeFactors(trips, { tzOffsetMin, session })) });
    } catch (err) {
      console.error('[factors]', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
