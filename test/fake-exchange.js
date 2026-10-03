// fake-exchange.js — a deterministic stand-in for Binance USDM and Hyperliquid (test only)
//
// Installs itself as globalThis.fetch and answers every endpoint the server calls from a
// small synthetic hedged book; anything else (the test's own requests to the local server)
// passes through to the real fetch. The account figures Binance would report — maintenance
// and initial margin, margin balance, available balance, liquidation prices — are derived
// from the positions with the exchange's own bracket arithmetic, so the server's calibration
// against "reported" numbers is exercised for real. No real account data is involved.

import * as risk from '../risk-engine.js';

export const NOW = Date.UTC(2026, 8, 1, 0, 0, 0);
const HOUR = 3600e3;
const INTERVAL_MS = { '1m': 60e3, '5m': 5 * 60e3, '15m': 15 * 60e3, '1h': HOUR, '2h': 2 * HOUR, '4h': 4 * HOUR, '1d': 24 * HOUR };

const TIERS = [
  { bracket: 1, notionalFloor: 0, notionalCap: 50000, maintMarginRatio: 0.004, cum: 0, initialLeverage: 125 },
  { bracket: 2, notionalFloor: 50000, notionalCap: 250000, maintMarginRatio: 0.005, cum: 50, initialLeverage: 100 },
  { bracket: 3, notionalFloor: 250000, notionalCap: 1e7, maintMarginRatio: 0.01, cum: 1300, initialLeverage: 50 }
];

const SYMBOLS = {
  BTCUSDT: { quote: 'USDT', base: 100000, fundingRate: 0.0001, intervalHours: 8, step: '0.001', tick: '0.1' },
  ETHUSDT: { quote: 'USDT', base: 4000, fundingRate: 0.0002, intervalHours: 4, step: '0.001', tick: '0.01' },
  SOLUSDT: { quote: 'USDT', base: 200, fundingRate: -0.00005, intervalHours: 8, step: '0.01', tick: '0.01' },
  ENAUSDC: { quote: 'USDC', base: 0.25, fundingRate: 0.00015, intervalHours: 4, step: '1', tick: '0.0001' }
};

const FEE_ASSET_PRICE = { BNBUSDT: 600 };

const POSITIONS = [
  { symbol: 'BTCUSDT', positionSide: 'LONG', amt: 0.5, entry: 98000, leverage: 10 },
  { symbol: 'BTCUSDT', positionSide: 'SHORT', amt: -0.4, entry: 103000, leverage: 10 },
  { symbol: 'ETHUSDT', positionSide: 'LONG', amt: 3, entry: 4100, leverage: 5 },
  { symbol: 'ENAUSDC', positionSide: 'LONG', amt: 8000, entry: 0.27, leverage: 3 }
];

const WALLETS = { USDT: 20000, USDC: 1200 };
const OPEN_ORDER_IM = { USDT: 150, USDC: 0 };

const ORDERS = [
  { orderId: 11, symbol: 'ETHUSDT', side: 'SELL', type: 'TAKE_PROFIT_MARKET', price: '0', origQty: '3',
    stopPrice: '4600', positionSide: 'LONG', closePosition: false, reduceOnly: true },
  { orderId: 12, symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '95000', origQty: '0.1',
    stopPrice: '0', positionSide: 'LONG', closePosition: false, reduceOnly: false }
];

