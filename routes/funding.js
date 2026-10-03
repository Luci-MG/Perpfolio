import { fundingBook } from '../funding.js';
import { analytics } from '../lib/analytics.js';
import { getBinanceData } from '../lib/binance-account.js';
import { fundingMeta, refreshFundingMeta } from '../lib/binance-meta.js';
import { publicGet } from '../lib/confluence-data.js';
import * as store from '../history-store.js';
import { META_FILE, syncState } from '../lib/history-sync.js';
import { getHyperliquidData } from '../lib/hyperliquid.js';

const HISTORY_TTL_MS = 3_600_000;
const HISTORY_ROWS = 200;

async function rateHistory(symbol) {
  const rows = await publicGet('/fapi/v1/fundingRate', { symbol, limit: HISTORY_ROWS }, HISTORY_TTL_MS);
  return (rows || []).map(r => ({ t: r.fundingTime, ratePct: parseFloat(r.fundingRate) * 100, rateType: r.rateType ?? null }));
}

export function register(app) {
  app.get('/api/funding', async (req, res) => {
    try {
      const [bn, hl] = await Promise.all([getBinanceData(), getHyperliquidData(), refreshFundingMeta()]);
      const symbols = [...new Set(bn.openPositions.map(p => p.symbol))];
      const histories = await Promise.all(symbols.map(rateHistory));
      res.json({ ok: true, ...fundingBook({
        legs: [...bn.openPositions, ...hl.openPositions], meta: fundingMeta,
        history: Object.fromEntries(symbols.map((s, i) => [s, histories[i]])),
        income: analytics().income, equity: (parseFloat(bn.equity) || 0) + (parseFloat(hl.equity) || 0) || null,
        now: Date.now(), syncedAt: syncState.finishedAt ?? store.readJson(META_FILE, {}).walletAtSync?.at ?? null
      }) });
    } catch (err) {
      console.error('[funding]', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
