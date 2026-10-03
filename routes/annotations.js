import express from 'express';
import { saveAnnotation } from '../lib/annotations-store.js';
import { enrichedTrips } from '../lib/trip-enrichment.js';

const jsonBody = express.json({ limit: '4kb' });
const parseJson = (req, res, next) =>
  jsonBody(req, res, err => (err ? res.status(400).json({ ok: false, error: 'malformed JSON' }) : next()));

// POST accepts application/json only, so a cross-site page cannot write notes: that content
// type needs a CORS preflight, which this server never grants.
export function register(app) {
  app.post('/api/annotations', parseJson, (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ ok: false, error: 'send application/json' });
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
