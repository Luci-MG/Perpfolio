import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.BINANCE_API_KEY = 'test-key';
process.env.BINANCE_API_SECRET = 'test-secret';
process.env.DASHBOARD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-client-'));
const client = await import('../lib/binance-client.js');
test.after(() => fs.rmSync(process.env.DASHBOARD_DATA_DIR, { recursive: true, force: true }));

const requests = [];
let reply = () => ({ status: 200, body: {} });
globalThis.fetch = async url => {
  requests.push(new URL(url));
  const { status, body, headers = {} } = reply(new URL(url));
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
};

test('signed calls carry a receive window and Binance\'s own time', async () => {
  reply = url => (url.pathname === '/fapi/v1/time' ? { status: 200, body: { serverTime: Date.now() + 5_000 } } : { status: 200, body: {} });
  await client.binanceFetch('/fapi/v2/account');
  const signed = requests.at(-1).searchParams;
  assert.equal(signed.get('recvWindow'), '10000');
  assert.ok(Math.abs(Number(signed.get('timestamp')) - (Date.now() + 5_000)) < 1_000, 'stamped on the server clock');
  assert.ok(signed.has('signature'));
});

test('a listenKey call is keyed but never signed', async () => {
  reply = () => ({ status: 200, body: {} });
  await client.binanceKeyed('/fapi/v1/listenKey', 'PUT');
  assert.equal(requests.at(-1).search, '');
});

test('an error says what Binance said', async () => {
  reply = () => ({ status: 400, body: { code: -1021, msg: 'Timestamp outside of the recvWindow.' } });
  await assert.rejects(client.binanceFetch('/fapi/v2/account'), /→ 400 \(-1021: Timestamp outside of the recvWindow\.\)/);
});

test('the used-weight reading lasts its minute and no longer', async t => {
  reply = () => ({ status: 200, body: [], headers: { 'x-mbx-used-weight-1m': '1900' } });
  await client.bnPublic('/fapi/v1/premiumIndex');
  assert.equal(client.getRateState().usedWeight1m, 1900);
  const later = Date.now() + 61_000;
  t.mock.method(Date, 'now', () => later);
  assert.equal(client.getRateState().usedWeight1m, 0);
});

test('a 403 from the firewall pauses every call, like a 429', async () => {
  reply = () => ({ status: 403, body: {}, headers: { 'Retry-After': '30' } });
  await assert.rejects(client.bnPublic('/fapi/v1/premiumIndex'), /rate-limited \(403\)/);
  const before = requests.length;
  await assert.rejects(client.bnPublic('/fapi/v1/exchangeInfo'), /paused after 403/);
  assert.equal(requests.length, before, 'no request was sent while paused');
});
