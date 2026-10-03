import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { startTestServer } from './harness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, 'golden', 'routes.json');

const { get, fake, stop } = await startTestServer();

// Wall-clock fields differ between runs; everything else must reproduce exactly.
const VOLATILE = new Set(['lastUpdated', 'lastReconcileAt', 'lastWsMessageAgeSec', 'at', 'ts',
  'startedAt', 'finishedAt', 'ageSec', 'syncedAt']);
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().filter(k => !VOLATILE.has(k)).map(k => [k, stable(v[k])]));
  }
  return v;
}

const snapshot = {};
const record = (name, body) => { snapshot[name] = stable(body); };

test.after(stop);

test('dashboard: equity is the margin balance and funding uses each symbol\'s interval', async () => {
  const { status, body } = await get('/api/dashboard');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  const bn = body.binance;
  const upnl = bn.positions.reduce((a, p) => a + p.upnl, 0);
  assert.ok(Math.abs(parseFloat(bn.equity) - (21200 + upnl)) < 0.01, `equity ${bn.equity}`);
  const eth = bn.positions.find(p => p.symbol === 'ETHUSDT');
  assert.equal(eth.fundingIntervalHours, 4);
  assert.ok(Math.abs(eth.fundingPerDayPct - 0.02 * 6) < 1e-9);
  assert.equal(body.hyperliquid.positions[0].fundingIntervalHours, 1);
  assert.ok(bn.orders.some(o => o.symbol === 'ETHUSDT' && o.reduceOnly));
  record('dashboard', body);
});

test('dashboard: a USDC pool counts in single-asset mode, where Binance totals are USDT only', async () => {
  const { body } = await get('/api/dashboard');
  const bn = body.binance;
  const usdc = bn.assets.find(a => a.asset === 'USDC');
  const usdt = bn.assets.find(a => a.asset === 'USDT');
  assert.ok(usdc && usdc.collateral, 'USDC listed as collateral');
  assert.ok(Math.abs(parseFloat(bn.equity) - (usdt.usdValue + usdc.usdValue)) < 0.01);
  const usdcUpnl = bn.positions.filter(p => p.symbol.endsWith('USDC')).reduce((a, p) => a + p.upnl, 0);
  assert.ok(Math.abs(usdc.marginBalance - (1200 + usdcUpnl)) < 0.01);
});

test('volstops covers every position on both venues', async () => {
  const { status, body } = await get('/api/volstops?risk=0.01&k=1.5');
  assert.equal(status, 200);
  assert.equal(body.positions.length, 5);
  for (const p of body.positions) assert.ok(p.stopPrice > 0, `${p.pair} stop ${p.stopPrice}`);
  record('volstops', body);
});

test('each leg\'s real stop is judged against the suggestion, and the tiles agree on who has one', async () => {
  const stops = (await get('/api/volstops?risk=0.01&k=1.5')).body;
  const verdictOf = (pair, side) => stops.positions.find(p => p.pair === pair && p.side === side);
  const btcLong = verdictOf('BTC/USDT', 'Long');
  assert.deepEqual(btcLong.yourStop.price, 90000);
  assert.equal(btcLong.yourStop.distancePct, 10);
  assert.ok(btcLong.yourStop.hit.windows > 0 && btcLong.yourStop.atrMultiple > 0);
  assert.ok(['ok', 'wide', 'tight'].includes(btcLong.verdict));
  assert.equal(verdictOf('BTC/USDT', 'Short').verdict, 'hedged');
  assert.equal(verdictOf('ETH/USDT', 'Long').verdict, 'none', 'a reduce-only take-profit is not a stop');
  assert.equal(verdictOf('SOL-PERP', 'Short').verdict, 'none');
  assert.equal(Object.values(stops.combined.stopVerdicts).reduce((a, b) => a + b, 0), 5);

  const dash = (await get('/api/dashboard')).body;
  const withStop = [...dash.binance.positions, ...dash.hyperliquid.positions].filter(p => p.hasStop).map(p => p.pair);
  assert.deepEqual(withStop, ['BTC/USDT']);
  const tileLeg = dash.binance.positions.find(p => p.symbol === 'BTCUSDT' && p.side === 'Long');
  assert.deepEqual([tileLeg.stop.verdict, tileLeg.stop.coverage, tileLeg.stop.price], ['set', 1, 90000]);
  assert.equal(dash.binance.positions.find(p => p.symbol === 'ETHUSDT').stop, null, 'a take-profit alone is no stop');
});

