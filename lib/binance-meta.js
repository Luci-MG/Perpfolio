// binance-meta.js — slow-moving exchange tables: funding cadence, lot filters, commission,
// order book snapshots and margin brackets. Separate from the account read so the account
// and the stress engine can both use it without importing each other.

import { binanceFetch, bnPublic } from './binance-client.js';
import { once } from './util.js';

// Declared funding cadence per symbol. Checked against the cadence actually observed in the
// income history, because Binance's declared value can lag a change — LABUSDT settles hourly
// while fundingInfo still reports 4h.
export const fundingMeta = {};
let fundingMetaAt = 0;

export async function refreshFundingMeta() {
  if (Date.now() - fundingMetaAt < 6 * 60 * 60 * 1000) return fundingMeta;
  return once('fundingInfo', loadFundingMeta);
}

async function loadFundingMeta() {
  try {
    const rows = await bnPublic('/fapi/v1/fundingInfo');
    if (!Array.isArray(rows) || !rows.length) throw new Error('empty fundingInfo');
    for (const r of rows) {
      fundingMeta[r.symbol] = {
        intervalHours: parseInt(r.fundingIntervalHours, 10) || 8,
        capPct: parseFloat(r.adjustedFundingRateCap) * 100,
        floorPct: parseFloat(r.adjustedFundingRateFloor) * 100
      };
    }
    fundingMetaAt = Date.now();
  } catch (err) {
    console.warn('[funding] fundingInfo failed:', err.message);
  }
  return fundingMeta;
}

/**
 * The settlement interval a symbol's next settlement time allows. Binance settles on whole
 * hours divisible by the interval, so an 8h symbol settling at 01:00 has moved to 1h, which
 * happens minutes after a cap hit while fundingInfo still declares 8h.
 */
export function intervalAt(intervalHours, nextFundingTime) {
  const at = new Date(nextFundingTime);
  if (!(nextFundingTime > 0) || at.getUTCMinutes() || at.getUTCHours() % intervalHours === 0) return intervalHours;
  return [4, 2, 1].find(h => h < intervalHours && at.getUTCHours() % h === 0);
}

// Lot step and tick, so any quantity a tool reports can actually be sent, and the account's
// real commission rate instead of a guessed one.
export const symbolFilters = {};
let symbolFiltersAt = 0;
const commissionRates = {};

export async function refreshSymbolFilters() {
  if (Date.now() - symbolFiltersAt < 24 * 60 * 60 * 1000) return symbolFilters;
  return once('exchangeInfo', loadSymbolFilters);
}

async function loadSymbolFilters() {
  try {
    const info = await bnPublic('/fapi/v1/exchangeInfo');
    if (!info?.symbols?.length) throw new Error('empty exchangeInfo');
    for (const s of info.symbols) {
      const f = Object.fromEntries((s.filters || []).map(x => [x.filterType, x]));
      symbolFilters[s.symbol] = {
        stepSize: f.LOT_SIZE?.stepSize ?? null,
        tickSize: f.PRICE_FILTER?.tickSize ?? null,
        minQty: f.LOT_SIZE?.minQty ?? null,
        minNotional: f.MIN_NOTIONAL?.notional ?? null,
        contractType: s.contractType ?? null,
        status: s.status ?? null,
        quoteAsset: s.quoteAsset ?? null
      };
    }
    symbolFiltersAt = Date.now();
  } catch (err) {
    console.warn('[filters] exchangeInfo failed:', err.message);
  }
  return symbolFilters;
}

export async function commissionFor(symbol) {
  const hit = commissionRates[symbol];
  if (hit && Date.now() - hit.ts < 24 * 60 * 60 * 1000) return hit;
  try {
    const r = await binanceFetch('/fapi/v1/commissionRate', { symbol });
    commissionRates[symbol] = {
      maker: parseFloat(r.makerCommissionRate), taker: parseFloat(r.takerCommissionRate), ts: Date.now()
    };
  } catch (err) {
    console.warn(`[fees] commissionRate ${symbol} failed:`, err.message);
    return { maker: 0.0002, taker: 0.0005, assumed: true };
  }
  return commissionRates[symbol];
}

let feeBurn = null;

/** Whether fees are paid in BNB at a discount (`/fapi/v1/feeBurn`), cached a day; null when unknown. */
export async function feeBurnStatus() {
  if (feeBurn && Date.now() - feeBurn.ts < 24 * 60 * 60 * 1000) return feeBurn.on;
  try {
    const r = await binanceFetch('/fapi/v1/feeBurn');
    feeBurn = { on: r.feeBurn === true || r.feeBurn === 'true', ts: Date.now() };
    return feeBurn.on;
  } catch (err) {
    console.warn('[feeBurn]', err.message);
    return null;
  }
}

// Order book snapshots, briefly cached: what the book can absorb right now, not what it will
// hold during a move.
const bookCache = {};
const BOOK_TTL_MS = 10_000;

export async function getBook(symbol, limit = 50) {
  const key = `${symbol}:${limit}`;
  const hit = bookCache[key];
  if (hit && Date.now() - hit.ts < BOOK_TTL_MS) return hit.book;
  try {
    const d = await bnPublic(`/fapi/v1/depth?symbol=${symbol}&limit=${limit}`);
    if (!d) return hit?.book || null;
    const book = { bids: d.bids || [], asks: d.asks || [] };
    bookCache[key] = { book, ts: Date.now() };
    return book;
  } catch (err) {
    return hit?.book || null;
  }
}

const BRACKET_TTL_MS = 24 * 60 * 60 * 1000;
let bracketCache = { map: null, ts: 0 };

export async function getBinanceLeverageBrackets() {
  if (bracketCache.map && Date.now() - bracketCache.ts < BRACKET_TTL_MS) return bracketCache.map;
  return once('leverageBracket', loadBrackets);
}

async function loadBrackets() {
  try {
    const raw = await binanceFetch('/fapi/v1/leverageBracket');
    const map = {};
    (Array.isArray(raw) ? raw : []).forEach(entry => {
      map[entry.symbol] = {
        notionalCoef: parseFloat(entry.notionalCoef || 1),
        brackets: (entry.brackets || []).map(b => ({
          notionalFloor:    parseFloat(b.notionalFloor),
          notionalCap:      parseFloat(b.notionalCap),
          maintMarginRatio: parseFloat(b.maintMarginRatio),
          cum:              parseFloat(b.cum)
        })).sort((a, b) => a.notionalFloor - b.notionalFloor)
      };
    });
    bracketCache = { map, ts: Date.now() };
    return map;
  } catch (err) {
    console.warn(`[risk] leverageBracket failed: ${err.message}`);
    return bracketCache.map;
  }
}
