import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './harness.js';

// A server of its own, so the exchange tables start empty and each fallback is reached cold.
const { get, fake, stop } = await startTestServer();
test.after(stop);

test('without the bracket table, margin is inferred from what Binance reports and still matches it, marked estimated', async () => {
  fake.fail('/fapi/v1/leverageBracket');
  fake.fail('/fapi/v1/commissionRate');
  const { status, body } = await get('/api/riskbook?fresh=1');
  fake.heal();
  assert.equal(status, 200);
  for (const P of body.pools) {
    assert.equal(P.calibration.estimatedBrackets, true);
    for (const p of P.calibration.perPosition) assert.ok(Math.abs(p.modelMm - p.reportedMm) < 1e-6, p.key);
  }
});

test('a commission rate that failed to load is assumed for that request only, and read again next time', async () => {
  fake.fail('/fapi/v1/commissionRate');
  const feesOf = async () => (await get('/api/riskbook?fresh=1')).body.pools.flatMap(P => Object.values(P.fees));
  const assumed = await feesOf();
  fake.heal();
  assert.ok(assumed.every(f => f.assumed));
  assert.ok((await feesOf()).every(f => !f.assumed && f.taker === 0.0005), 'nothing about the failure was cached');
});

test('a Hyperliquid 429 is waited out and retried, not shown as an error', async () => {
  const before = fake.calls.filter(c => c === 'hl:clearinghouseState').length;
  fake.fail('hl:clearinghouseState', 429, { times: 1, headers: { 'Retry-After': '0' } });
  const { status, body } = await get('/api/dashboard?fresh=1');
  assert.equal(status, 200);
  assert.deepEqual(body.summary.partial, []);
  assert.equal(fake.calls.filter(c => c === 'hl:clearinghouseState').length - before, 2);
});

test('open tabs polling together share one account read', async () => {
  const before = fake.calls.filter(c => c === '/fapi/v2/account').length;
  fake.delay('/fapi/v2/account', 100);
  await Promise.all([1, 2, 3].map(() => get('/api/dashboard?fresh=1')));
  fake.heal();
  assert.equal(fake.calls.filter(c => c === '/fapi/v2/account').length - before, 1);
});