test('riskbook reproduces the exchange\'s own margin figures exactly', async () => {
  const { status, body } = await get('/api/riskbook');
  assert.equal(status, 200);
  assert.equal(body.pools.length, 2);
  for (const p of body.pools) {
    assert.equal(p.calibration.trustworthy, true, JSON.stringify(p.calibration));
    for (const c of p.liqCheck.filter(c => c.reportedLiqPrice && c.analyticErrPct != null)) {
      assert.ok(Math.abs(c.analyticErrPct) < 1e-6, `${c.key} ${c.analyticErrPct}`);
    }
  }
  record('riskbook', body);
  assert.equal((await get('/api/riskbook?fresh=1')).status, 200);
});

test('deleverage plans, and a malformed loss cap means no cap', async () => {
  const plan = await get('/api/deleverage?objective=free&target=5000');
  assert.equal(plan.status, 200);
  assert.equal(plan.body.plans.length, 2);
  for (const p of plan.body.plans) assert.ok(p.ceiling, `${p.marginAsset} has no ceiling`);
  record('deleverage', plan.body);
  const bad = await get('/api/deleverage?objective=free&maxLoss=abc');
  assert.equal(bad.status, 200);
  assert.equal(bad.body.ok, true);
});

test('history sync fills the store and the journal reconciles every fill', async () => {
  await get('/api/history/sync?start=true');
  let state;
  for (let i = 0; i < 100; i++) {
    state = (await get('/api/history/sync')).body.state;
    if (!state.running) break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(state.phase, 'done', JSON.stringify(state));
  assert.ok(state.tradesAdded > 0);
  const { status, body } = await get('/api/performance');
  assert.equal(status, 200);
  assert.ok(body.overall.trips > 0);
  const clockFree = { ...body, walletCurve: body.walletCurve.slice(0, -1),
    periods: Object.fromEntries(Object.entries(body.periods).map(([k, { from, ...rest }]) => [k, rest])) };
  record('performance', clockFree);
});

test('a session narrows trip statistics and habits, never the account overview', async () => {
  const all = (await get('/api/performance')).body;
  const { sessionOf } = await import('../sessions.js');
  const trips = (await get('/api/trips')).body.trips;
  const session = sessionOf(trips[0].openTime);
  const inIt = trips.filter(t => t.session === session).length;
  const one = (await get(`/api/performance?session=${encodeURIComponent(session)}`)).body;
  assert.equal(one.session, session);
  assert.equal(one.overall.trips, inIt);
  assert.ok(inIt < all.overall.trips || trips.every(t => t.session === session));
  assert.deepEqual(one.periods, all.periods, 'the overview is the whole account');
  assert.deepEqual(one.equity, all.equity);
  assert.ok(one.habits.every((h, i) => h.trips <= all.habits[i].trips));
  assert.equal((await get('/api/performance?session=Mars')).body.session, null);

  const cf = (await get(`/api/confluence?symbol=BTCUSDT&session=${encodeURIComponent(session)}`)).body;
  assert.deepEqual([cf.verdict.sessionTrust.session, cf.verdict.sessionTrust.tf], [session, '1h']);
});

test('trips carry context from the sync, funding from the ledger, and a re-sync fetches nothing', async () => {
  const { status, body } = await get('/api/trips');
  assert.equal(status, 200);
  assert.ok(body.trips.length > 0);
  assert.equal(body.coverage.pending, 0);
  assert.equal(body.coverage.ready, body.trips.length);
  for (const t of body.trips) {
    assert.ok(t.mae <= 0 && t.mfe >= 0, `${t.key} mae ${t.mae} mfe ${t.mfe}`);
    assert.ok(Number.isFinite(t.atrPct) && ['up', 'down', 'flat'].includes(t.btcTrend), t.key);
    assert.ok(['Asia', 'Europe', 'Europe + US', 'US', 'Off-hours', 'Weekend'].includes(t.session));
    assert.ok(t.openNotional > 0 && t.side === 'Long');
  }
  const covered = body.trips.filter(t => t.funding != null);
  assert.ok(covered.every(t => t.openTime >= body.coverage.incomeFrom));
  assert.ok(body.trips.some(t => t.funding == null), 'trips before the ledger starts have unknown funding');
  const eth = covered.filter(t => t.symbol === 'ETHUSDT' && t.funding !== 0);
  assert.ok(eth.length > 0 && eth.every(t => Math.abs(t.funding - -0.8) < 1e-9 && !t.fundingSplit));
  record('trips', body);

  const mark = fake.calls.length;
  await get('/api/history/sync?start=true');
  for (let i = 0; i < 100 && (await get('/api/history/sync')).body.state.running; i++) {
    await new Promise(r => setTimeout(r, 20));
  }
  assert.deepEqual(fake.calls.slice(mark).filter(c => c === '/fapi/v1/klines'), []);
});

test('hedge ledger locks the matched BTC pair', async () => {
  const { status, body } = await get('/api/hedgeledger');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  record('hedgeledger', body);
});

test('confluence scores every timeframe and rejects anything that is not a perpetual', async () => {
  const btc = await get('/api/confluence?symbol=BTCUSDT');
  assert.equal(btc.status, 200);
  assert.deepEqual(Object.keys(btc.body.timeframes), ['15m', '1h', '4h', '1d']);
  for (const r of Object.values(btc.body.timeframes)) assert.ok(r.score == null || Math.abs(r.score) <= 1);
  const v = btc.body.verdict;
  assert.equal(v.state, btc.body.overall.state);
  assert.ok(v.reasons.length > 0 && v.reasons.length <= 3);
  for (const r of [...v.reasons, ...(v.against ? [v.against] : [])]) {
    assert.ok(['1h', '4h', '1d'].includes(r.tf) && Number.isFinite(r.score) && r.record?.nEff >= 0, r.id);
  }
  assert.equal(v.trust.tf, '4h');
  assert.ok(['holds', 'fades', 'thin'].includes(v.trust.stability));
  const composite = btc.body.timeframes['4h'].calibration.composite;
  assert.equal(Object.values(composite.byRegime).reduce((a, r) => a + r.n, 0), composite.n);
  assert.ok(btc.body.timeframes['4h'].bars > 1000, 'calibrated on the deeper history');
  record('confluence', btc.body);
  const alt = await get('/api/confluence?symbol=ETHUSDT&tfs=1h,4h');
  assert.equal(alt.status, 200);
  assert.ok(alt.body.timeframes['1h'].btc);
  assert.equal((await get('/api/confluence?symbol=../../x')).status, 400);
  assert.equal((await get('/api/confluence?symbol=FOOUSDT')).status, 400);
  const sym = await get('/api/symbols');
  assert.equal(sym.body.symbols.length, 4);
});

test('the engine is served to the browser', async () => {
  const { status, body } = await get('/risk-engine.js');
  assert.equal(status, 200);
  assert.match(body, /export function evalPool/);
});

test('health reports a verdict without calling any exchange', async () => {
  const before = fake.calls.length;
  const { status, body } = await get('/api/health');
  assert.equal(status, 200);
  assert.ok(['ok', 'warn', 'bad'].includes(body.level));
  assert.equal(body.rate.weightLimit, 2400);
  assert.ok(body.snapshotAgeMs.binance != null);
  assert.equal(fake.calls.length, before);
});

const postGoal = (body, type = 'application/json') =>
  get('/api/goals', { method: 'POST', headers: { 'Content-Type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('goals: add, edit, pause, resume and delete persist, scored from the day each was set', async () => {
  const empty = (await get('/api/goals?tz=0')).body;
  assert.deepEqual([empty.ok, empty.goals, empty.today.scored], [true, [], 0]);
  record('goals', { ...empty, suggestions: empty.suggestions.map(({ preview: { strip, ...rest }, ...s }) => ({ ...s, preview: rest })) });

  assert.equal((await postGoal({ action: 'add', type: 'maxTradesPerDay', params: { max: 3 } })).status, 200);
  assert.equal((await postGoal({ action: 'add', type: 'noSessions', params: { sessions: ['Weekend'] } })).status, 200);
  let { goals } = (await get('/api/goals')).body;
  assert.equal(goals.length, 2);
  const cap = goals.find(g => g.type === 'maxTradesPerDay');
  assert.ok(cap.before.n > 0, 'synced history reported apart');
  assert.equal(cap.n, 0, 'nothing scored before the goal was set');

  await postGoal({ action: 'edit', id: cap.id, params: { max: 5 } });
  await postGoal({ action: 'pause', id: cap.id });
  goals = (await get('/api/goals')).body.goals;
  const edited = goals.find(g => g.id === cap.id);
  assert.deepEqual([edited.params.max, edited.setAt, edited.status], [5, cap.setAt, 'paused']);
  assert.equal(goals.at(-1).id, cap.id, 'paused goals sort last');

  await postGoal({ action: 'resume', id: cap.id });
  await postGoal({ action: 'delete', id: goals[0].id });
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.DASHBOARD_DATA_DIR, 'goals.json'), 'utf8'));
  assert.deepEqual(saved.map(g => [g.id, g.pauses.every(p => p.to != null), g.history.length]), [[cap.id, true, 1]]);
  await postGoal({ action: 'delete', id: cap.id });
});

