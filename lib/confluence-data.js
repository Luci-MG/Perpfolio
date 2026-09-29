// confluence-data.js — klines on any timeframe and the public positioning series behind the
// Confluence tab, each briefly cached.

import { bnPublic } from './binance-client.js';
import { symbolFilters } from './binance-meta.js';
import { once } from './util.js';

// ── Confluence ────────────────────────────────────────────────────────────
// Klines on any timeframe with taker-buy volume, and the public positioning series, each
// briefly cached. Only closed bars are scored; the forming bar is returned alongside.
const CF_TTL_MS = { '15m': 60e3, '1h': 120e3, '4h': 300e3, '1d': 600e3 };
const CF_KLINE_LIMIT = 1000;
const cfKlineCache = {};
const publicCache = {};

export function getKlinesTf(symbol, interval) {
  const key = `${symbol}:${interval}`;
  const hit = cfKlineCache[key];
  if (hit && Date.now() - hit.ts < CF_TTL_MS[interval]) return Promise.resolve(hit.data);
  return once(`cf:${key}`, () => fetchKlinesTf(symbol, interval, key));
}

async function fetchKlinesTf(symbol, interval, key) {
  const hit = cfKlineCache[key];
  try {
    const raw = await bnPublic(`/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${CF_KLINE_LIMIT}`);
    const rows = (Array.isArray(raw) ? raw : []).map(k => ({
      t: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: k[6],
      takerBuy: parseFloat(k[9])
    }));
    const now = Date.now();
    const data = { candles: rows.filter(k => k.closeTime < now), live: rows.find(k => k.closeTime >= now) || null };
    cfKlineCache[key] = { data, ts: now };
    return data;
  } catch (err) {
    console.warn(`[confluence] ${err.message}`);
    return hit?.data || null;
  }
}

export function publicGet(pathname, params, ttlMs) {
  const url = `${pathname}?${new URLSearchParams(params)}`;
  const hit = publicCache[url];
  if (hit && Date.now() - hit.ts < ttlMs) return Promise.resolve(hit.data);
  return once(`pub:${url}`, () => fetchPublic(url, pathname));
}

async function fetchPublic(url, pathname) {
  const hit = publicCache[url];
  try {
    const data = await bnPublic(url);
    if (!Array.isArray(data)) throw new Error(`${pathname} → unexpected payload`);
    publicCache[url] = { data, ts: Date.now() };
    return data;
  } catch (err) {
    console.warn(`[confluence] ${err.message}`);
    return hit?.data || null;
  }
}

export const rowsOf = (data, tKey, vKey) =>
  (data || []).map(r => ({ t: Number(r[tKey]), v: parseFloat(r[vKey]) })).filter(r => Number.isFinite(r.v));

export async function positioningSeries(symbol, period) {
  const ttl = CF_TTL_MS[period];
  const [oi, top, global, basis] = await Promise.all([
    publicGet('/futures/data/openInterestHist', { symbol, period, limit: 500 }, ttl),
    publicGet('/futures/data/topLongShortPositionRatio', { symbol, period, limit: 500 }, ttl),
    publicGet('/futures/data/globalLongShortAccountRatio', { symbol, period, limit: 500 }, ttl),
    publicGet('/futures/data/basis', { pair: symbol, contractType: 'PERPETUAL', period, limit: 500 }, ttl)
  ]);
  return {
    oi: rowsOf(oi, 'timestamp', 'sumOpenInterest'),
    topLS: rowsOf(top, 'timestamp', 'longShortRatio'),
    globalLS: rowsOf(global, 'timestamp', 'longShortRatio'),
    basis: rowsOf(basis, 'timestamp', 'basisRate')
  };
}

export const CF_INFORMATIONAL = { '1d': ['leverage', 'positioning'] };

export function perpSymbols() {
  return Object.entries(symbolFilters)
    .filter(([, f]) => f.contractType === 'PERPETUAL' && f.status === 'TRADING')
    .map(([symbol, f]) => ({ symbol, quote: f.quoteAsset }));
}
