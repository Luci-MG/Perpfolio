import * as ta from '../trade-analytics.js';
import { habitCosts } from '../habits.js';
import { analytics } from '../lib/analytics.js';
import { getBinanceData } from '../lib/binance-account.js';
import { readEquitySnapshots } from '../lib/equity-snapshots.js';
import { enrichedTrips } from '../lib/trip-enrichment.js';
import { syncState } from '../lib/history-sync.js';

export function register(app) {
  app.get('/api/performance', async (req, res) => {
    try {
      const { income, trips, stillOpen, nonQuoteFees, orphans, execution } = analytics();
      if (!income.length && !trips.length) {
        return res.json({ ok: true, empty: true,
                          hint: 'No cached history yet — run a sync first.' });
      }

      const days = parseInt(req.query.days, 10);
      const cutoff = days > 0 ? Date.now() - days * 86_400_000 : 0;
      const inWindow = trips.filter(t => t.closeTime >= cutoff);
      const incomeWindow = income.filter(r => r.time >= cutoff);

      const equity = ta.equityCurve(incomeWindow);
      const totals = ta.incomeTotals(incomeWindow);
      const now = Date.now();
      const starts = ta.periodStarts(now, parseInt(req.query.tz, 10) || 0);
      const snapshots = readEquitySnapshots();
      const bn = await getBinanceData();
      const periodsNet = ta.periodNet(income, trips, starts);
      const periodsAccount = ta.accountChange(snapshots, income, starts);
      const periods = Object.fromEntries(Object.keys(starts).map(k => [k, { ...periodsNet[k], account: periodsAccount[k] }]));

      res.json({
        ok: true,
        lastUpdated: new Date().toISOString(),
        window: { days: days > 0 ? days : null,
                  from: incomeWindow.length ? new Date(incomeWindow.reduce((m, r) => Math.min(m, r.time), Infinity)).toISOString() : null,
                  tripsFrom: inWindow.length ? new Date(inWindow.reduce((m, t) => Math.min(m, t.openTime), Infinity)).toISOString() : null },
        overall: ta.summarise(inWindow),
        behaviour: ta.behaviourSplit(inWindow),
        bySymbol: ta.bySymbol(inWindow),
        equity,
        calendar: ta.calendar(incomeWindow),
        totals: totals.totals,
        feeDragPct: totals.feeDragPct,
        nonQuoteFees: +nonQuoteFees.toFixed(4),
        stillOpen: stillOpen.length,
        orphans: { fills: orphans.fills, realized: +orphans.realized.toFixed(2), commission: +orphans.commission.toFixed(2) },

        // journal sections
        holdTime: ta.byHoldTime(inWindow),
        dayOfWeek: ta.byDayOfWeek(inWindow),
        hourOfDay: ta.byHourOfDay(inWindow),
        side: ta.bySide(inWindow),
        month: ta.byMonth(inWindow),
        streaks: ta.streaks(inWindow),
        sequence: ta.sequenceEffect(inWindow),
        size: ta.sizeDistribution(inWindow),
        execution,
        records: ta.records(inWindow, equity),
        fundingBySymbol: Object.entries(incomeWindow
            .filter(r => r.incomeType === 'FUNDING_FEE' && r.symbol)
            .reduce((acc, r) => { acc[r.symbol] = (acc[r.symbol] || 0) + parseFloat(r.income); return acc; }, {}))
          .map(([symbol, v]) => ({ symbol, funding: +v.toFixed(2) }))
          .sort((a, b) => a.funding - b.funding),
        feesBySymbol: Object.entries(incomeWindow
            .filter(r => r.incomeType === 'COMMISSION' && r.symbol)
            .reduce((acc, r) => { acc[r.symbol] = (acc[r.symbol] || 0) + Math.abs(parseFloat(r.income)); return acc; }, {}))
          .map(([symbol, v]) => ({ symbol, fees: +v.toFixed(2) }))
          .sort((a, b) => b.fees - a.fees),
        periods,
        walletCurve: bn.disabled ? [] : ta.walletCurve(incomeWindow, bn.walletBalance, now),
        accountCurve: snapshots.filter(s => s.t >= cutoff).map(s => ({ t: s.t, accountValue: s.accountValue })),
        habits: habitCosts(enrichedTrips().trips.filter(t => t.closeTime >= cutoff)),
        syncedAt: syncState.finishedAt
      });
    } catch (err) {
      console.error('[performance]', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
