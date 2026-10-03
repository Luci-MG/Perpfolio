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

test('trips carry context from the sync, funding from the ledger, and a re-sync fetches nothing', async () => {
  const { status, body } = await get('/api/trips');
  assert.equal(status, 200);
  assert.ok(body.trips.length > 0);
  assert.equal(body.coverage.pending, 0);
  assert.equal(body.coverage.ready, body.trips.length);
  for (const t of body.trips) {
    assert.ok(t.mae <= 0 && t.mfe >= 0, `${t.key} mae ${t.mae} mfe ${t.mfe}`);
    assert.ok(Number.isFinite(t.atrPct) && ['up', 'down', 'flat'].includes(t.btcTrend), t.key);
    assert.ok(['Asia', 'Europe', 'US'].includes(t.session));
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
  assert.deepEqual(joined.yourStop, { price: 90000, distancePct: +((trip.avgEntry - 90000) / trip.avgEntry * 100).toFixed(3) });
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