const ALGO_ORDERS = [
  { algoId: 21, symbol: 'BTCUSDT', side: 'SELL', orderType: 'STOP_MARKET', triggerPrice: '90000',
    price: '0', quantity: '0.5', positionSide: 'LONG', reduceOnly: true, closePosition: false }
];

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function seedOf(text) {
  return [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
}

// Close path ending exactly at the symbol's mark, so klines and positionRisk agree.
function closes(symbol, interval, n) {
  const r = rng(seedOf(symbol + interval));
  const out = [1];
  for (let i = 1; i < n; i++) out.push(out[i - 1] * (1 + (r() - 0.5) * 0.02 + 0.0002 * Math.sin(i / 40)));
  const scale = (SYMBOLS[symbol]?.base ?? FEE_ASSET_PRICE[symbol]) / out[n - 1];
  return out.map(v => v * scale);
}

function klines(symbol, interval, limit) {
  const step = INTERVAL_MS[interval];
  const r = rng(seedOf(symbol + interval + 'v'));
  const series = closes(symbol, interval, limit);
  return series.map((close, i) => {
    const open = i ? series[i - 1] : close;
    const t = NOW - (limit - i) * step;
    const high = Math.max(open, close) * (1 + 0.003 * r());
    const low = Math.min(open, close) * (1 - 0.003 * r());
    const volume = 1000 + 500 * r();
    const takerBuy = volume * (0.4 + 0.2 * r());
    return [t, String(open), String(high), String(low), String(close), String(volume), t + step - 1,
      String(volume * close), 100, String(takerBuy), String(takerBuy * close), '0'];
  });
}

const pathPrice = (symbol, t) => SYMBOLS[symbol].base * (1 + 0.03 * Math.sin(t / (36 * HOUR)) + 0.01 * Math.sin(t / (5 * HOUR)));

function klinesRange(symbol, interval, start, end, limit) {
  const step = INTERVAL_MS[interval];
  const last = Math.min(end ?? NOW, NOW);
  const first = start != null ? Math.ceil(start / step) * step : Math.floor(last / step) * step - (limit - 1) * step;
  const out = [];
  for (let t = first; t <= last && out.length < limit; t += step) {
    const open = pathPrice(symbol, t), close = pathPrice(symbol, t + step);
    out.push([t, String(open), String(Math.max(open, close) * 1.002), String(Math.min(open, close) * 0.998),
      String(close), '1000', t + step - 1, String(1000 * close), 100, '500', String(500 * close), '0']);
  }
  return out;
}

function periodRows(symbol, period, limit, value) {
  const step = INTERVAL_MS[period] || HOUR;
  const r = rng(seedOf(symbol + period + value.name));
  return Array.from({ length: limit }, (_, i) => ({ symbol, timestamp: NOW - (limit - i) * step, ...value(i, r) }));
}

function mark(symbol) {
  return SYMBOLS[symbol].base;
}

function enginePool(quote) {
  const positions = POSITIONS.filter(p => SYMBOLS[p.symbol].quote === quote).map(p => ({
    key: `${p.symbol}:${p.positionSide}`, asset: p.symbol.replace(quote, ''), symbol: p.symbol,
    positionSide: p.positionSide, q: p.amt, entry: p.entry, mark: mark(p.symbol),
    leverage: p.leverage, brackets: TIERS, notionalCoef: 1
  }));
  return { collateral: WALLETS[quote], positions, orders: [], freeReserved: OPEN_ORDER_IM[quote] };
}

function marksFor(quote) {
  return Object.fromEntries(POSITIONS.filter(p => SYMBOLS[p.symbol].quote === quote)
    .map(p => [p.symbol.replace(quote, ''), mark(p.symbol)]));
}

const inSingleAssetTotals = quote => quote === 'USDT';

function accountState() {
  const assets = [];
  const positions = [];
  let tWallet = 0, tMargin = 0, tIm = 0, tMm = 0, tAvail = 0, tUpnl = 0;
  for (const quote of Object.keys(WALLETS)) {
    const pool = enginePool(quote);
    const state = risk.evalPool(pool, marksFor(quote));
    const upnl = state.equity - WALLETS[quote];
    const available = state.equity - state.im - OPEN_ORDER_IM[quote];
    assets.push({
      asset: quote, walletBalance: String(WALLETS[quote]), crossWalletBalance: String(WALLETS[quote]),
      marginBalance: String(state.equity), maintMargin: String(state.mm),
      initialMargin: String(state.im + OPEN_ORDER_IM[quote]), positionInitialMargin: String(state.im),
      openOrderInitialMargin: String(OPEN_ORDER_IM[quote]), availableBalance: String(available),
      maxWithdrawAmount: String(Math.max(0, available)), unrealizedProfit: String(upnl)
    });
    for (const d of state.positions) {
      positions.push({ symbol: d.symbol, positionSide: d.positionSide, maintMargin: String(d.mm),
        positionInitialMargin: String(d.im) });
    }
    if (!inSingleAssetTotals(quote)) continue;
    tWallet += WALLETS[quote]; tMargin += state.equity; tIm += state.im + OPEN_ORDER_IM[quote];
    tMm += state.mm; tAvail += available; tUpnl += upnl;
  }
  return {
    totalWalletBalance: String(tWallet), totalCrossWalletBalance: String(tWallet),
    totalMarginBalance: String(tMargin), totalInitialMargin: String(tIm), totalMaintMargin: String(tMm),
    availableBalance: String(tAvail), totalCrossUnPnl: String(tUpnl), multiAssetsMargin: false,
    canTrade: false, assets, positions
  };
}

function positionRisk() {
  return POSITIONS.map(p => {
    const { quote } = SYMBOLS[p.symbol];
    const pool = risk.freezeTiers(enginePool(quote), marksFor(quote));
    const liq = risk.liquidationPriceAnalytic(pool, p.symbol.replace(quote, ''), marksFor(quote));
    const m = mark(p.symbol);
    return {
      symbol: p.symbol, positionSide: p.positionSide, positionAmt: String(p.amt), entryPrice: String(p.entry),
      markPrice: String(m), liquidationPrice: String(liq ?? 0), unRealizedProfit: String(p.amt * (m - p.entry)),
      notional: String(p.amt * m), leverage: String(p.leverage), marginType: 'cross', isolatedWallet: '0',
      adlQuantile: 1
    };
  });
}

function incomeRows() {
  const rows = [];
  let id = 1;
  for (let d = 30; d >= 1; d--) {
    const time = NOW - d * 24 * HOUR;
    rows.push({ symbol: 'BTCUSDT', incomeType: 'REALIZED_PNL', income: String((d % 5) * 12 - 20), asset: 'USDT', time, tranId: id++ });
    rows.push({ symbol: 'BTCUSDT', incomeType: 'COMMISSION', income: '-1.5', asset: 'USDT', time: time + 1, tranId: id++ });
    rows.push({ symbol: 'ETHUSDT', incomeType: 'FUNDING_FEE', income: '-0.8', asset: 'USDT', time: time + 2, tranId: id++ });
    const settlement = id++;
    rows.push({ symbol: 'SOLUSDT', incomeType: 'FUNDING_FEE', income: '-2.5', asset: 'USDT', time: time + 3, tranId: settlement });
    rows.push({ symbol: 'SOLUSDT', incomeType: 'FUNDING_FEE', income: '2.4', asset: 'USDT', time: time + 3, tranId: settlement });
    if (d === 10) rows.push({ symbol: 'BTCUSDT', incomeType: 'COMMISSION_REBATE', income: '0.3', asset: 'USDT', time: time + 4, tranId: id++ });
  }
  return rows;
}

function tradeRows(symbol) {
  if (symbol !== 'BTCUSDT' && symbol !== 'ETHUSDT') return [];
  const out = [];
  let id = symbol === 'BTCUSDT' ? 1000 : 2000;
  const px = SYMBOLS[symbol].base;
  for (let k = 0; k < 12; k++) {
    const t = NOW - (40 - k * 3) * 24 * HOUR;
    const win = k % 3 !== 0;
    out.push({ symbol, id, orderId: id++, side: 'BUY', positionSide: 'LONG', price: String(px), qty: '0.1',
      realizedPnl: '0', commission: '0.4', commissionAsset: 'USDT', time: t, maker: false });
    if (k % 4 === 1) {
      out.push({ symbol, id, orderId: id++, side: 'BUY', positionSide: 'LONG', price: String(px * 0.98), qty: '0.1',
        realizedPnl: '0', commission: '0.4', commissionAsset: 'USDT', time: t + HOUR, maker: true });
    }
    const qty = k % 4 === 1 ? '0.2' : '0.1';
    const paidInBnb = symbol === 'ETHUSDT' && k === 4;
    out.push({ symbol, id, orderId: id++, side: 'SELL', positionSide: 'LONG', price: String(px * (win ? 1.01 : 0.99)), qty,
      realizedPnl: String((win ? 1 : -1) * px * 0.001 * (k % 4 === 1 ? 2 : 1)), commission: paidInBnb ? '0.0006' : '0.4',
      commissionAsset: paidInBnb ? 'BNB' : 'USDT', time: t + 6 * HOUR, maker: k % 2 === 0 });
    if (symbol === 'BTCUSDT' && k % 5 === 2) {
      out.push({ symbol, id, orderId: id++, side: 'SELL', positionSide: 'SHORT', price: String(px), qty: '0.05',
        realizedPnl: '0', commission: '0.2', commissionAsset: 'USDT', time: t + 2 * HOUR, maker: false });
      out.push({ symbol, id, orderId: id++, side: 'BUY', positionSide: 'SHORT', price: String(px * 1.004), qty: '0.05',
        realizedPnl: String(-px * 0.0002), commission: '0.2', commissionAsset: 'USDT', time: t + 4 * HOUR, maker: false });
    }
  }
  return out.sort((a, b) => a.id - b.id);
}

function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json', 'x-mbx-used-weight-1m': '42', ...headers }
  });
}

