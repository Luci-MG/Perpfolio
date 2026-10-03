import { saveAnnotation } from '../lib/annotations-store.js';
import { jsonOnly } from '../lib/http.js';
import { enrichedTrips } from '../lib/trip-enrichment.js';

const parseJson = jsonOnly('4kb');

export function register(app) {
  app.post('/api/annotations', parseJson, (req, res) => {
    const { key, note, tags } = req.body || {};
    const trip = typeof key === 'string' ? enrichedTrips().trips.find(t => t.key === key) : null;
    if (!trip) return res.status(404).json({ ok: false, error: 'no closed trip with that key' });
    try {
      res.json({ ok: true, annotation: saveAnnotation(trip, { note, tags }) });
    } catch (err) {
      res.status(400).json({ ok: false, error: err.message });
    }
  });
}
