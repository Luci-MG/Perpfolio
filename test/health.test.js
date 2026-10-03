import test from 'node:test';
import assert from 'node:assert/strict';
import { assessHealth } from '../lib/health.js';

const NOW = 1_000_000;
const healthy = () => ({
  rate: { usedWeight1m: 200, weightLimit: 2400, weightCeiling: 1800, pausedUntil: null, pauseReason: null },
  feed: { connected: true, lastMessageAgeSec: 30, lastReconcile: { at: NOW - 1000, added: 0, removed: 0 } },
  snapshots: { binance: 2000, hyperliquid: 3000 },
  sync: { phase: 'done', error: null },
  now: NOW
});

test('a healthy server is ok with no reasons', () => {
  assert.deepEqual(assessHealth(healthy()), { level: 'ok', reasons: [] });
});

test('a ban is bad and says how long is left', () => {
  const s = healthy();
  s.rate.pausedUntil = NOW + 45_000;
  s.rate.pauseReason = '418 on /fapi/v2/account';
  const h = assessHealth(s);
  assert.equal(h.level, 'bad');
  assert.match(h.reasons[0].text, /418 on \/fapi\/v2\/account — 45s left/);
});

test('request weight warns at half the budget and is bad at the sync ceiling', () => {
  const s = healthy();
  s.rate.usedWeight1m = 1300;
  assert.equal(assessHealth(s).level, 'warn');
  s.rate.usedWeight1m = 1800;
  assert.equal(assessHealth(s).level, 'bad');
});

test('stream, drift, stale snapshots and a failed sync warn; the worst level wins', () => {
  const s = healthy();
  s.feed.connected = false;
  s.feed.lastReconcile.added = 2;
  s.snapshots.binance = 180_000;
  s.sync = { phase: 'failed', error: 'timeout' };
  const h = assessHealth(s);
  assert.equal(h.level, 'warn');
  assert.equal(h.reasons.length, 4);
  s.rate.pausedUntil = NOW + 1000;
  assert.equal(assessHealth(s).level, 'bad');
});

test('with Binance off or no API key the order stream is not expected', () => {
  const s = healthy();
  s.feed.connected = false;
  assert.equal(assessHealth({ ...s, streamExpected: false }).level, 'ok');
});

test('open orders unread, or not refreshed for three minutes, warn whatever the stream says', () => {
  const s = healthy();
  s.feed.lastReconcile = { at: null, added: 0, removed: 0 };
  assert.deepEqual(assessHealth(s).reasons.map(r => r.text), ['open orders not read yet']);
  s.feed.lastReconcile.at = NOW - 4 * 60_000;
  assert.deepEqual(assessHealth(s).reasons.map(r => r.text), ['open orders not refreshed for 4m']);
});