function binance(url) {
  const q = url.searchParams;
  const path = url.pathname;
  const symbol = q.get('symbol');
  const pair = q.get('pair');
  const known = s => s && SYMBOLS[s];

  if (path === '/fapi/v2/account') return accountState();
  if (path === '/fapi/v2/positionRisk') return positionRisk();
  if (path === '/fapi/v1/openOrders') return ORDERS;
  if (path === '/fapi/v1/openAlgoOrders') return ALGO_ORDERS;
  if (path === '/fapi/v1/feeBurn') return { feeBurn: true };
  if (path === '/fapi/v1/commissionRate') return { symbol, makerCommissionRate: '0.0002', takerCommissionRate: '0.0005' };
  if (path === '/fapi/v1/leverageBracket') {
    return Object.keys(SYMBOLS).map(s => ({ symbol: s, notionalCoef: 1, brackets: TIERS }));
  }
  if (path === '/fapi/v1/listenKey') return { listenKey: 'fake' };
  if (path === '/fapi/v1/premiumIndex') {
    return Object.entries(SYMBOLS).map(([s, v]) => ({ symbol: s, markPrice: String(v.base),
      lastFundingRate: String(v.fundingRate), nextFundingTime: NOW + HOUR }));
  }
  if (path === '/fapi/v1/fundingInfo') {
    return Object.entries(SYMBOLS).map(([s, v]) => ({ symbol: s, fundingIntervalHours: v.intervalHours,
      adjustedFundingRateCap: '0.02', adjustedFundingRateFloor: '-0.02' }));
  }
  if (path === '/fapi/v1/exchangeInfo') {
    return { symbols: Object.entries(SYMBOLS).map(([s, v]) => ({
      symbol: s, contractType: 'PERPETUAL', status: 'TRADING', quoteAsset: v.quote,
      filters: [{ filterType: 'LOT_SIZE', stepSize: v.step, minQty: v.step },
                { filterType: 'PRICE_FILTER', tickSize: v.tick },
                { filterType: 'MIN_NOTIONAL', notional: '5' }]
    })) };
  }
  if (path === '/fapi/v1/klines') {
    if (!known(symbol) && !FEE_ASSET_PRICE[symbol]) return { status: 400, body: { code: -1121, msg: 'Invalid symbol.' } };
    const limit = Math.min(1500, parseInt(q.get('limit') || '500', 10));
    if (q.has('startTime') || q.has('endTime')) {
      const num = k => (q.has(k) ? parseInt(q.get(k), 10) : null);
      return klinesRange(symbol, q.get('interval'), num('startTime'), num('endTime'), limit);
    }
    return klines(symbol, q.get('interval'), limit);
  }
  if (path === '/fapi/v1/depth') {
    const m = mark(symbol);
    return { bids: Array.from({ length: 20 }, (_, i) => [String(m * (1 - 0.0005 * (i + 1))), '5']),
             asks: Array.from({ length: 20 }, (_, i) => [String(m * (1 + 0.0005 * (i + 1))), '5']) };
  }
  if (path === '/fapi/v1/fundingRate') {
    const v = SYMBOLS[symbol];
    if (!v) return [];
    const from = parseInt(q.get('startTime') || '0', 10), to = parseInt(q.get('endTime') || String(NOW), 10);
    return Array.from({ length: 120 }, (_, i) => ({ symbol, fundingTime: NOW - (120 - i) * v.intervalHours * HOUR,
      fundingRate: String(v.fundingRate * (1 + 0.3 * Math.sin(i / 5))), markPrice: String(v.base) }))
      .filter(r => r.fundingTime >= from && r.fundingTime <= to);
  }
  if (path === '/futures/data/openInterestHist') {
    return periodRows(symbol, q.get('period'), 500, function oi(i, r) {
      const v = 10000 * (1 + 0.1 * Math.sin(i / 30) + 0.02 * r());
      return { sumOpenInterest: String(v), sumOpenInterestValue: String(v * mark(symbol)) };
    });
  }
  if (path === '/futures/data/topLongShortPositionRatio' || path === '/futures/data/globalLongShortAccountRatio') {
    const top = path.includes('top');
    return periodRows(symbol, q.get('period'), 500, function ls(i, r) {
      return { longShortRatio: String((top ? 1.1 : 1.0) + 0.2 * Math.sin(i / (top ? 20 : 33)) + 0.05 * r()) };
    });
  }
  if (path === '/futures/data/basis') {
    return periodRows(pair, q.get('period'), 500, function basis(i, r) {
      return { basisRate: String(0.0003 * Math.sin(i / 25) + 0.0001 * r()) };
    });
  }
  if (path === '/fapi/v1/income') {
    const page = parseInt(q.get('page') || '1', 10);
    return page === 1 ? incomeRows().filter(r => r.time >= parseInt(q.get('startTime') || '0', 10)) : [];
  }
  if (path === '/fapi/v1/userTrades') {
    const fromId = parseInt(q.get('fromId') || '0', 10);
    return tradeRows(symbol).filter(t => t.id >= fromId);
  }
  return { status: 404, body: { code: -1, msg: `fake: no route ${path}` } };
}

