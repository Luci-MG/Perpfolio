// stop-check.js — your stop orders against the suggested stop: which order protects a leg,
// how far it sits, how often a move that size happened on the symbol's own candles, and a
// verdict. Pure functions over normalised positions, orders and candles.

export const TOO_TIGHT_RATIO = 0.5;
export const TOO_WIDE_RATIO = 2;
export const TOO_TIGHT_HIT_RATE = 0.6;
export const HIT_HORIZON_HOURS = 24;
export const BREAKEVEN_BAND_PCT = 0.05;

/** The order-matching leg of a normalised position: Hyperliquid legs are one-way, keyed by pair. */
export function legOf(p) {
  return p.exchange === 'hyperliquid'
    ? { symbol: p.pair, positionSide: 'BOTH', side: p.side }
    : { symbol: p.symbol, positionSide: p.positionSide || 'BOTH', side: p.side };
}

/** Both venues' open orders in the shape `legStop` matches. */
export function stopOrders(binanceOrders = [], hyperliquidOrders = []) {
  return [...binanceOrders, ...hyperliquidOrders.map(o => ({ ...o, symbol: o.pair, positionSide: 'BOTH' }))];
}

/** The leg's stop order nearest `fromPrice` — a `Stop…` order on the closing side — with its distance in percent. */
export function legStop(orders, { symbol, positionSide, side }, fromPrice) {
  const closingSide = side === 'Long' ? 'Sell' : 'Buy';
  const stops = (orders || []).filter(o => o.symbol === symbol && o.side === closingSide && /^stop/i.test(o.type)
    && o.stopPrice > 0 && (o.positionSide === positionSide || o.positionSide === 'BOTH'));
  if (!stops.length || !(fromPrice > 0)) return null;
  const distance = o => Math.abs(o.stopPrice - fromPrice) / fromPrice * 100;
  const nearest = stops.reduce((a, b) => (distance(b) < distance(a) ? b : a));
  return { price: nearest.stopPrice, distancePct: +distance(nearest).toFixed(3) };
}

/** Your stop's distance as a multiple of the suggested one; null when either is missing. */
export function stopVsSuggested(yourStop, suggested) {
  if (!yourStop || !(suggested?.distancePct > 0)) return null;
  return +(yourStop.distancePct / suggested.distancePct).toFixed(2);
}

/**
 * Share of `hours`-long windows in hourly `candles` whose move against `side` reached
 * `distancePct` from the window's opening close. Windows overlap, so `independent` is
 * windows ÷ hours — the number to read the rate against.
 */
export function adverseHitRate(candles, distancePct, side, hours = HIT_HORIZON_HOURS) {
  const windows = (candles?.length || 0) - hours;
  if (windows < 1 || !(distancePct > 0)) return null;
  let hits = 0;
  for (let i = 0; i < windows; i++) {
    const start = candles[i].close;
    const span = candles.slice(i + 1, i + 1 + hours);
    const adverse = side === 'Long'
      ? (start - Math.min(...span.map(c => c.low))) / start
      : (Math.max(...span.map(c => c.high)) - start) / start;
    if (adverse * 100 >= distancePct) hits++;
  }
  return { rate: +(hits / windows).toFixed(3), windows, independent: Math.floor(windows / hours),
           days: +(candles.length / 24).toFixed(1) };
}

function lockedProfitPct(stop, entry, side) {
  const locked = side === 'Long' ? stop.price - entry : entry - stop.price;
  return +(locked / entry * 100).toFixed(3);
}

/**
 * Verdict on a leg's stop: none, hedged, breakeven (within ±0.05% of entry, about a taker fee),
 * locks (further past entry in profit), tight, wide or ok. Only a stop that risks a loss is
 * judged tight or wide.
 */
export function stopVerdict({ stop, suggestedPct, hit, entry, side, hedged }) {
  if (!stop) return { verdict: hedged ? 'hedged' : 'none', ratio: null, lockedPct: null };
  const ratio = suggestedPct > 0 ? +(stop.distancePct / suggestedPct).toFixed(2) : null;
  const lockedPct = lockedProfitPct(stop, entry, side);
  if (Math.abs(lockedPct) <= BREAKEVEN_BAND_PCT) return { verdict: 'breakeven', ratio, lockedPct: 0 };
  if (lockedPct > 0) return { verdict: 'locks', ratio, lockedPct: +lockedPct.toFixed(2) };
  if ((ratio != null && ratio < TOO_TIGHT_RATIO) || hit?.rate > TOO_TIGHT_HIT_RATE) return { verdict: 'tight', ratio, lockedPct: null };
  if (ratio != null && ratio > TOO_WIDE_RATIO) return { verdict: 'wide', ratio, lockedPct: null };
  return { verdict: 'ok', ratio, lockedPct: null };
}

/** Everything the Stops tab shows about a leg's real stop, measured from the current mark. */
export function checkLegStop({ position, orders, hedged, suggestedPct, atrPct, candles }) {
  const stop = legStop(orders, legOf(position), position.mark);
  const hit = stop && candles?.length ? adverseHitRate(candles, stop.distancePct, position.side) : null;
  return {
    yourStop: stop && { ...stop, atrMultiple: atrPct > 0 ? +(stop.distancePct / atrPct).toFixed(2) : null, hit },
    ...stopVerdict({ stop, suggestedPct, hit, entry: position.entry, side: position.side, hedged })
  };
}

/** True when the same Binance symbol has an open leg on the other side — a same-symbol hedge. */
export function hasOppositeLeg(p, positions) {
  return p.exchange === 'binance'
    && positions.some(q => q !== p && q.exchange === 'binance' && q.symbol === p.symbol && q.side !== p.side);
}
