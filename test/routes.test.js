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
  record('performance', body);
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
