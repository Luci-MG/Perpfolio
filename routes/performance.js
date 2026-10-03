import { SESSIONS } from '../sessions.js';
import * as ta from '../trade-analytics.js';
import * as perf from '../performance.js';
import * as breakdowns from '../breakdowns.js';
import * as costs from '../costs.js';
import * as store from '../history-store.js';
import { localDayStart } from '../local-time.js';
import { unmatchedFunding } from '../trip-context.js';
import { habitReport, sizing } from '../habits.js';
import { analytics } from '../lib/analytics.js';
import { getBinanceData } from '../lib/binance-account.js';
import { commissionFor, feeBurnStatus } from '../lib/binance-meta.js';
import { getKlinesTf } from '../lib/confluence-data.js';
import { readEquitySnapshots } from '../lib/equity-snapshots.js';
import { enrichedTrips } from '../lib/trip-enrichment.js';
import { META_FILE, syncState } from '../lib/history-sync.js';
import { readerClock } from '../lib/util.js';

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

const RATED_SHARE = 0.8;
const RATED_SYMBOLS = 5;

async function bnbPriceFor(trips) {
  if (!trips.some(t => t.bnbFee > 0)) return () => null;
  const daily = await getKlinesTf('BNBUSDT', '1d');
  const closes = (daily?.candles || []).map(c => [c.t, c.close]);
  return ts => closes.filter(([t]) => t <= ts).at(-1)?.[1] ?? null;
}

async function feeRatesFor(trips) {
  const traded = new Map();
  for (const t of trips) traded.set(t.symbol, (traded.get(t.symbol) || 0) + (t.tradedNotional || 0));
  const total = [...traded.values()].reduce((s, v) => s + v, 0);
  const ranked = [...traded].sort((a, b) => b[1] - a[1]);
  const chosen = [];
  for (const [symbol, v] of ranked) {
    if (chosen.length >= RATED_SYMBOLS || chosen.reduce((s, [, x]) => s + x, 0) >= RATED_SHARE * total) break;
    chosen.push([symbol, v]);
  }
  const rates = await Promise.all(chosen.map(([symbol]) => commissionFor(symbol)));
  return Object.fromEntries(chosen.map(([symbol], i) => [symbol, rates[i]]));
}

async function costsOf({ scope, previousTrips, enriched, inSession, bn, analyticsData, win, now, tz, snapshots }) {
  const bnbPrice = await bnbPriceFor([...scope, ...(previousTrips || [])]);
  const binanceOn = !bn.disabled;
  const [rates, feeBurn] = binanceOn ? await Promise.all([feeRatesFor(scope), feeBurnStatus()]) : [{}, null];
  const meta = store.readJson(META_FILE, {});
  return {
    summary: costs.costSummary(scope, { bnbPrice }),
    previous: previousTrips && costs.costSummary(previousTrips, { bnbPrice }),
    feeCheck: costs.feeCheck(scope, rates),
    feeBurn,
    weekly: costs.weeklyCosts(scope, tz),
    makerTrend: costs.makerTrend(enriched.filter(inSession), now),
    bySymbol: costs.symbolCosts(scope),
    ledger: binanceOn ? costs.walletLedger({
      income: analyticsData.income, from: win.from, walletAtSync: meta.walletAtSync ?? null, walletLive: bn.walletBalance,
      fills: analyticsData.fillLedger, snapshots,
      unmatched: unmatchedFunding({ trips: analyticsData.trips, stillOpen: analyticsData.stillOpen, income: analyticsData.income, from: win.from,
                                 preHistoryUntil: analyticsData.preHistoryUntil })
    }) : null
  };
}

async function accountOf({ income, snapshots, walletNow, now, tz, win }) {
  const full = perf.dailySeries({ income, walletNow, snapshots, now, tz });
  const series = full.filter(r => r.day >= localDayStart(win.from, tz));
  const ratios = perf.riskAdjusted(series);
  const btc = ratios.needs === 0 ? await getKlinesTf('BTCUSDT', '1d') : null;
  const previous = win.previous && full.filter(r => r.day >= localDayStart(win.previous.from, tz) && r.day < localDayStart(win.previous.to, tz));
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
      const analyticsData = analytics();
      const { income, trips, nonQuoteFees, orphans, openLegCheck } = analyticsData;
      if (!income.length && !trips.length) {
        return res.json({ ok: true, empty: true, hint: 'No cached history yet — run a sync first.' });
      }
      const now = Date.now();
      const tz = readerClock(req.query);
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
        habits: habitReport(enriched, { inScope, inPrevious, inSession, now, tz }),
        sizing: sizing(enriched, inScope),
        month: ta.byMonth(scope, tz),
        holdTime: ta.byHoldTime(scope),
        side: ta.bySide(scope),
        timing: { calendarSource: session ? 'trips' : 'ledger', weekday: breakdowns.byWeekday(scope, tz), hour: breakdowns.byHour(scope, tz),
                  grid: breakdowns.openingGrid(scope, tz),
                  calendar: breakdowns.calendarOf(days.map(({ date, pnl }) => ({ date, pnl })), scope, tz) },
        symbols: breakdowns.bySymbol(scope),
        costs: await costsOf({ scope, previousTrips: inPrevious && enriched.filter(inPrevious), enriched, inSession, bn,
                               analyticsData, win, now, tz, snapshots }),
        nonQuoteFees: +nonQuoteFees.toFixed(4),
        orphans: { fills: orphans.fills, realized: +orphans.realized.toFixed(2) },
        openLegCheck,
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
