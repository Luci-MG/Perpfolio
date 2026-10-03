// funding.js — what holding the open book costs in funding: per leg and per hedged pair at the
// estimated rate, against each symbol's own recent rates and cap, and what the ledger says was
// actually paid. Positive is received. Mechanics and sources: docs/research/funding.md. Pure.

const DAY_MS = 86_400_000;
const HISTORY_DAYS = 7;
const NEAR_CAP_SHARE = 0.5;
const DEFAULT_CAP_PCT = 2;
const HYPERLIQUID_CAP_PCT = 4;
const REALISED_WINDOWS = { d1: 1, d7: 7, d30: 30 };
const GAP_SHARE = 0.5;
const GAP_MIN_USD = 1;

const round = (v, dp = 2) => (v == null ? null : +v.toFixed(dp));
const signFor = side => (side === 'Long' ? -1 : 1);
const intervalOf = leg => (leg.fundingIntervalHours > 0 ? leg.fundingIntervalHours : 8);

/** Funding one leg pays (negative) or receives per settlement at rate `ratePct` per interval. */
export function perSettlement(leg, ratePct = leg.fundingRate) {
  return signFor(leg.side) * ((ratePct || 0) / 100) * (leg.sizeUsd || 0);
}

/** The same, per day: settlements per day follow the leg's own interval. */
export function perDay(leg) {
  return perSettlement(leg) * (24 / intervalOf(leg));
}

function usualRate(history, now) {
  const recent = (history || []).filter(r => r.t >= now - HISTORY_DAYS * DAY_MS && r.rateType !== 'Special');
  if (!recent.length) return null;
  const avgPct = recent.reduce((s, r) => s + r.ratePct, 0) / recent.length;
  const last = recent.at(-1);
  return { avgPct: round(avgPct, 5), points: recent.map(r => round(r.ratePct, 5)),
           lastCharged: { at: last.t, ratePct: round(last.ratePct, 5) } };
}

function capFor(leg, meta) {
  if (leg.exchange === 'hyperliquid') return HYPERLIQUID_CAP_PCT;
  const m = meta?.[leg.symbol];
  const cap = leg.fundingRate >= 0 ? m?.capPct : m?.floorPct;
  return Math.abs(Number.isFinite(cap) && cap ? cap : DEFAULT_CAP_PCT);
}

function legRow(leg, { meta, history, now }) {
  const interval = intervalOf(leg);
  const capPct = capFor(leg, meta);
  const share = Math.abs(leg.fundingRate || 0) / capPct;
  const day = perDay(leg);
  return {
    exchange: leg.exchange, symbol: leg.symbol ?? leg.coin, side: leg.side, notional: round(leg.sizeUsd),
    ratePct: round(leg.fundingRate, 5), intervalHours: interval,
    aprPct: round((leg.fundingRate || 0) * (24 / interval) * 365, 2),
    perSettlement: round(perSettlement(leg), 4), perDay: round(day, 4),
    nextAt: leg.nextFundingTime ?? null,
    capPct: round(capPct, 4), nearCap: share >= NEAR_CAP_SHARE ? { share: round(share, 3), receiving: day > 0 } : null,
    usual: leg.exchange === 'binance' ? usualRate(history?.[leg.symbol], now) : null
  };
}

function pairRows(legs) {
  const bySymbol = new Map();
  for (const leg of legs) bySymbol.set(`${leg.exchange}:${leg.symbol}`, [...(bySymbol.get(`${leg.exchange}:${leg.symbol}`) || []), leg]);
  return [...bySymbol.values()].map(group => {
    const long = group.find(l => l.side === 'Long'), short = group.find(l => l.side === 'Short');
    if (!long || !short) return { pair: false, ...group[0] };
    return { pair: true, exchange: long.exchange, symbol: long.symbol, perDay: round(long.perDay + short.perDay, 4),
             perSettlement: round(long.perSettlement + short.perSettlement, 4), nextAt: long.nextAt,
             ratePct: long.ratePct, intervalHours: long.intervalHours, aprPct: long.aprPct,
             nearCap: long.nearCap || short.nearCap ? { ...(long.nearCap || short.nearCap), receiving: long.perDay + short.perDay > 0 } : null,
             usual: long.usual, notional: round(long.notional + short.notional), long, short };
  }).sort((a, b) => a.perDay - b.perDay);
}

function realisedFrom(income, until) {
  const rows = (income || []).filter(r => r.incomeType === 'FUNDING_FEE' && r.time <= until);
  const sumSince = (days, symbol) => round(rows
    .filter(r => r.time >= until - days * DAY_MS && (!symbol || r.symbol === symbol))
    .reduce((s, r) => s + parseFloat(r.income), 0));
  const first = rows.reduce((m, r) => Math.min(m, r.time), Infinity);
  const coveredDays = Math.min(REALISED_WINDOWS.d7, Math.max(0, (until - first) / DAY_MS));
  return { sumSince, coveredDays, total: Object.fromEntries(Object.entries(REALISED_WINDOWS).map(([k, d]) => [k, sumSince(d)])) };
}

function nextSettlement(legs, now) {
  const upcoming = legs.filter(l => l.nextAt > now);
  if (!upcoming.length) return null;
  const at = Math.min(...upcoming.map(l => l.nextAt));
  return { at, amount: round(upcoming.filter(l => l.nextAt === at).reduce((s, l) => s + l.perSettlement, 0), 4) };
}

/**
 * The book's funding: rows worst first (a same-symbol long and short as one pair row), totals
 * at the estimated rate, the next settlement, realised funding from the ledger up to
 * `syncedAt`, and whether it disagrees with the Binance estimate, the only venue the ledger
 * covers. `history` maps symbol to `{ t, ratePct, rateType }` rows; `meta` maps symbol to its
 * cap and floor in percent.
 */
export function fundingBook({ legs = [], meta = {}, history = {}, income = [], equity = null, now = Date.now(), syncedAt = null } = {}) {
  const rows = legs.map(leg => legRow(leg, { meta, history, now }));
  const day = rows.reduce((s, r) => s + r.perDay, 0);
  const gross = rows.reduce((s, r) => s + (r.notional || 0), 0);
  const realised = realisedFrom(income, syncedAt ?? now);
  const comparable = realised.coveredDays >= 1;
  const realisedPerDay = comparable ? realised.total.d7 / realised.coveredDays : null;
  const binanceDay = rows.filter(r => r.exchange === 'binance').reduce((s, r) => s + r.perDay, 0);
  const gap = comparable ? Math.abs(realisedPerDay - binanceDay) > Math.max(GAP_MIN_USD, GAP_SHARE * Math.abs(binanceDay)) : null;
  const groups = pairRows(rows).map(r => ({ ...r, realised7d: realised.sumSince(7, r.symbol) }));
  return {
    rows: groups,
    totals: {
      perDay: round(day, 4), aprOnGrossPct: gross ? round(day * 365 / gross * 100, 3) : null,
      pctOfEquityPerDay: equity > 0 ? round(day / equity * 100, 4) : null,
      byExchange: Object.fromEntries(['binance', 'hyperliquid'].map(x => [x, round(rows.filter(r => r.exchange === x).reduce((s, r) => s + r.perDay, 0), 4)])),
      legs: rows.length, pairs: groups.filter(g => g.pair).length
    },
    next: nextSettlement(rows, now),
    realised: { ...realised.total, perDay7d: round(realisedPerDay, 4), coveredDays: round(realised.coveredDays, 2),
                estimatePerDay: round(binanceDay, 4), syncedAt, differsFromEstimate: gap }
  };
}
