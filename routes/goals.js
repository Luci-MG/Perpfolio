import { GOAL_TYPES, equityLookup, previewGoal, scoreGoal, suggestGoals, validateGoal } from '../goals.js';
import { walletCurve } from '../trade-analytics.js';
import { analytics } from '../lib/analytics.js';
import { getBinanceData } from '../lib/binance-account.js';
import { readEquitySnapshots } from '../lib/equity-snapshots.js';
import { changeGoals, readGoals } from '../lib/goals-store.js';
import { jsonOnly } from '../lib/http.js';
import { enrichedTrips } from '../lib/trip-enrichment.js';
import { readerClock } from '../lib/util.js';

const parseJson = jsonOnly('2kb');

const TYPES = GOAL_TYPES.map(({ id, label, unit, forwardOnly = false, scoped = true, params }) =>
  ({ id, label, unit, forwardOnly, scoped, params }));

const STATUS_ORDER = ['broken', 'progress', 'kept', 'idle', 'paused'];
const OFF_TRACK = ['missed', 'late'];

async function scoringContext(query) {
  const now = Date.now();
  const bn = await getBinanceData();
  const { income } = analytics();
  const wallet = bn.disabled ? [] : walletCurve(income, bn.walletBalance, now);
  const snapshots = readEquitySnapshots();
  const transfers = income.filter(r => r.incomeType === 'TRANSFER').map(r => ({ t: r.time, amount: parseFloat(r.income) }));
  return { now, tz: readerClock(query), equityAt: equityLookup(snapshots, wallet), snapshots, transfers, wallet };
}

const milestoneRank = g => [g.status === 'paused', g.type === 'accountTarget', g.params.target ?? 0];
const byMilestoneRank = (a, b) => milestoneRank(a).reduce((d, v, i) => d || v - milestoneRank(b)[i], 0);

function rulesOrdered(rules) {
  const order = g => STATUS_ORDER.indexOf(g.status);
  return rules.map((g, i) => ({ g, i })).sort((a, b) => order(a.g) - order(b.g) || a.i - b.i).map(x => x.g);
}

function scoreboard(goals, trips, ctx) {
  const scored = goals.map(g => scoreGoal(g, trips, ctx));
  const rules = scored.filter(g => g.unit !== 'milestone');
  const milestones = scored.filter(g => g.unit === 'milestone');
  const active = rules.filter(g => g.status !== 'paused' && g.today.trips > 0);
  return { goals: [...rulesOrdered(rules), ...[...milestones].sort(byMilestoneRank)],
           today: { scored: active.length, kept: active.filter(g => g.status !== 'broken').length,
                    broken: active.filter(g => g.status === 'broken').map(g => g.label),
                    offTrack: milestones.filter(g => OFF_TRACK.includes(g.status)).map(g => ({ label: g.label, status: g.status })) },
           suggestions: suggestGoals(trips, ctx, goals.map(g => g.type)) };
}

function parsePreview(query) {
  let params;
  try { params = query.params ? JSON.parse(query.params) : {}; } catch { throw new Error('params must be JSON'); }
  return validateGoal({ type: query.type, params, session: query.session || null });
}

export function register(app) {
  app.get('/api/goals', async (req, res) => {
    try {
      const { trips, coverage } = enrichedTrips();
      const ctx = await scoringContext(req.query);
      res.json({ ok: true, types: TYPES, ...scoreboard(readGoals(), trips, ctx), entryCapturedSince: coverage.entryCapturedSince });
    } catch (err) {
      console.error('[goals]', err);
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/api/goals/preview', async (req, res) => {
    let goal;
    try { goal = parsePreview(req.query); } catch (err) { return res.status(400).json({ ok: false, error: err.message }); }
    try {
      const ctx = await scoringContext(req.query);
      res.json({ ok: true, preview: previewGoal(goal, enrichedTrips().trips, ctx) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/api/goals', parseJson, (req, res) => {
    try {
      changeGoals(req.body);
      res.json({ ok: true });
    } catch (err) {
      res.status(err.status ?? 400).json({ ok: false, error: err.message });
    }
  });
}
