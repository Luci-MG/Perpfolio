// market-data.js — 1h candles for Binance and Hyperliquid, cached and merged so history grows
// while the server runs.

import { bnPublic } from './binance-client.js';
import { hlFetch } from './hyperliquid.js';
import { once } from './util.js';

// ── Candle fetching + cache (for Dynamic Stop Width) ──────────────────────
// In-memory cache keyed by `${exchange}:${symbol}`. Candles are normalised to
// { open, high, low, close, volume } oldest→newest. TTL-fresh entries are reused;
// stale entries are refreshed but the fetcher MERGES new candles into the cached
// series so history grows across runtime (improves BBW percentile + regime bands).
const CANDLE_TTL_MS = 60 * 1000;
const MAX_CANDLE_HISTORY = 720;          // ~30 days of 1h candles
const candleCache = {};                  // key → { candles, ts }
const VOL_INTERVAL = '1h';
const VOL_LIMIT = 200;

function mergeCandles(prev, fresh) {
  if (!prev?.length) return fresh.slice(-MAX_CANDLE_HISTORY);
  if (!fresh?.length) return prev;
  // Candles carry an openTime `t`; dedupe + append by openTime.
  const byTime = new Map();
  for (const c of prev) byTime.set(c.t, c);
  for (const c of fresh) byTime.set(c.t, c);
  const merged = [...byTime.values()].sort((a, b) => a.t - b.t);
  return merged.slice(-MAX_CANDLE_HISTORY);
}

export function getBinanceKlines(symbol) {
  const key = `binance:${symbol}`;
  const cached = candleCache[key];
  if (cached && Date.now() - cached.ts < CANDLE_TTL_MS) return Promise.resolve(cached.candles);
  return once(key, () => fetchBinanceKlines(symbol, key));
}

async function fetchBinanceKlines(symbol, key) {
  const cached = candleCache[key];
  try {
    const raw = await bnPublic(`/fapi/v1/klines?symbol=${symbol}&interval=${VOL_INTERVAL}&limit=${VOL_LIMIT}`);
    const fresh = (Array.isArray(raw) ? raw : []).map(k => ({
      t:      k[0],
      open:   parseFloat(k[1]),
      high:   parseFloat(k[2]),
      low:    parseFloat(k[3]),
      close:  parseFloat(k[4]),
      volume: parseFloat(k[5])
    }));
    const candles = mergeCandles(cached?.candles, fresh);
    candleCache[key] = { candles, ts: Date.now() };
    return candles;
  } catch (err) {
    console.warn(`[vol] Binance klines ${symbol} failed: ${err.message}`);
    return cached?.candles || null;   // serve stale if we have it, else null → backfill
  }
}

export function getHlCandles(coin) {
  const key = `hl:${coin}`;
  const cached = candleCache[key];
  if (cached && Date.now() - cached.ts < CANDLE_TTL_MS) return Promise.resolve(cached.candles);
  return once(key, () => fetchHlCandles(coin, key));
}

async function fetchHlCandles(coin, key) {
  const cached = candleCache[key];
  try {
    const endTime = Date.now();
    const startTime = endTime - VOL_LIMIT * 60 * 60 * 1000;  // VOL_LIMIT hours back
    const raw = await hlFetch({
      type: 'candleSnapshot',
      req: { coin, interval: VOL_INTERVAL, startTime, endTime }
    });
    const fresh = (Array.isArray(raw) ? raw : []).map(c => ({
      t:      c.t,
      open:   parseFloat(c.o),
      high:   parseFloat(c.h),
      low:    parseFloat(c.l),
      close:  parseFloat(c.c),
      volume: parseFloat(c.v)
    }));
    const candles = mergeCandles(cached?.candles, fresh);
    candleCache[key] = { candles, ts: Date.now() };
    return candles;
  } catch (err) {
    console.warn(`[vol] HL candles ${coin} failed: ${err.message}`);
    return cached?.candles || null;
  }
}
