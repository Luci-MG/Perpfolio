import * as cf from '../confluence.js';
import { refreshSymbolFilters, symbolFilters } from '../lib/binance-meta.js';
import { readConfluence } from '../lib/confluence-reading.js';
import { perpSymbols } from '../lib/confluence-data.js';

export function register(app) {
  app.get('/api/symbols', async (req, res) => {
    try {
      await refreshSymbolFilters();
      const symbols = perpSymbols().sort((a, b) => a.symbol.localeCompare(b.symbol));
      res.json({ ok: true, symbols });
    } catch (err) {
      console.error('[symbols]', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/confluence', async (req, res) => {
    try {
      const symbol = String(req.query.symbol || 'BTCUSDT').toUpperCase();
      if (!/^[A-Z0-9]{2,30}$/.test(symbol)) return res.status(400).json({ ok: false, error: 'invalid symbol' });
      await refreshSymbolFilters();
      const known = symbolFilters[symbol];
      if (Object.keys(symbolFilters).length && (!known || known.contractType !== 'PERPETUAL')) {
        return res.status(400).json({ ok: false, error: `${symbol} is not a Binance USDM perpetual` });
      }
      const tfs = String(req.query.tfs || Object.keys(cf.TIMEFRAMES).join(','))
        .split(',').filter(tf => cf.TIMEFRAMES[tf]);
      if (!tfs.length) return res.status(400).json({ ok: false, error: 'no valid timeframes' });

      res.json({ ok: true, lastUpdated: new Date().toISOString(), ...await readConfluence(symbol, tfs) });
    } catch (err) {
      console.error('[confluence]', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