test('goals accept only well-formed JSON changes, and preview without saving', async () => {
  assert.equal((await postGoal('action=add&type=maxLeverage', 'application/x-www-form-urlencoded')).status, 415);
  assert.equal((await postGoal('{"action":"add"')).status, 400);
  assert.equal((await postGoal({ action: 'add', type: 'maxLeverage', params: { max: 500 } })).status, 400);
  assert.equal((await postGoal({ action: 'drop', id: 'x' })).status, 400);
  assert.equal((await postGoal({ action: 'pause', id: 'missing' })).status, 400);

  const params = encodeURIComponent(JSON.stringify({ max: 2 }));
  const { status, body } = await get(`/api/goals/preview?type=maxTradesPerDay&params=${params}&tz=0`);
  assert.equal(status, 200);
  assert.ok(body.preview.n > 0);
  assert.equal(body.preview.strip.length, 14);
  assert.equal((await get('/api/goals/preview?type=maxTradesPerDay&params={bad')).status, 400);
  assert.deepEqual((await get('/api/goals')).body.goals, []);
});

test('milestones sit after rules, by target, and are scored from snapshots without counting transfers', async () => {
  for (const target of [60000, 20000]) await postGoal({ action: 'add', type: 'accountTarget', params: { target } });
  await postGoal({ action: 'add', type: 'monthlyDrawdown', params: { maxPct: 10 } });
  await postGoal({ action: 'add', type: 'noUnderwaterAdds' });
  assert.equal((await postGoal({ action: 'add', type: 'accountTarget', params: { target: 5, by: '2020-01-01' } })).status, 400);
  const { goals, today } = (await get('/api/goals?tz=0')).body;
  assert.deepEqual(goals.map(g => g.label), ['No adding while underwater', 'Monthly drawdown under 10%', 'Account ≥ $20k', 'Account ≥ $60k']);
  const target = goals[2];
  assert.ok(['early', 'reached'].includes(target.status), target.status);
  assert.ok(Array.isArray(today.offTrack));
  const params = encodeURIComponent(JSON.stringify({ target: 2e6 }));
  const preview = (await get(`/api/goals/preview?type=accountTarget&params=${params}`)).body.preview;
  assert.equal(preview.unit, 'milestone');
  assert.ok(preview.current > 0 && preview.needed > 0);
  for (const g of goals) await postGoal({ action: 'delete', id: g.id });
});

