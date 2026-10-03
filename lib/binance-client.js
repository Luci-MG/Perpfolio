// binance-client.js — every HTTP call to Binance goes through here: signing, the used-weight
// header, the server-time offset, and the ban guard that pauses all calls after a 418, 429 or 403.

import crypto from 'crypto';
import { BINANCE_API_KEY, BINANCE_API_SECRET, BINANCE_BASE, FETCH_TIMEOUT_MS } from './config.js';
import { once, sleep } from './util.js';
import { assertVenueEnabled } from './venues.js';

// Reported by every response; the history sync pauses on it rather than discovering the limit
// by being rate-limited. It describes the current minute only, so a reading a minute old is 0.
let usedWeight1m = 0;
let usedWeightAt = 0;
const WEIGHT_CEILING = 1800;   // of 2400/min
const WEIGHT_WINDOW_MS = 60_000;
const currentWeight = () => (Date.now() - usedWeightAt < WEIGHT_WINDOW_MS ? usedWeight1m : 0);

// A 418 is an IP ban that grows if requests keep arriving, a 429 is the warning before it, and
// a 403 is the web application firewall's limit. Every Binance call, signed or public, goes quiet
// until the exchange's Retry-After has passed instead of discovering the limit again on each poll.
let bnBannedUntil = 0;
let bnBanReason = null;
const PAUSING = new Set([403, 418, 429]);

// Signed calls are rejected (-1021) once the local clock drifts past recvWindow, so the
// timestamp carries Binance's own time, re-read hourly.
const RECV_WINDOW_MS = 10_000;
const TIME_REFRESH_MS = 3_600_000;
let timeOffsetMs = 0;
let timeOffsetAt = 0;

function noteBinanceResponse(res, endpoint) {
  const weight = res.headers.get('x-mbx-used-weight-1m');
  if (weight) { usedWeight1m = parseInt(weight, 10); usedWeightAt = Date.now(); }
  if (!PAUSING.has(res.status)) return;
  const retrySec = parseFloat(res.headers.get('Retry-After') || '');
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
  return { usedWeight1m: currentWeight(), weightLimit: 2400, weightCeiling: WEIGHT_CEILING,
           pausedUntil: paused ? bnBannedUntil : null, pauseReason: paused ? bnBanReason : null };
}

async function failure(res, endpoint) {
  const body = await res.json().catch(() => null);
  const detail = body?.code != null ? ` (${body.code}${body.msg ? `: ${body.msg}` : ''})` : '';
  if (res.status === 418) return new Error(`Binance IP banned (418) on ${endpoint} — all Binance calls paused`);
  if (PAUSING.has(res.status)) return new Error(`Binance ${endpoint} rate-limited (${res.status}) — all Binance calls paused${detail}`);
  return new Error(`Binance ${endpoint} → ${res.status}${detail}`);
}

export async function bnPublic(pathAndQuery) {
  const endpoint = pathAndQuery.split('?')[0];
  assertNotBanned(endpoint);
  const res = await fetch(`${BINANCE_BASE}${pathAndQuery}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  noteBinanceResponse(res, endpoint);
  if (!res.ok) throw await failure(res, endpoint);
  return res.json();
}

/** A call that needs the API key but no signature (the user-data listenKey), behind the same ban guard, timeout and weight reading. */
export async function binanceKeyed(endpoint, method) {
  assertNotBanned(endpoint);
  const res = await fetch(`${BINANCE_BASE}${endpoint}`, {
    method, headers: { 'X-MBX-APIKEY': BINANCE_API_KEY }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  noteBinanceResponse(res, endpoint);
  if (!res.ok) throw await failure(res, endpoint);
  return res.json();
}

export async function throttleWeight() {
  if (currentWeight() < WEIGHT_CEILING) return;
  console.warn(`[sync] used weight ${currentWeight()} — pausing 20s`);
  await sleep(20_000);
  usedWeight1m = 0;
}

async function syncServerTime() {
  try {
    const { serverTime } = await bnPublic('/fapi/v1/time');
    if (Number.isFinite(serverTime)) { timeOffsetMs = serverTime - Date.now(); timeOffsetAt = Date.now(); }
  } catch (err) {
    console.warn('[time] server time unavailable, signing with the local clock:', err.message);
  }
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
  if (Date.now() - timeOffsetAt > TIME_REFRESH_MS) await once('serverTime', syncServerTime);
  const qs = binanceSign({ ...params, recvWindow: RECV_WINDOW_MS, timestamp: Date.now() + timeOffsetMs });
  const res = await fetch(`${BINANCE_BASE}${endpoint}?${qs}`, {
    method, headers: { 'X-MBX-APIKEY': BINANCE_API_KEY }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  noteBinanceResponse(res, endpoint);
  if (res.ok) return res.json();
  throw await failure(res, endpoint);
}
