import { SESSIONS } from '../sessions.js';
import * as ta from '../trade-analytics.js';
import * as perf from '../performance.js';
import { habitReport, sizing } from '../habits.js';
import { analytics } from '../lib/analytics.js';
import { getBinanceData } from '../lib/binance-account.js';
import { getKlinesTf } from '../lib/confluence-data.js';
import { readEquitySnapshots } from '../lib/equity-snapshots.js';
import { enrichedTrips } from '../lib/trip-enrichment.js';
import { syncState } from '../lib/history-sync.js';

const RECENT_TRIPS = 5;
const DAY_MS = 86_400_000;
const HEADLINE_KEYS = ['units', 'legs', 'net', 'winRate', 'expectancy'];

const pick = (obj, keys) => Object.fromEntries(keys.map(k => [k, obj[k]]));
const iso = ts => (Number.isFinite(ts) ? new Date(ts).toISOString() : null);

function windowOf(query, now) {
  const days = parseInt(query.days, 10) > 0 ? parseInt(query.days, 10) : null;
  const from = days ? now - days * DAY_MS : 0;
  return { days, from, previous: days ? { from: from - days * DAY_MS, to: from } : null };
}

function costsOf(scope, incomeWindow, session) {
  if (!session) {
    const { totals, feeDragPct } = ta.incomeTotals(incomeWindow);
    const bySymbol = ta.costsBySymbol(incomeWindow
      .filter(r => r.incomeType === 'COMMISSION' || r.incomeType === 'FUNDING_FEE')
      .map(r => (r.incomeType === 'COMMISSION' ? { symbol: r.symbol, fees: Math.abs(parseFloat(r.income)) }
                                               : { symbol: r.symbol, funding: parseFloat(r.income) })));
    return { fees: -(totals.COMMISSION || 0), funding: totals.FUNDING_FEE || 0, realised: totals.REALIZED_PNL || 0, feeDragPct, bySymbol };
  }
  const realised = scope.reduce((s, t) => s + t.realized, 0);
  const fees = scope.reduce((s, t) => s + t.commission, 0);
  return { fees: +fees.toFixed(2), funding: +scope.reduce((s, t) => s + (t.funding ?? 0), 0).toFixed(2), realised: +realised.toFixed(2),
           feeDragPct: realised ? +(fees / Math.abs(realised) * 100).toFixed(1) : null,
           bySymbol: ta.costsBySymbol(scope.map(t => ({ symbol: t.symbol, fees: t.commission, funding: t.funding ?? 0 }))) };
}

async function accountOf({ income, snapshots, walletNow, now, tz, win }) {
  const full = perf.dailySeries({ income, walletNow, snapshots, now, tzOffsetMin: tz });
  const series = full.filter(r => r.day >= perf.localDayStart(win.from, tz));
  const ratios = perf.riskAdjusted(series);
  const btc = ratios.needs === 0 ? await getKlinesTf('BTCUSDT', '1d') : null;
  const previous = win.previous && full.filter(r => r.day >= perf.localDayStart(win.previous.from, tz) && r.day < perf.localDayStart(win.previous.to, tz));
  return {
    curve: 'account', days: series.length,
    series: series.map(({ date, source, value, pnl, flow, ret }) => ({ date, source, value, pnl, flow, ret })),
    accountFrom: series.find(r => r.source === 'account')?.date ?? null,
    twr: perf.timeWeightedReturn(series), drawdown: perf.drawdown(series), ratios,
    beta: btc ? perf.btcBeta(series, btc.candles) : { n: ratios.n, needs: ratios.needs },
    previousTwr: previous ? perf.timeWeightedReturn(previous) : null
  };
}

function tripCurveOf(scope, tz) {
  const series = perf.dailyTripNet(scope, tz);
  const worst = series.reduce((m, r) => Math.min(m, r.ddUsd), 0);
  return { curve: 'trips', days: series.length, series, maxDrawdownUsd: worst };
}