test('route output matches the golden snapshot', () => {
  if (!fs.existsSync(GOLDEN) || process.env.UPDATE_GOLDEN) {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, JSON.stringify(snapshot, null, 1) + '\n');
    return;
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  for (const name of Object.keys(golden)) assert.deepEqual(snapshot[name], golden[name], `${name} drifted from golden`);
});

test('a 418 pauses every Binance call until Retry-After passes', async () => {
  fake.ban(1);
  const first = await get('/api/confluence?symbol=SOLUSDT&tfs=1h');
  assert.equal(first.body.timeframes?.['1h'] ?? null, null);
  const before = fake.calls.length;
  const second = await get('/api/riskbook?fresh=1');
  assert.equal(second.status, 500);
  assert.match(second.body.error, /paused/);
  assert.equal(fake.calls.filter(c => !c.startsWith('hl:')).length, fake.calls.slice(0, before).filter(c => !c.startsWith('hl:')).length);
  await new Promise(r => setTimeout(r, 1100));
  assert.equal((await get('/api/riskbook?fresh=1')).status, 200);
});

test('an increasing fill on the stream captures its entry context once, joined to its trip', async () => {
  const { applyUserDataEvent, onFill } = await import('../lib/orders-stream.js');
  const { captureEntryContext } = await import('../lib/entry-context.js');
  const captures = [];
  onFill(o => captures.push(captureEntryContext(o, { stopDelayMs: 0 })));

  const trip = (await get('/api/trips')).body.trips.find(t => t.symbol === 'BTCUSDT');
  const fill = (x = {}) => ({ e: 'ORDER_TRADE_UPDATE', o: { x: 'TRADE', X: 'PARTIALLY_FILLED', s: 'BTCUSDT', S: 'BUY',
    ps: 'LONG', i: trip.openOrderId, L: String(trip.avgEntry), l: '0.05', q: '0.1', z: '0.05', T: trip.openTime,
    R: false, o: 'MARKET', p: '0', sp: '0', ...x } });
  applyUserDataEvent(fill());
  applyUserDataEvent(fill({ X: 'FILLED', z: '0.1' }));
  applyUserDataEvent(fill({ i: 999, S: 'SELL' }));
  await Promise.all(captures);

  const rows = fs.readFileSync(path.join(process.env.DASHBOARD_DATA_DIR, 'entry-context.ndjson'), 'utf8')
    .trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(r => `${r.orderId}:${r.stage}`), [`${trip.openOrderId}:entry`, `${trip.openOrderId}:stop`]);

  const joined = (await get('/api/trips')).body.trips.find(t => t.key === trip.key).entry;
  assert.deepEqual(joined.errors, []);
  assert.ok(joined.account.equity > 0 && joined.account.leverage === 10);
  assert.ok(Number.isFinite(joined.confluence.score) && '1h' in joined.confluence.byTf);
  assert.ok(joined.suggestedStop.price < trip.avgEntry && joined.suggestedStop.distancePct > 0);
  assert.deepEqual([joined.yourStop.price, joined.yourStop.distancePct, joined.yourStop.coverage],
    [90000, +((trip.avgEntry - 90000) / trip.avgEntry * 100).toFixed(3), null], 'coverage is not judged against one fill');
  assert.equal(joined.stopLooked, true);
});

