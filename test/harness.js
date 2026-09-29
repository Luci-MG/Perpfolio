// harness.js — boots the real app against the fake exchange on an ephemeral port (test only)

import fs from 'fs';
import os from 'os';
import path from 'path';
import { installFakeExchange } from './fake-exchange.js';

export async function startTestServer() {
  process.env.BINANCE_API_KEY = 'test-key';
  process.env.BINANCE_API_SECRET = 'test-secret';
  process.env.HL_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
  process.env.DASHBOARD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-data-'));

  const fake = installFakeExchange();
  const { app, reconcileOrders } = await import('../server.js');
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  await reconcileOrders('test');

  const get = async (route, opts) => {
    const res = await fetch(base + route, opts);
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : await res.text() };
  };

  const stop = () => {
    server.close();
    fake.restore();
    fs.rmSync(process.env.DASHBOARD_DATA_DIR, { recursive: true, force: true });
  };

  return { base, get, fake, stop };
}
