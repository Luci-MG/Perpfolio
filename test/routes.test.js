import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { startTestServer } from './harness.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, 'golden', 'routes.json');

const { base, get, fake, stop } = await startTestServer();

// Wall-clock fields differ between runs, named by path; everything else must reproduce, with
// floats compared to ten significant digits so a Node or V8 upgrade cannot move the last ulp.
const VOLATILE = [/^\w+\.lastUpdated$/, /^riskbook\.account\.orderFeed\.(lastReconcileAt|lastWsMessageAgeSec)$/,
  /^riskbook\.pools\[\]\.fees\.\w+\.ts$/, /^performance\.(syncedAt|costs\.ledger\.at|openLegCheck\.at)$/,
  /^trips\.coverage\.incomeCompleteFrom$/];
const volatile = at => VOLATILE.some(re => re.test(at));
function stable(v, at) {
  if (Array.isArray(v)) return v.map(x => stable(x, `${at}[]`));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().filter(k => !volatile(`${at}.${k}`)).map(k => [k, stable(v[k], `${at}.${k}`)]));
  }
  return typeof v === 'number' && !Number.isInteger(v) ? +v.toPrecision(10) : v;
}

const snapshot = {};
const record = (name, body) => { snapshot[name] = stable(body, name); };
const startSync = (body = {}) => get('/api/history/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

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

test('dashboard: unreadable stop orders show as unknown, never as no stop, and are read again next time', async () => {
  fake.fail('/fapi/v1/openAlgoOrders');
  const down = (await get('/api/dashboard?fresh=1')).body;
  assert.equal(down.binance.stopsKnown, false);
  assert.ok(down.binance.positions.every(p => p.stopKnown === false && p.hasStop === null && p.stop === null));
  assert.equal(down.hyperliquid.stopsKnown, true);
  fake.heal();
  const up = (await get('/api/dashboard')).body;
  assert.deepEqual([up.binance.stopsKnown, up.binance.positions.some(p => p.hasStop)], [true, true]);
});

test('dashboard: unreadable mark prices fail the Binance read rather than price collateral at 1', async () => {
  fake.fail('/fapi/v1/premiumIndex');
  const { status, body } = await get('/api/dashboard?fresh=1');
  fake.heal();
  assert.deepEqual([status, body.summary?.partial], [200, ['binance']], JSON.stringify(body.binance?.error));
});

test('dashboard: one venue down leaves the other on screen and marks the totals partial; both down is an error', async () => {
  fake.fail('hl:clearinghouseState');
  const hlDown = await get('/api/dashboard?fresh=1');
  assert.equal(hlDown.status, 200);
  assert.deepEqual(hlDown.body.summary.partial, ['hyperliquid']);
  assert.match(hlDown.body.hyperliquid.error, /500/);
  assert.ok(hlDown.body.binance.positions.length > 0);
  fake.fail('/fapi/v2/account');
  const bothDown = await get('/api/dashboard?fresh=1');
  fake.heal();
  assert.equal(bothDown.status, 500);
  assert.match(bothDown.body.error, /hyperliquid: .*binance: /);
  assert.deepEqual((await get('/api/dashboard?fresh=1')).body.summary.partial, []);
});

test('volstops covers every position on both venues', async () => {
  const { status, body } = await get('/api/volstops?risk=0.01&k=1.5');
  assert.equal(status, 200);
  assert.equal(body.positions.length, 5);
  for (const p of body.positions) assert.ok(p.stopPrice > 0, `${p.pair} stop ${p.stopPrice}`);
  record('volstops', body);

  const dash = (await get('/api/dashboard')).body;
  const legs = [...dash.binance.positions, ...dash.hyperliquid.positions];
  const sizeOf = r => Math.abs(legs.find(p => p.exchange === r.exchange && p.pair === r.pair && p.side === r.side).sizeUsd);
  const weighted = body.positions.reduce((s, r) => s + r.compositeVolPct * sizeOf(r), 0) / body.positions.reduce((s, r) => s + sizeOf(r), 0);
  assert.ok(Math.abs(body.combined.portfolioVolPct - weighted) < 1e-3, 'today\'s portfolio vol is weighted by real notional, like its history');
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

test('deleverage plans with the account\'s own taker rate unless a fee is given, and a fee of 0 is 0', async () => {
  const own = (await get('/api/deleverage?objective=free')).body;
  assert.deepEqual(own.plans.map(p => p.fee), own.plans.map(() => ({ rate: 0.0005, source: 'account' })));
  const free = (await get('/api/deleverage?objective=free&fee=0')).body;
  assert.deepEqual([free.params.feeRate, ...free.plans.map(p => p.fee.source)], [0, 'given', 'given']);
  assert.ok(free.plans.every(p => p.ceiling.closeAllFees === 0), 'no fee charged on any close');
});

test('a position with no usable mark gets an empty risk row instead of failing the risk book', async () => {
  fake.reportMark('ETHUSDT', 0);
  const { status, body } = await get('/api/riskbook?fresh=1');
  fake.heal();
  await get('/api/riskbook?fresh=1');
  assert.equal(status, 200, body.error);
  const eth = body.pools.find(p => p.marginAsset === 'USDT').baseline.find(b => b.asset === 'ETH');
  assert.deepEqual([eth.noMark, eth.killUp, eth.killDown, eth.scannedUpPct], [true, null, null, null]);
});

test('a risk of 0 is floored rather than read as the default, and the riskbook no longer ships lot filters', async () => {
  const zero = (await get('/api/volstops?risk=0&k=1.5')).body;
  const tenth = (await get('/api/volstops?risk=0.001&k=1.5')).body;
  assert.deepEqual(zero.positions.map(p => p.dollarRisk), tenth.positions.map(p => p.dollarRisk));
  assert.ok((await get('/api/riskbook')).body.pools.every(p => !('filters' in p) && p.baseline.every(b => b.noMark === false)));
});

test('history sync fills the store and the journal reconciles every fill', async () => {
  await startSync();
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
  const clockFree = { ...body, walletCurve: body.walletCurve.slice(0, -1), account: { curve: body.account.curve },
    costs: { ...body.costs, makerTrend: null, ledger: { ...body.costs.ledger, at: null } },
    habits: body.habits.map(({ weekly, ...h }) => h),
    periods: Object.fromEntries(Object.entries(body.periods).map(([k, { from, previous, ...rest }]) => [k, rest])) };
  record('performance', clockFree);
});

test('performance counts a hedged pair once, compares with the window before, and buckets months by local time', async () => {
  const all = (await get('/api/performance')).body;
  assert.ok(all.units.units < all.units.legs, 'overlapping BTC legs are one unit');
  assert.equal(all.units.legs, all.overall.trips);
  assert.ok(all.account.series.every(r => ['wallet', 'account'].includes(r.source)));
  assert.equal(all.previous, null, 'all time has no window before it');
  assert.ok(all.side.every(b => ['Long', 'Short'].includes(b.label)));

  const recent = (await get('/api/performance?days=30')).body;
  assert.ok(recent.previous && recent.window.previous);
  assert.deepEqual(Object.keys(recent.previous).sort(), ['expectancy', 'legs', 'net', 'twr', 'units', 'winRate']);
  assert.ok(recent.habits.every(h => h.previous && h.weekly.length === 8));

  const trips = (await get('/api/trips')).body.trips;
  const ahead = (await get('/api/performance?tz=840')).body;
  const months = [...new Set(trips.map(t => new Date(t.closeTime + 840 * 60_000).toISOString().slice(0, 7)))].sort();
  assert.deepEqual(ahead.month.map(m => m.label), months);
});

test('costs follow the window and session, price BNB fees apart, and the ledger lists every income type with its checks', async () => {
  const all = (await get('/api/performance')).body.costs;
  const week = (await get('/api/performance?days=30')).body.costs;
  assert.ok(week.summary.trips < all.summary.trips && week.summary.traded < all.summary.traded, 'execution follows the window');
  assert.ok(week.previous, 'and is compared with the window before');
  assert.ok(all.summary.bnb.fee > 0 && all.summary.bnb.usd > 0, 'a fee paid in BNB is priced at that day\'s close');
  assert.ok(Math.abs(all.summary.bnb.usd - all.summary.bnb.fee * 600) / (all.summary.bnb.fee * 600) < 0.2);
  assert.equal(all.feeBurn, true);
  assert.deepEqual(all.feeCheck.rates.BTCUSDT, { makerBp: 2, takerBp: 5 });
  assert.ok(all.feeCheck.expectedBp >= 2 && all.feeCheck.expectedBp <= 5);
  assert.deepEqual(all.ledger.other, [{ type: 'COMMISSION_REBATE', amount: 0.3 }]);
  assert.deepEqual(all.ledger.checks.map(c => c.id), ['start', 'realised', 'fees', 'funding']);
  assert.ok(all.ledger.checks.find(c => c.id === 'funding').rows > 0, 'funding on symbols the fills never held is counted');
  assert.ok(all.weekly.length > 0 && all.weekly.every(w => w.fees >= 0 && w.paid <= 0 && w.received >= 0));
});

test('timing buckets follow the reader\'s time zone through daylight saving, and an unknown zone falls back to the offset', async () => {
  const hours = async q => (await get(`/api/performance?${q}`)).body.timing.hour.rows.map(r => r.units);
  const fixed = await hours('tz=60');
  const madrid = await hours('tz=60&zone=Europe%2FMadrid');
  assert.notDeepEqual(madrid, fixed, 'the fake book trades in summer, when Madrid is two hours ahead');
  assert.deepEqual(madrid, await hours('tz=120'));
  assert.deepEqual(await hours('tz=60&zone=Mars%2FOlympus'), fixed);
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
  const clockFree = periods => Object.fromEntries(Object.entries(periods).map(([k, { previous: { to, ...prev }, ...rest }]) => [k, { ...rest, prev }]));
  assert.deepEqual(clockFree(one.periods), clockFree(all.periods), 'the overview is the whole account');
  assert.deepEqual(one.recentTrips, all.recentTrips, 'recent trades are the whole account too');
  assert.deepEqual([all.account.curve, one.account.curve], ['account', 'trips'], 'a session curve is its trips, not the account');
  assert.equal(one.account.series.reduce((s, d) => s + d.pnl, 0).toFixed(2), one.overall.net.toFixed(2));
  assert.ok(one.records.units <= all.records.units && one.costs.summary.fees <= all.costs.summary.fees);
  assert.ok(one.habits.every((h, i) => h.outOf <= all.habits[i].outOf));
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
    assert.ok(t.openNotional > 0 && ['Long', 'Short'].includes(t.side));
  }
  assert.ok(body.trips.some(t => t.side === 'Short'), 'the fake book hedges BTC inside some long trips');
  const covered = body.trips.filter(t => t.funding != null);
  assert.ok(covered.every(t => t.openTime >= body.coverage.incomeFrom));
  assert.ok(body.trips.some(t => t.funding == null), 'trips before the ledger starts have unknown funding');
  const eth = covered.filter(t => t.symbol === 'ETHUSDT' && t.funding !== 0);
  assert.ok(eth.length > 0 && eth.every(t => Math.abs(t.funding - -0.8) < 1e-9 && !t.fundingSplit));
  record('trips', body);

  const mark = fake.calls.length;
  await startSync();
  for (let i = 0; i < 100 && (await get('/api/history/sync')).body.state.running; i++) {
    await new Promise(r => setTimeout(r, 20));
  }
  assert.deepEqual(fake.calls.slice(mark).filter(c => c === '/fapi/v1/klines'), []);
});

test('a routine sync pulls fills only for symbols the ledger shows trading since their last pull', async () => {
  const { symbolsToSync } = await import('../lib/history-sync.js');
  const meta = JSON.parse(fs.readFileSync(path.join(process.env.DASHBOARD_DATA_DIR, 'meta.json'), 'utf8'));
  assert.ok(Object.values(meta.tradesSyncedAt).every(t => t > 0));
  assert.deepEqual(symbolsToSync(meta).due, [], 'every trade in the ledger is older than its pull');
  assert.deepEqual(symbolsToSync({ ...meta, tradesSyncedAt: { ...meta.tradesSyncedAt, BTCUSDT: 0 } }).due, ['BTCUSDT']);
  assert.ok(symbolsToSync({ ...meta, tradesSyncedAt: {} }).due.includes('SOLUSDT'), 'a symbol never pulled is due, even with only funding in the ledger');
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

test('a sync starts only from a JSON POST, and a request for another host is refused', async () => {
  const before = (await get('/api/history/sync')).body.state.startedAt;
  assert.equal((await get('/api/history/sync?start=true&full=true')).body.state.startedAt, before, 'a GET never starts one');
  assert.equal((await get('/api/history/sync', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);

  const port = new URL(base).port;
  const hostStatus = host => new Promise((resolve, reject) => {
    http.request({ host: '127.0.0.1', port, path: '/api/health', headers: { Host: host } }, res => { res.resume(); resolve(res.statusCode); })
      .on('error', reject).end();
  });
  assert.deepEqual(await Promise.all(['localhost:3000', '127.0.0.1', '[::1]:3000', 'evil.example', 'evil.example:3000'].map(hostStatus)),
                   [200, 200, 200, 403, 403]);
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

test('goals refuse inherited action names and never overwrite a file they cannot read', async () => {
  const file = path.join(process.env.DASHBOARD_DATA_DIR, 'goals.json');
  await postGoal({ action: 'add', type: 'maxTradesPerDay', params: { max: 3 } });
  for (const action of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    assert.equal((await postGoal({ action })).status, 400, action);
  }
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).length, 1);

  const kept = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, '[{"id": "x"');
  const read = await get('/api/goals');
  assert.deepEqual([read.status, /unreadable, left untouched/.test(read.body.error)], [500, true]);
  assert.equal((await postGoal({ action: 'add', type: 'maxTradesPerDay', params: { max: 3 } })).status, 500);
  assert.equal(fs.readFileSync(file, 'utf8'), '[{"id": "x"');
  fs.writeFileSync(file, kept);
  await postGoal({ action: 'delete', id: JSON.parse(kept)[0].id });
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

test('factors compare buckets with intervals, cache the result, and drop the session factors under a session filter', async () => {
  const { status, body } = await get('/api/factors?tz=0');
  assert.equal(status, 200);
  assert.equal(body.trips, (await get('/api/trips')).body.trips.length);
  assert.ok(Array.isArray(body.factors) && Array.isArray(body.during));
  for (const b of body.factors.flatMap(f => f.buckets)) assert.ok(b.ci.lo <= b.diff && b.diff <= b.ci.hi, `${b.bucket} interval`);
  const again = await get('/api/factors?tz=0');
  assert.deepEqual(again.body, body);
  const europe = (await get('/api/factors?session=Europe')).body;
  assert.equal(europe.session, 'Europe');
  assert.ok(!europe.factors.some(f => f.id === 'session' || f.id === 'weekend'));
  record('factors', body);
});

test('funding nets hedged pairs, ranks worst first, reads realised from the ledger, and caches rate history for an hour', async () => {
  const before = fake.calls.filter(c => c === '/fapi/v1/fundingRate').length;
  const { status, body } = await get('/api/funding');
  assert.equal(status, 200);
  const fetched = fake.calls.filter(c => c === '/fapi/v1/fundingRate').length - before;
  assert.ok(fetched > 0, 'history read per held symbol');
  const pair = body.rows.find(r => r.pair);
  assert.ok(pair && pair.symbol === 'BTCUSDT', 'the BTC long and short are one row');
  assert.ok(Math.abs(pair.perDay - (pair.long.perDay + pair.short.perDay)) < 1e-6);
  assert.deepEqual(body.rows.map(r => r.perDay), [...body.rows.map(r => r.perDay)].sort((a, b) => a - b));
  const eth = body.rows.find(r => r.symbol === 'ETHUSDT');
  assert.equal(eth.intervalHours, 4);
  assert.ok(Math.abs(eth.aprPct - 0.02 * 6 * 365) < 0.01);
  assert.ok(Math.abs(body.totals.perDay - body.rows.reduce((s, r) => s + r.perDay, 0)) < 1e-3);
  assert.equal(typeof body.realised.d7, 'number');
  await get('/api/funding');
  assert.equal(fake.calls.filter(c => c === '/fapi/v1/fundingRate').length - before, fetched, 'second read is cached');
  record('funding', { totals: body.totals, rows: body.rows.map(({ symbol, pair, perDay, aprPct, nearCap }) => ({ symbol, pair, perDay, aprPct, nearCap })) });
});

test('route output matches the golden snapshot', () => {
  if (process.env.UPDATE_GOLDEN || (!fs.existsSync(GOLDEN) && !process.env.CI)) {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, JSON.stringify(snapshot, null, 1) + '\n');
    return;
  }
  assert.ok(fs.existsSync(GOLDEN), 'the golden snapshot is missing; record it with UPDATE_GOLDEN=1');
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  assert.deepEqual(Object.keys(snapshot).sort(), Object.keys(golden).sort(), 'every recorded route has a golden entry, and no more');
  for (const name of Object.keys(golden)) assert.deepEqual(snapshot[name], golden[name], `${name} drifted from golden`);
});

test('a 418 pauses every Binance call until Retry-After passes', async () => {
  fake.ban(0.15);
  const first = await get('/api/confluence?symbol=SOLUSDT&tfs=1h');
  assert.equal(first.body.timeframes?.['1h'] ?? null, null);
  const before = fake.calls.length;
  const second = await get('/api/riskbook?fresh=1');
  assert.equal(second.status, 500);
  assert.match(second.body.error, /paused/);
  assert.equal(fake.calls.filter(c => !c.startsWith('hl:')).length, fake.calls.slice(0, before).filter(c => !c.startsWith('hl:')).length);
  await new Promise(r => setTimeout(r, 200));
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
  assert.equal(body.habits.length, 6);
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
  const refusals = { riskbook: await get('/api/riskbook'), deleverage: await get('/api/deleverage'),
                     hedgeledger: await get('/api/hedgeledger'), sync: await startSync() };
  for (const [route, { status, body }] of Object.entries(refusals)) assert.deepEqual([status, body.disabled], [409, true], route);
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

const postNote = (body, type = 'application/json') =>
  get('/api/annotations', { method: 'POST', headers: { 'Content-Type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('a note and tags on a trip save, come back on /api/trips, and reach Factors and Goals', async () => {
  const [first] = (await get('/api/trips')).body.trips;
  assert.deepEqual([first.note, first.tags], [null, []]);
  assert.equal((await postNote({ key: first.key, note: 'chased the move', tags: ['Revenge'] })).status, 200);
  const saved = (await get('/api/trips')).body.trips.find(t => t.key === first.key);
  assert.deepEqual([saved.note, saved.tags], ['chased the move', ['revenge']]);
  assert.ok((await get('/api/factors?tz=0')).body.tags, 'factors carry the tags section');

  assert.equal((await postNote('key=x', 'application/x-www-form-urlencoded')).status, 415);
  assert.equal((await postNote('{"key":')).status, 400);
  assert.equal((await postNote({ key: 'NOPE:LONG:1', note: 'x' })).status, 404);
  assert.equal((await postNote({ key: first.key, tags: ['<b>'] })).status, 400);
  assert.equal((await postNote({ key: first.key, note: '', tags: [] })).status, 200);
  assert.equal((await get('/api/trips')).body.trips.find(t => t.key === first.key).note, null);
});

const syncHistory = async () => {
  await startSync();
  for (let i = 0; i < 200 && (await get('/api/history/sync')).body.state.running; i++) await new Promise(r => setTimeout(r, 20));
};

test('both legs of a hedged funding settlement are kept, though Binance books them under one tranId', async () => {
  const dir = process.env.DASHBOARD_DATA_DIR;
  const solFunding = () => fs.readFileSync(path.join(dir, 'income.ndjson'), 'utf8').trim().split('\n').map(JSON.parse)
    .filter(r => r.symbol === 'SOLUSDT' && r.incomeType === 'FUNDING_FEE');
  assert.equal(solFunding().length, 60, 'a paying and a receiving row for each of 30 settlements');
  const perf = (await get('/api/performance')).body;
  assert.ok(Math.abs(perf.costs.ledger.funding - (30 * -0.8 + 30 * -0.1)) < 1e-6, `funding ${perf.costs.ledger.funding}`);

  const metaFile = path.join(dir, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  assert.equal(meta.incomeKeyVersion, 2);
  const incomeFile = path.join(dir, 'income.ndjson');
  const damaged = fs.readFileSync(incomeFile, 'utf8').trim().split('\n').filter(l => !(l.includes('SOLUSDT') && l.includes('"2.4"')));
  fs.writeFileSync(incomeFile, damaged.join('\n') + '\n');
  delete meta.incomeKeyVersion;
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  await syncHistory();
  assert.equal(solFunding().length, 60, 'a cache written under the old key is repaired on the next sync');
  const repaired = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  assert.equal(repaired.incomeKeyVersion, 2);
  assert.ok(repaired.incomeCompleteFrom > 0);
  assert.equal((await get('/api/trips')).body.coverage.incomeCompleteFrom, repaired.incomeCompleteFrom);
});

test('open orders are read by REST even when the order stream cannot open (last: it marks the stream as started)', async () => {
  const stream = await import('../lib/orders-stream.js');
  fake.fail('/fapi/v1/listenKey');
  await stream.startBinanceUserDataStream();
  for (let i = 0; i < 100 && stream.lastReconcile.reason !== 'start'; i++) await new Promise(r => setTimeout(r, 10));
  fake.heal();
  stream.stopBinanceUserDataStream();
  assert.equal(stream.lastReconcile.reason, 'start');
  await stream.reconcileOrders('test');
});