export function register(app) {
  app.get('/api/performance', async (req, res) => {
    try {
      const { income, trips, nonQuoteFees, orphans, execution } = analytics();
      if (!income.length && !trips.length) {
        return res.json({ ok: true, empty: true, hint: 'No cached history yet — run a sync first.' });
      }
      const now = Date.now();
      const tz = parseInt(req.query.tz, 10) || 0;
      const win = windowOf(req.query, now);
      const session = SESSIONS.includes(req.query.session) ? req.query.session : null;
      const inSession = t => !session || t.session === session;
      const inScope = t => t.closeTime >= win.from && inSession(t);
      const inPrevious = win.previous && (t => t.closeTime >= win.previous.from && t.closeTime < win.previous.to && inSession(t));

      const enriched = enrichedTrips().trips;
      const scope = enriched.filter(inScope);
      const incomeWindow = income.filter(r => r.time >= win.from);
      const snapshots = readEquitySnapshots();
      const bn = await getBinanceData();
      const walletNow = bn.disabled ? null : bn.walletBalance;
      const account = session ? tripCurveOf(scope, tz)
        : await accountOf({ income, snapshots, walletNow, now, tz, win });
      const days = session ? account.series : ta.dailyIncomeNet(incomeWindow, tz);

      const starts = ta.periodStarts(now, tz);
      const previousStarts = ta.previousPeriodStarts(now, tz);
      const periodsNet = ta.periodNet(income, trips, starts);
      const periodsAccount = ta.accountChange(snapshots, income, starts);
      const periods = Object.fromEntries(Object.keys(starts).map(k => [k, { ...periodsNet[k], account: periodsAccount[k],
        previous: ta.periodNetBetween(income, trips, previousStarts[k].from, previousStarts[k].to) }]));

      res.json({
        ok: true,
        lastUpdated: new Date(now).toISOString(),
        session,
        window: { days: win.days, from: iso(incomeWindow.reduce((m, r) => Math.min(m, r.time), Infinity)),
                  tripsFrom: iso(scope.reduce((m, t) => Math.min(m, t.openTime), Infinity)),
                  previous: win.previous && { from: iso(win.previous.from), to: iso(win.previous.to) } },
        overall: ta.summarise(scope),
        units: perf.unitStats(scope),
        previous: inPrevious && { ...pick(perf.unitStats(enriched.filter(inPrevious), { intervals: false }), HEADLINE_KEYS),
                                  twr: account.previousTwr?.pct ?? null },
        account,
        streaks: perf.streaksVsChance(scope),
        records: perf.records(scope, days),
        habits: habitReport(enriched, { inScope, inPrevious, inSession, now, tzOffsetMin: tz }),
        sizing: sizing(enriched, inScope),
        month: ta.byMonth(scope, tz),
        holdTime: ta.byHoldTime(scope),
        side: ta.bySide(scope),
        dayOfWeek: ta.byDayOfWeek(scope, 'closeTime', tz),
        hourOfDay: ta.byHourOfDay(scope, 'openTime', tz),
        bySymbol: ta.bySymbol(scope),
        calendar: ta.calendar(days.map(({ date, pnl }) => ({ date, pnl })).filter(d => d.pnl != null)),
        costs: costsOf(scope, incomeWindow, session),
        totals: ta.incomeTotals(incomeWindow).totals,
        nonQuoteFees: +nonQuoteFees.toFixed(4),
        orphans: { fills: orphans.fills, realized: +orphans.realized.toFixed(2) },
        execution: pick(execution, ['maker', 'taker', 'fills', 'makerPct', 'makerFee', 'takerFee', 'totalFee']),
        periods,
        walletCurve: bn.disabled ? [] : ta.walletCurve(incomeWindow, bn.walletBalance, now),
        accountCurve: snapshots.filter(s => s.t >= win.from).map(s => ({ t: s.t, accountValue: s.accountValue })),
        recentTrips: [...enriched].sort((a, b) => b.closeTime - a.closeTime).slice(0, RECENT_TRIPS)
          .map(({ key, symbol, side, openTime, closeTime, holdHours, net, netAfterFunding, tags, note }) =>
            ({ key, symbol, side, openTime, closeTime, holdHours, net: netAfterFunding ?? net, tags, note })),
        syncedAt: syncState.finishedAt
      });
    } catch (err) {
      console.error('[performance]', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });
}