test('the wallet plus open positions is the margin balance, never counted twice', async () => {
  const bn = (await get('/api/dashboard')).body.binance;
  const upnl = bn.positions.reduce((a, p) => a + p.upnl, 0);
  assert.ok(Math.abs(parseFloat(bn.walletBalance) + upnl - parseFloat(bn.equity)) < 0.01,
    `${bn.walletBalance} + ${upnl} vs ${bn.equity}`);
});

test('equity snapshots record once per interval and feed the account curve and period change', async () => {
  const { recordEquitySnapshot } = await import('../lib/equity-snapshots.js');
  const interval = 15 * 60_000;
  const t0 = Math.floor(Date.now() / interval) * interval;
  await recordEquitySnapshot(t0 - interval + 1000, interval);
  await recordEquitySnapshot(t0 + 1000, interval);
  await recordEquitySnapshot(t0 + 2000, interval);
  const { body } = await get('/api/performance?tz=120');
  assert.deepEqual(body.accountCurve.map(p => p.t), [t0 - interval, t0]);
  const dash = (await get('/api/dashboard')).body;
  const total = parseFloat(dash.binance.equity) + parseFloat(dash.hyperliquid.equity);
  assert.ok(body.accountCurve.every(p => Math.abs(p.accountValue - total) < 0.01));
  assert.equal(body.periods.today.account?.change ?? 0, 0, 'no move between the two snapshots');
  assert.equal(body.walletCurve.at(-1).wallet, +parseFloat(dash.binance.walletBalance).toFixed(2));
  assert.equal(body.habits.length, 4);
});

