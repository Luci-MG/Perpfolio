// binance-client.js — every HTTP call to Binance goes through here: signing, the used-weight
// header, and the ban guard that pauses all calls after a 418 or 429.

import crypto from 'crypto';
import { BINANCE_API_KEY, BINANCE_API_SECRET, BINANCE_BASE, FETCH_TIMEOUT_MS } from './config.js';
import { sleep } from './util.js';
import { assertVenueEnabled } from './venues.js';

// Reported by every signed response; the history sync pauses on it rather than discovering
// the limit by being rate-limited.
let usedWeight1m = 0;
const WEIGHT_CEILING = 1800;   // of 2400/min

// A 418 is an IP ban that grows if requests keep arriving, and a 429 is the warning before
// it. Every Binance call, signed or public, goes quiet until the exchange's Retry-After has
// passed instead of discovering the ban again on each poll.
let bnBannedUntil = 0;
let bnBanReason = null;

function noteBinanceResponse(res, endpoint) {
  const weight = res.headers.get('x-mbx-used-weight-1m');
  if (weight) usedWeight1m = parseInt(weight, 10);
  if (res.status !== 418 && res.status !== 429) return;
  const retrySec = parseInt(res.headers.get('Retry-After') || '', 10);
  const waitMs = Number.isFinite(retrySec) ? retrySec * 1000 : res.status === 418 ? 120_000 : 60_000;
  bnBannedUntil = Math.max(bnBannedUntil, Date.now() + waitMs);
  bnBanReason = `${res.status} on ${endpoint}`;
  console.error(`[rate-limit] Binance ${bnBanReason} — pausing all Binance calls for ${Math.round(waitMs / 1000)}s`);
}

function assertNotBanned(endpoint) {
  if (Date.now() < bnBannedUntil) {
    throw new Error(`Binance paused after ${bnBanReason} — ${Math.ceil((bnBannedUntil - Date.now()) / 1000)}s left (${endpoint} skipped)`);
  }
}

export function getRateState() {
  const paused = Date.now() < bnBannedUntil;
  return { usedWeight1m, weightLimit: 2400, weightCeiling: WEIGHT_CEILING,
           pausedUntil: paused ? bnBannedUntil : null, pauseReason: paused ? bnBanReason : null };
}

export async function bnPublic(pathAndQuery) {
  const endpoint = pathAndQuery.split('?')[0];
  assertNotBanned(endpoint);
  const res = await fetch(`${BINANCE_BASE}${pathAndQuery}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  noteBinanceResponse(res, endpoint);
  if (!res.ok) throw new Error(`${endpoint} → ${res.status}`);
  return res.json();
}

export async function throttleWeight() {
  if (usedWeight1m < WEIGHT_CEILING) return;
  console.warn(`[sync] used weight ${usedWeight1m} — pausing 20s`);
  await sleep(20_000);
  usedWeight1m = 0;
}

// USDM futures symbols are base+quote with no separator. The quote asset is also the
// collateral asset, and in single-asset margin mode each collateral asset is its own
// cross pool — so this split decides pool membership, not just labels.
const BN_QUOTES = ['USDT', 'USDC', 'FDUSD', 'BUSD'];

export function splitSymbol(symbol) {
  const quote = BN_QUOTES.find(q => symbol.endsWith(q)) || 'USDT';
  return { base: symbol.slice(0, -quote.length) || symbol, quote };
}

function binanceSign(params) {
  const query = new URLSearchParams(params).toString();
  const sig = crypto.createHmac('sha256', BINANCE_API_SECRET).update(query).digest('hex');
  return `${query}&signature=${sig}`;
}

export async function binanceFetch(endpoint, params = {}, method = 'GET') {
  assertVenueEnabled('binance', endpoint);
  assertNotBanned(endpoint);
  const qs = binanceSign({ ...params, timestamp: Date.now() });
  const res = await fetch(`${BINANCE_BASE}${endpoint}?${qs}`, {
    method, headers: { 'X-MBX-APIKEY': BINANCE_API_KEY }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  noteBinanceResponse(res, endpoint);
  if (res.ok) return res.json();
  // 418 and 429 have already paused every Binance call; retrying either one lengthens a ban.
  if (res.status === 418) throw new Error(`Binance IP banned (418) on ${endpoint} — all Binance calls paused`);
  if (res.status === 429) throw new Error(`Binance ${endpoint} rate-limited (429) — all Binance calls paused`);
  throw new Error(`Binance ${endpoint} → ${res.status}`);
}
