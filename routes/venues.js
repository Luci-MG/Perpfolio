import express from 'express';
import { binanceSnapshotAgeMs } from '../lib/binance-account.js';
import { hyperliquidSnapshotAgeMs } from '../lib/hyperliquid.js';
import { resumeBinanceUserDataStream, stopBinanceUserDataStream } from '../lib/orders-stream.js';
import { VENUES, isConfigured, isEnabled, setEnabled } from '../lib/venues.js';

const jsonBody = express.json({ limit: '1kb' });
const parseJson = (req, res, next) =>
  jsonBody(req, res, err => (err ? res.status(400).json({ ok: false, error: 'malformed JSON' }) : next()));

const SNAPSHOT_AGE = { binance: binanceSnapshotAgeMs, hyperliquid: hyperliquidSnapshotAgeMs };

export function venueState() {
  return Object.fromEntries(VENUES.map(v => [v, {
    enabled: isEnabled(v), configured: isConfigured(v), snapshotAgeMs: isEnabled(v) ? SNAPSHOT_AGE[v]() : null
  }]));
}

// POST accepts application/json only, so a cross-site page cannot switch a venue: that
// content type needs a CORS preflight, which this server never grants.
export function register(app) {
  app.get('/api/venues', (req, res) => res.json({ ok: true, venues: venueState() }));

  app.post('/api/venues', parseJson, async (req, res) => {
    if (!req.is('application/json')) return res.status(415).json({ ok: false, error: 'send application/json' });
    const { venue, enabled } = req.body || {};
    if (!VENUES.includes(venue) || typeof enabled !== 'boolean') {
      return res.status(400).json({ ok: false, error: `expected { venue: ${VENUES.join('|')}, enabled: boolean }` });
    }
    if (enabled && !isConfigured(venue)) {
      return res.status(409).json({ ok: false, error: `${venue} has no credentials in .env` });
    }
    try {
      const was = isEnabled(venue);
      setEnabled(venue, enabled);
      if (venue === 'binance' && was && !enabled) stopBinanceUserDataStream();
      if (venue === 'binance' && !was && enabled) await resumeBinanceUserDataStream();
      res.json({ ok: true, venues: venueState() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