function hyperliquid(body) {
  if (body.type === 'clearinghouseState') {
    return {
      assetPositions: [{ position: { coin: 'SOL', szi: '-20', entryPx: '210', liquidationPx: '290',
        unrealizedPnl: String(-20 * (200 - 210)), leverage: { value: 5 } } }],
      marginSummary: { accountValue: '3000', totalMarginUsed: '800' }
    };
  }
  if (body.type === 'metaAndAssetCtxs') {
    return [{ universe: [{ name: 'BTC' }, { name: 'SOL' }] },
            [{ markPx: '100000', funding: '0.0000125', prevDayPx: '99000' },
             { markPx: '200', funding: '0.00001', prevDayPx: '198' }]];
  }
  if (body.type === 'openOrders') return [];
  if (body.type === 'spotClearinghouseState') return { balances: [{ coin: 'USDC', total: '3000' }] };
  if (body.type === 'candleSnapshot') {
    const coin = body.req.coin;
    const symbol = coin === 'BTC' ? 'BTCUSDT' : 'SOLUSDT';
    return klines(symbol, '1h', 200).map(k => ({ t: k[0], o: k[1], h: k[2], l: k[3], c: k[4], v: k[5] }));
  }
  return [];
}

/** Installs the fake as globalThis.fetch. `ban(sec)` makes Binance answer 418 for a while. */
export function installFakeExchange() {
  const realFetch = globalThis.fetch;
  const calls = [];
  const signedCalls = [];
  let bannedUntil = 0;

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'fapi.binance.com') {
      calls.push(url.pathname);
      if (url.searchParams.has('signature')) signedCalls.push(url.pathname);
      if (Date.now() < bannedUntil) return json({ code: -1003, msg: 'banned' }, { status: 418, headers: { 'Retry-After': '1' } });
      const out = binance(url);
      return out?.status ? json(out.body, { status: out.status }) : json(out);
    }
    if (url.hostname === 'api.hyperliquid.xyz') {
      calls.push(`hl:${JSON.parse(init.body || '{}').type}`);
      return json(hyperliquid(JSON.parse(init.body || '{}')));
    }
    return realFetch(input, init);
  };

  return {
    calls,
    signedCalls,
    ban(seconds) { bannedUntil = Date.now() + seconds * 1000; },
    restore() { globalThis.fetch = realFetch; }
  };
}