const setVenue = (venue, enabled) => get('/api/venues', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ venue, enabled })
});
const savedVenues = () =>
  JSON.parse(fs.readFileSync(path.join(process.env.DASHBOARD_DATA_DIR, 'settings.json'), 'utf8')).venues;

test('Hyperliquid off: no Hyperliquid request from any route, and the choice is saved', async () => {
  const off = await setVenue('hyperliquid', false);
  assert.equal(off.status, 200);
  assert.equal(off.body.venues.hyperliquid.enabled, false);
  assert.equal(savedVenues().hyperliquid, false);

  const mark = fake.calls.length;
  const dash = await get('/api/dashboard');
  await get('/api/volstops?risk=0.01&k=1.5');
  const health = await get('/api/health');
  assert.deepEqual(fake.calls.slice(mark).filter(c => c.startsWith('hl:')), []);
  assert.equal(dash.body.venues.hyperliquid, false);
  assert.equal(dash.body.hyperliquid.positions.length, 0);
  assert.equal(parseFloat(dash.body.summary.totalEquity), parseFloat(dash.body.binance.equity));
  assert.ok(!health.body.reasons.some(r => /hyperliquid/.test(r.text)));

  assert.equal((await setVenue('hyperliquid', true)).body.venues.hyperliquid.enabled, true);
  assert.ok((await get('/api/dashboard')).body.hyperliquid.positions.length > 0);
});

test('Binance off: no signed request, account tools refuse, the journal still reads its cache', async () => {
  assert.equal((await setVenue('binance', false)).status, 200);
  const mark = fake.signedCalls.length;

  const dash = await get('/api/dashboard');
  assert.equal(dash.body.binance.positions.length, 0);
  assert.equal(dash.body.binance.orders.length, 0);
  assert.equal((await get('/api/volstops?risk=0.01&k=1.5')).status, 200);
  for (const route of ['/api/riskbook', '/api/deleverage', '/api/hedgeledger', '/api/history/sync?start=true']) {
    const { status, body } = await get(route);
    assert.equal(status, 409, route);
    assert.equal(body.disabled, true, route);
  }
  assert.equal((await get('/api/performance')).status, 200);
  assert.deepEqual(fake.signedCalls.slice(mark), []);

  assert.equal((await setVenue('binance', true)).status, 200);
  const back = await get('/api/dashboard');
  assert.ok(back.body.binance.positions.length > 0);
  assert.ok(back.body.binance.orders.some(o => o.reduceOnly), 'order cache reseeded on resume');
});

test('the venue switch accepts only a well-formed JSON body', async () => {
  const post = (body, type = 'application/json') =>
    get('/api/venues', { method: 'POST', headers: { 'Content-Type': type }, body });
  assert.equal((await post('venue=binance&enabled=false', 'application/x-www-form-urlencoded')).status, 415);
  assert.equal((await post('{"venue":"binance","enabled":fal')).status, 400);
  assert.equal((await post(JSON.stringify({ venue: 'kraken', enabled: false }))).status, 400);
  assert.equal((await post(JSON.stringify({ venue: 'binance', enabled: 'false' }))).status, 400);
  const state = await get('/api/venues');
  assert.equal(state.body.venues.binance.enabled, true);
  assert.equal(state.body.venues.hyperliquid.enabled, true);
});
