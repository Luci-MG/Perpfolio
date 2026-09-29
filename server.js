import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import WebSocket from 'ws';
import * as vol from './vol-estimator.js';
import * as risk from './risk-engine.js';
import * as store from './history-store.js';
import * as ta from './trade-analytics.js';
import * as cf from './confluence.js';
dotenv.config();

// ── Utility ───────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Jitter: returns delay ± 20%
function jitter(ms) {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.static(path.join(__dirname, 'public')));

const BINANCE_API_KEY    = process.env.BINANCE_API_KEY || '';
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET || '';
const HL_WALLET          = process.env.HL_WALLET_ADDRESS || '';

const BINANCE_BASE    = 'https://fapi.binance.com';
const BINANCE_WS_BASE = 'wss://fstream.binance.com/private/ws';
const HL_BASE         = 'https://api.hyperliquid.xyz/info';

// Reported by every signed response; the history sync pauses on it rather than discovering
// the limit by being rate-limited.
let usedWeight1m = 0;
const WEIGHT_CEILING = 1800;   // of 2400/min

const FETCH_TIMEOUT_MS = 10_000;

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

async function bnPublic(pathAndQuery) {
  const endpoint = pathAndQuery.split('?')[0];
  assertNotBanned(endpoint);
  const res = await fetch(`${BINANCE_BASE}${pathAndQuery}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  noteBinanceResponse(res, endpoint);
  if (!res.ok) throw new Error(`${endpoint} → ${res.status}`);
  return res.json();
}

async function throttleWeight() {
  if (usedWeight1m < WEIGHT_CEILING) return;
  console.warn(`[sync] used weight ${usedWeight1m} — pausing 20s`);
  await sleep(20_000);
  usedWeight1m = 0;
}

// ── Binance User Data Stream state ────────────────────────────────────────
let bnOrderCache     = [];   // normalised regular open orders, kept live by WS + reconcile
let lastWsMessage    = 0;    // a socket can stay open and stop delivering
let listenKey        = null;
let bnWs             = null;
let keepaliveTimer   = null;
let reconnectTimeout = null;

// USDM futures symbols are base+quote with no separator. The quote asset is also the
// collateral asset, and in single-asset margin mode each collateral asset is its own
// cross pool — so this split decides pool membership, not just labels.
const BN_QUOTES = ['USDT', 'USDC', 'FDUSD', 'BUSD'];

function splitSymbol(symbol) {
  const quote = BN_QUOTES.find(q => symbol.endsWith(q)) || 'USDT';
  return { base: symbol.slice(0, -quote.length) || symbol, quote };
}

function binanceSign(params) {
  const query = new URLSearchParams(params).toString();
  const sig = crypto.createHmac('sha256', BINANCE_API_SECRET).update(query).digest('hex');
  return `${query}&signature=${sig}`;
}

async function binanceFetch(endpoint, params = {}, method = 'GET') {
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

async function hlFetch(body) {
  const MAX_RETRIES = 4;
  let delay = 500;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(HL_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });

    if (res.ok) return res.json();

    if (res.status === 429) {
      const retryAfterSec = res.headers.get('Retry-After');
      const waitMs = retryAfterSec ? parseInt(retryAfterSec, 10) * 1000 : jitter(delay);
      console.warn(`[rate-limit] HL 429 on type=${body.type}, retry ${attempt}/${MAX_RETRIES} in ${waitMs}ms`);
      if (attempt === MAX_RETRIES) throw new Error(`HL ${body.type} rate-limited after ${MAX_RETRIES} retries`);
      await sleep(waitMs);
      delay *= 2;
      continue;
    }

    throw new Error(`HL → ${res.status}`);
  }
}

// One in-flight request and one recent result per account read, shared by every route and
// every open tab. Without it each tab polled both exchanges on its own, so the request quota
// scaled with the number of tabs rather than with use. Rejections are never cached.
const SNAPSHOT_TTL_MS = 10_000;

function sharedSnapshot(fetcher, ttlMs = SNAPSHOT_TTL_MS) {
  let value = null, at = 0, pending = null;
  return ({ maxAgeMs = ttlMs } = {}) => {
    if (value && Date.now() - at < maxAgeMs) return Promise.resolve(value);
    pending ??= fetcher()
      .then(v => { value = v; at = Date.now(); return v; })
      .finally(() => { pending = null; });
    return pending;
  };
}

const hlRaw = sharedSnapshot(() => Promise.all([
  hlFetch({ type: 'clearinghouseState', user: HL_WALLET }),
  hlFetch({ type: 'metaAndAssetCtxs' }),
  hlFetch({ type: 'openOrders', user: HL_WALLET }).catch(() => []),
  hlFetch({ type: 'spotClearinghouseState', user: HL_WALLET }).catch(() => null)
]));

async function getHyperliquidData(opts) {
  const [state, meta, rawOrders, spotState] = await hlRaw(opts);

  const assetMeta = meta[0]?.universe || [];
  const assetCtxs = meta[1] || [];

  const markPrices = {};
  assetMeta.forEach((a, i) => {
    markPrices[a.name] = parseFloat(assetCtxs[i]?.markPx || 0);
  });

  const openPositions = (state.assetPositions || [])
    .filter(p => parseFloat(p.position?.szi || 0) !== 0)
    .map(p => {
      const pos      = p.position;
      const asset    = pos.coin;
      const size     = parseFloat(pos.szi);
      const entry    = parseFloat(pos.entryPx);
      const liqPx    = parseFloat(pos.liquidationPx || 0);
      const upnl     = parseFloat(pos.unrealizedPnl);
      const mark     = markPrices[asset] || 0;
      const notional = Math.abs(size) * mark;
      const idx      = assetMeta.findIndex(a => a.name === asset);
      const funding  = parseFloat(assetCtxs[idx]?.funding || 0) * 100;
      const prevDayPx = parseFloat(assetCtxs[idx]?.prevDayPx || 0);
      const leverage = parseFloat(pos.leverage?.value || pos.leverage || 1);
      const fundingSign = funding >= 0 ? '+' : '';
      return {
        pair:        `${asset}-PERP`,
        coin:        asset,
        prevDayPx,
        type:        'perpetual',
        side:        size > 0 ? 'Long' : 'Short',
        leverage:    `${leverage}×`,
        size:        `${Math.abs(size)} ${asset}`,
        sizeUsd:     notional,
        entry,
        mark,
        liqPrice:    liqPx,
        upnl,
        fundingRate: funding,
        funding8h:   `${fundingSign}${funding.toFixed(4)}%`,
        fundingIntervalHours: 1,
        exchange:    'hyperliquid'
      };
    });

  const openOrders = (Array.isArray(rawOrders) ? rawOrders : []).map(o => ({
    pair:       `${o.coin}-PERP`,
    side:       o.side === 'B' ? 'Buy' : 'Sell',
    type:       o.orderType === 'Stop' ? 'Stop market' : 'Limit',
    price:      parseFloat(o.limitPx || 0),
    stopPrice:  o.triggerPx ? parseFloat(o.triggerPx) : null,
    size:       `${parseFloat(o.sz || 0)} ${o.coin}`,
    reduceOnly: o.reduceOnly || false,
    exchange:   'hyperliquid'
  }));

  // HL uses a unified cross-margin model: spot USDC is the actual account balance,
  // and 'hold' is the portion locked as perp margin. marginSummary.accountValue is
  // only the perp sub-account view — not the true wallet balance.
  const spotUsdc    = (spotState?.balances || []).find(b => b.coin === 'USDC');
  const equity      = spotUsdc ? parseFloat(spotUsdc.total) : parseFloat(state.marginSummary?.accountValue || 0);
  const marginUsed  = parseFloat(state.marginSummary?.totalMarginUsed || 0);
  const totalNtlPos = openPositions.reduce((sum, p) => sum + p.sizeUsd, 0);
  const marginPct   = equity > 0 ? ((marginUsed / equity) * 100).toFixed(1) : '0.0';
  const freeMargin  = equity - marginUsed;
  const accountLeverage = equity > 0 ? (totalNtlPos / equity).toFixed(2) : '0.00';

  return { equity, marginPct, marginUsed, freeMargin, totalNtlPos, accountLeverage, openPositions, openOrders };
}

// ── Normalise a raw Binance REST order into dashboard shape ───────────────
// Used both for the initial WS seed (REST snapshot) and inside getBinanceData
// for algo orders (which remain on REST).
function normaliseBnOrder(o) {
  const { base: asset, quote } = splitSymbol(o.symbol);
  const typeStr = o.type ? (o.type.charAt(0) + o.type.slice(1).toLowerCase().replace(/_/g, ' ')) : 'Limit';
  const stopPx  = parseFloat(o.stopPrice || 0);
  return {
    orderId:      o.orderId,         // kept for WS cache keying; not sent to frontend
    pair:         `${asset}/${quote}`,
    asset,
    quote,
    symbol:       o.symbol,
    positionSide: o.positionSide || 'BOTH',
    side:         o.side === 'BUY' ? 'Buy' : 'Sell',
    type:         typeStr,
    price:        parseFloat(o.price || 0),
    stopPrice:    stopPx > 0 ? stopPx : null,
    size:         `${parseFloat(o.origQty || 0)} ${asset}`,
    sizeRaw:      Math.abs(parseFloat(o.origQty || 0)),
    closePosition: o.closePosition || false,
    reduceOnly:   o.reduceOnly || o.closePosition || false,
    exchange:     'binance'
  };
}

// ── Binance User Data Stream — keeps bnOrderCache live ───────────────────
async function startBinanceUserDataStream() {
  // Clear any pending reconnect so we don't stack timers
  if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }

  try {
    // 1. Get a fresh listenKey
    const data = await binanceFetch('/fapi/v1/listenKey', {}, 'POST');
    listenKey = data.listenKey;
  } catch (err) {
    console.error('[bnWS] Failed to create listenKey:', err.message, '— retrying in 15s');
    reconnectTimeout = setTimeout(startBinanceUserDataStream, 15_000);
    return;
  }

  // 2. Open the WebSocket
  if (bnWs) { try { bnWs.terminate(); } catch (_) {} }
  bnWs = new WebSocket(`${BINANCE_WS_BASE}/${listenKey}`);

  bnWs.on('open', async () => {
    console.log('[bnWS] User Data Stream connected');

    // 3. Seed the order cache with a one-time REST snapshot
    try {
      const snapshot = await binanceFetch('/fapi/v1/openOrders');
      bnOrderCache = (Array.isArray(snapshot) ? snapshot : []).map(normaliseBnOrder);
      console.log(`[bnWS] Order cache seeded — ${bnOrderCache.length} open orders`);
    } catch (err) {
      console.warn('[bnWS] Seed failed, keeping the previous cache until the next reconcile:', err.message);
    }
    lastWsMessage = Date.now();
    startOrderReconcile();

    // 4. listenKey keepalive — PUT every 30 min (expires after 60 min)
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(async () => {
      try {
        const res = await fetch(`${BINANCE_BASE}/fapi/v1/listenKey`, {
          method: 'PUT',
          headers: { 'X-MBX-APIKEY': BINANCE_API_KEY }
        });
        // An unchecked PUT was the point of failure: once the key expires the stream goes
        // quiet without closing, so the failure has to force a reconnect.
        if (!res.ok) throw new Error(`listenKey keepalive → ${res.status}`);
      } catch (err) {
        console.warn('[bnWS] keepalive failed:', err.message, '— reconnecting');
        try { bnWs?.terminate(); } catch (_) {}
      }
    }, 30 * 60 * 1000);
  });

  bnWs.on('ping', () => { lastWsMessage = Date.now(); });

  bnWs.on('message', raw => {
    lastWsMessage = Date.now();
    let evt;
    try { evt = JSON.parse(raw); } catch (_) { return; }

    if (evt.e === 'listenKeyExpired') {
      console.warn('[bnWS] listenKey expired — reconnecting');
      try { bnWs.terminate(); } catch (_) {}
      return;
    }

    // Only handle regular order updates (algo orders stay on REST)
    if (evt.e !== 'ORDER_TRADE_UPDATE') return;

    const o      = evt.o;                // order object inside the event
    const id     = o.i;                  // orderId
    const status = o.X;                  // order status string

    if (status === 'NEW') {
      // Add to cache — reconstruct into a REST-compatible shape for normaliseBnOrder
      const synthetic = {
        orderId:      id,
        symbol:       o.s,
        side:         o.S,
        type:         o.o,
        price:        o.p,
        origQty:      o.q,
        stopPrice:    o.sp,
        positionSide: o.ps,
        closePosition: o.cp,
        reduceOnly:   o.R
      };
      // Remove any stale entry first (order updates can arrive out of order)
      bnOrderCache = bnOrderCache.filter(c => c.orderId !== id);
      bnOrderCache.push(normaliseBnOrder(synthetic));

    } else if (status === 'PARTIALLY_FILLED') {
      // Update remaining quantity — sizeRaw drives the stress simulator, so it has to
      // track the fill, not just the label.
      const remaining = parseFloat(o.q) - parseFloat(o.z);  // origQty - cumQty
      const { base }  = splitSymbol(o.s);
      bnOrderCache = bnOrderCache.map(c =>
        c.orderId === id
          ? { ...c, size: `${remaining} ${base}`, sizeRaw: Math.abs(remaining) }
          : c
      );

    } else if (status !== 'NEW' && status !== 'PARTIALLY_FILLED') {
      // Anything that is not open any more leaves the cache. Listing terminal statuses
      // meant a new one — EXPIRED_IN_MATCH, added for self-trade prevention — would leave
      // the order on screen forever.
      bnOrderCache = bnOrderCache.filter(c => c.orderId !== id);
    }
  });

  bnWs.on('error', err => {
    // 'error' is not guaranteed to be followed by 'close', and when it is not the socket is
    // simply dead: an ECONNRESET here once froze the order cache for three days.
    console.error('[bnWS] WebSocket error:', err.message, '— forcing reconnect');
    try { bnWs.terminate(); } catch (_) {}
    if (!reconnectTimeout) reconnectTimeout = setTimeout(startBinanceUserDataStream, 5_000);
  });

  bnWs.on('close', (code, reason) => {
    console.warn(`[bnWS] Connection closed (${code}) — reconnecting in 5s`);
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
    reconnectTimeout = setTimeout(startBinanceUserDataStream, 5_000);
  });
}

// A websocket-fed cache drifts the moment one event is missed, and nothing in the stream
// tells you it happened: a phantom order simply stays on screen. This re-reads the
// authoritative snapshot on a timer so the cache is self-healing regardless of stream
// health, and says so when it finds a difference.
let reconcileTimer = null;
let lastReconcile = { at: null, added: 0, removed: 0 };

async function reconcileOrders(reason = 'timer') {
  try {
    const snapshot = await binanceFetch('/fapi/v1/openOrders');
    const fresh = (Array.isArray(snapshot) ? snapshot : []).map(normaliseBnOrder);

    const before = new Set(bnOrderCache.map(o => o.orderId));
    const after = new Set(fresh.map(o => o.orderId));
    const added = fresh.filter(o => !before.has(o.orderId)).length;
    const removed = [...before].filter(id => !after.has(id)).length;

    bnOrderCache = fresh;
    lastReconcile = { at: Date.now(), added, removed, reason };
    if (added || removed) {
      console.warn(`[orders] reconciled (${reason}): ${added} missing, ${removed} stale — `
        + `the stream had drifted from the exchange`);
    }
  } catch (err) {
    console.warn('[orders] reconcile failed:', err.message);
  }
}

function startOrderReconcile() {
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = setInterval(() => reconcileOrders('timer'), 60_000);
}

// Only the REST half is shared: regular orders are rebuilt from bnOrderCache on every read,
// so the websocket's freshness is not held back by the snapshot.
const bnRaw = sharedSnapshot(() => Promise.all([
  binanceFetch('/fapi/v2/account'),
  binanceFetch('/fapi/v2/positionRisk'),
  bnPublic('/fapi/v1/premiumIndex').catch(err => { console.warn('[funding]', err.message); return []; }),
  binanceFetch('/fapi/v1/openAlgoOrders').catch(() => []),
  refreshFundingMeta()
]));

async function getBinanceData(opts) {
  // Regular open orders are served from bnOrderCache (kept live by WS).
  // Algo/conditional orders (TP/SL, trailing stop) remain on REST — they are
  // low-weight and not covered by ORDER_TRADE_UPDATE events.
  const [account, positions, premiumIndex, rawAlgo] = await bnRaw(opts);

  const fundingMap = {}, nextFundingMap = {};
  (Array.isArray(premiumIndex) ? premiumIndex : []).forEach(p => {
    fundingMap[p.symbol] = parseFloat(p.lastFundingRate || 0) * 100;
    nextFundingMap[p.symbol] = p.nextFundingTime || null;
  });

  // Binance reports maintenance margin per position on /fapi/v2/account — keyed here
  // so the stress engine can be calibrated against the exchange's own numbers.
  const reportedMm = {};
  const reportedIm = {};
  (account.positions || []).forEach(p => {
    reportedMm[`${p.symbol}:${p.positionSide}`] = parseFloat(p.maintMargin || 0);
    reportedIm[`${p.symbol}:${p.positionSide}`] = parseFloat(p.positionInitialMargin || 0);
  });

  const openPositions = positions
    .filter(p => parseFloat(p.positionAmt) !== 0)
    .map(p => {
      const size     = parseFloat(p.positionAmt);
      const entry    = parseFloat(p.entryPrice);
      const mark     = parseFloat(p.markPrice);
      const liqPx    = parseFloat(p.liquidationPrice);
      const upnl     = parseFloat(p.unRealizedProfit);
      const notional = Math.abs(parseFloat(p.notional));
      const leverage = parseInt(p.leverage);
      const funding  = fundingMap[p.symbol] ?? 0;
      const fundingSign = funding >= 0 ? '+' : '';
      // Settlements per day vary by symbol — 8h, 4h and 1h all exist — so the daily figure
      // cannot assume three a day.
      const intervalHours = fundingMeta[p.symbol]?.intervalHours ?? 8;
      const positionSide = p.positionSide || 'BOTH';
      const { base, quote } = splitSymbol(p.symbol);
      return {
        pair:        `${base}/${quote}`,
        asset:       base,
        quote,
        symbol:      p.symbol,
        positionSide,
        sizeRaw:     size,
        leverageRaw: leverage,
        isolated:    (p.marginType || '').toLowerCase() === 'isolated',
        isolatedWallet: parseFloat(p.isolatedWallet || 0),
        reportedMm:  reportedMm[`${p.symbol}:${positionSide}`] ?? null,
        reportedIm:  reportedIm[`${p.symbol}:${positionSide}`] ?? null,
        reportedLiqPrice: liqPx,
        prevDayPx:   0,
        type:        'futures',
        side:        size > 0 ? 'Long' : 'Short',
        leverage:    `${leverage}×`,
        size:        `${Math.abs(size)} ${base}`,
        sizeUsd:     notional,
        entry,
        mark,
        liqPrice:    liqPx,
        upnl,
        fundingRate: funding,
        funding8h:   `${fundingSign}${funding.toFixed(4)}%`,
        fundingIntervalHours: intervalHours,
        fundingPerDayPct: +(funding * 24 / intervalHours).toFixed(5),
        nextFundingTime: nextFundingMap[p.symbol] ?? null,
        adlQuantile: p.adlQuantile ?? null,
        exchange:    'binance'
      };
    });

  // Regular orders come from WS cache — strip the internal orderId before sending
  const regularOrders = bnOrderCache.map(({ orderId, ...rest }) => rest);

  // Normalise algo/conditional orders — different shape: algoId, orderType, triggerPrice, quantity
  // These are TP/SL and trailing-stop orders placed via the algo endpoint.
  const algoOrders = (Array.isArray(rawAlgo) ? rawAlgo : []).map(o => {
    const { base: asset, quote } = splitSymbol(o.symbol);
    const rawType    = o.orderType || o.algoType || 'Conditional';
    const typeStr    = rawType.charAt(0) + rawType.slice(1).toLowerCase().replace(/_/g, ' ');
    const triggerPx  = parseFloat(o.triggerPrice || 0);
    const limitPx    = parseFloat(o.price || 0);
    return {
      pair:         `${asset}/${quote}`,
      asset,
      quote,
      symbol:       o.symbol,
      positionSide: o.positionSide || 'BOTH',
      side:         o.side === 'BUY' ? 'Buy' : 'Sell',
      type:         typeStr,
      price:        limitPx > 0 ? limitPx : 0,
      stopPrice:    triggerPx > 0 ? triggerPx : null,
      size:         `${parseFloat(o.quantity || 0)} ${asset}`,
      sizeRaw:      Math.abs(parseFloat(o.quantity || 0)),
      closePosition: o.closePosition || false,
      reduceOnly:   o.reduceOnly || o.closePosition || false,
      exchange:     'binance'
    };
  });

  const openOrders = [...regularOrders, ...algoOrders];

  // Equity is the margin balance — wallet plus unrealised PnL. The wallet alone overstated a
  // book carrying a large unrealised loss by nearly 4×, and stop sizing risked a share of it.
  const walletBalance = parseFloat(account.totalWalletBalance || 0);
  const equity      = parseFloat(account.totalMarginBalance ?? account.totalWalletBalance ?? 0);
  const marginUsed  = parseFloat(account.totalInitialMargin || 0);
  const marginPct   = equity > 0 ? ((marginUsed / equity) * 100).toFixed(1) : '0.0';
  const availBal    = parseFloat(account.availableBalance || 0);
  const maintMargin = parseFloat(account.totalMaintMargin || 0);
  const freeMargin  = availBal;

  // Cross-pool collateral is crossWalletBalance — totalWalletBalance also contains
  // wallets pledged to isolated positions, which do not back the cross pool.
  // Per collateral asset: with multi-assets margin off, each of these is an
  // independent cross pool with its own wallet, margin balance and maintenance margin.
  const marginAssets = {};
  (account.assets || []).forEach(a => {
    const wallet = parseFloat(a.crossWalletBalance || a.walletBalance || 0);
    const maint  = parseFloat(a.maintMargin || 0);
    if (Math.abs(wallet) < 1e-8 && maint < 1e-8) return;
    marginAssets[a.asset] = {
      wallet,
      marginBalance:           parseFloat(a.marginBalance || 0),
      maintMargin:             maint,
      initialMargin:           parseFloat(a.initialMargin || 0),
      positionInitialMargin:   parseFloat(a.positionInitialMargin || 0),
      openOrderInitialMargin:  parseFloat(a.openOrderInitialMargin || 0),
      availableBalance:        parseFloat(a.availableBalance || 0),
      maxWithdrawAmount:       parseFloat(a.maxWithdrawAmount || 0),
      unrealizedProfit:        parseFloat(a.unrealizedProfit || 0)
    };
  });

  const crossWalletBalance = parseFloat(account.totalCrossWalletBalance || account.totalWalletBalance || 0);
  const marginBalance      = parseFloat(account.totalMarginBalance || 0);
  const crossUnPnl         = parseFloat(account.totalCrossUnPnl ?? account.crossUnPnl ?? 0);
  const multiAssetsMode    = account.multiAssetsMargin === true;

  return {
    equity, walletBalance, marginPct, marginUsed, freeMargin, availBal, maintMargin, openPositions, openOrders,
    crossWalletBalance, marginBalance, crossUnPnl, multiAssetsMode, marginAssets
  };
}

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

// Concurrent callers asking for the same series share one request: the two legs of a hedge
// are the same symbol, and fanned out in parallel they would otherwise both fetch.
const inflight = new Map();

function once(key, fn) {
  if (!inflight.has(key)) inflight.set(key, fn().finally(() => inflight.delete(key)));
  return inflight.get(key);
}

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

function getBinanceKlines(symbol) {
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

function getHlCandles(coin) {
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

function buildSummary(hlData, bnData) {
  const allPositions = [...hlData.openPositions, ...bnData.openPositions];
  const totalEquity  = hlData.equity + bnData.equity;
  const totalUpnl    = allPositions.reduce((s, p) => s + p.upnl, 0);
  const hlExposure   = hlData.openPositions.reduce((s, p) => s + p.sizeUsd, 0);
  const bnExposure   = bnData.openPositions.reduce((s, p) => s + p.sizeUsd, 0);
  const orderCount   = hlData.openOrders.length + bnData.openOrders.length;

  return {
    totalEquity:   totalEquity.toFixed(2),
    totalUpnl:     totalUpnl.toFixed(2),
    positionCount: allPositions.length,
    orderCount,
    hlExposure:    hlExposure.toFixed(2),
    bnExposure:    bnExposure.toFixed(2),
    totalExposure: (hlExposure + bnExposure).toFixed(2),
  };
}

app.get('/api/dashboard', async (req, res) => {
  try {
    const [hlData, bnData] = await Promise.all([
      getHyperliquidData(),
      getBinanceData()
    ]);

    const summary = buildSummary(hlData, bnData);

    res.json({
      ok: true,
      lastUpdated: new Date().toISOString(),
      summary,
      hyperliquid: {
        equity:          hlData.equity.toFixed(2),
        marginPct:       hlData.marginPct,
        marginUsed:      hlData.marginUsed.toFixed(2),
        freeMargin:      hlData.freeMargin.toFixed(2),
        totalNtlPos:     hlData.totalNtlPos.toFixed(2),
        accountLeverage: hlData.accountLeverage,
        positions:       hlData.openPositions,
        orders:          hlData.openOrders
      },
      binance: {
        equity:      bnData.equity.toFixed(2),
        marginPct:   bnData.marginPct,
        marginUsed:  bnData.marginUsed.toFixed(2),
        freeMargin:  bnData.freeMargin.toFixed(2),
        maintMargin: bnData.maintMargin.toFixed(2),
        positions:   bnData.openPositions,
        orders:      bnData.openOrders
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Dynamic Stop Width endpoint ───────────────────────────────────────────
// Computes a composite-volatility-based stop + position size for every open
// position across both exchanges. Missing inputs are backfilled (synthetic candle
// series, neutral multipliers, equity fallbacks) so every position yields a stop;
// backfilled fields are tagged per-position for the UI.

// Derive the base asset symbol from a normalised pair label.
function baseAsset(pair) {
  return pair.replace(/-PERP$/i, '').replace(/\/(USDT?|USD)$/i, '').toUpperCase();
}

// Fetch candles for a position; backfill from position context if unavailable.
async function candlesForPosition(p) {
  let candles = null;
  if (p.exchange === 'binance') candles = await getBinanceKlines(p.symbol);
  else candles = await getHlCandles(p.coin || baseAsset(p.pair));

  if (candles && candles.length >= 21) return { candles, backfilled: false };

  // Backfill: synthesize a series from entry/mark/funding.
  const synth = vol.synthSeriesFromPosition({
    entry: p.entry, mark: p.mark, prevDayPx: p.prevDayPx,
    fundingRate8h: (p.fundingRate || 0) / 100
  });
  return { candles: synth, backfilled: true };
}

app.get('/api/volstops', async (req, res) => {
  try {
    const riskPct = Math.max(0, Math.min(0.5, parseFloat(req.query.risk) || 0.01));
    const k       = Math.max(0.1, Math.min(10, parseFloat(req.query.k) || 1.5));

    const [hlData, bnData] = await Promise.all([getHyperliquidData(), getBinanceData()]);

    const positions = [
      ...hlData.openPositions.map(p => ({ ...p, _equity: hlData.equity })),
      ...bnData.openPositions.map(p => ({ ...p, _equity: bnData.equity }))
    ];

    // BTC reference and every position's candles in one fan-out; `once` collapses the
    // duplicate requests the two legs of a hedge would otherwise make.
    const [bnBtc, ...candleSets] = await Promise.all([
      getBinanceKlines('BTCUSDT'),
      ...positions.map(p => candlesForPosition(p).catch(() => null))
    ]);
    let btcCandles = bnBtc;
    if (!btcCandles || btcCandles.length < 21) btcCandles = await getHlCandles('BTC');
    const btcAtrHistory = btcCandles ? vol.buildAtrSeries(btcCandles) : [];

    const totalEquity = (hlData.equity + bnData.equity) || 0;

    const results = [];
    const candlesByAsset = {};
    const volHistories = [];
    for (const [idx, p] of positions.entries()) {
      try {
        const backfilled = [];
        const { candles, backfilled: candlesBackfilled } = candleSets[idx] ?? await candlesForPosition(p);
        if (candlesBackfilled) backfilled.push('candles');

        // L1 ATR — with floor fallback if even synth fails to produce a value.
        let atrPct = vol.computeATR(candles);
        if (atrPct == null || !isFinite(atrPct)) {
          atrPct = 0.01;                       // 1% baseline floor
          if (!backfilled.includes('candles')) backfilled.push('atr');
        }

        // L2 BBW squeeze
        const bbwHistory = vol.buildBbwSeries(candles);
        const bbwAdj = vol.getBBWAdjustment(candles, bbwHistory);
        if (bbwHistory.length < 20) backfilled.push('bbw');

        // L3 Funding
        const fundingRate8h = (p.fundingRate ?? 0) / 100;   // dashboard stores raw %
        const fundingAdj = vol.getFundingAdjustment(fundingRate8h);
        if (p.fundingRate == null) backfilled.push('funding');

        // L4 Cross-asset
        let crossAdj = 1.0, crossCorr = 0, crossRatio = null;
        if (btcCandles && !candlesBackfilled) {
          const x = vol.getCrossAssetAdj(btcCandles, candles, btcAtrHistory);
          crossAdj = x.adj; crossCorr = x.corr; crossRatio = x.ratio;
        } else {
          backfilled.push('crossAsset');
        }

        // Composite + regime
        const compositeVol = vol.computeCompositeVol({
          atrPct, bbwAdj, fundingAdj, crossAssetAdj: crossAdj, kronosVol: null
        });
        const volSeries = vol.buildCompositeVolSeries(candles, { bbwAdj, fundingAdj, crossAssetAdj: crossAdj });
        if (volSeries.length < 10) backfilled.push('regimeHistory');
        const regimeLabel = vol.classifyRegime(compositeVol, volSeries);

        const assetKey = p.asset || baseAsset(p.pair);
        if (!candlesByAsset[assetKey] && !candlesBackfilled) candlesByAsset[assetKey] = candles;
        volHistories.push({ key: `${p.exchange}:${p.pair}:${p.side}`, series: volSeries,
                            weight: Math.abs(p.sizeUsd) || 1 });

        // Account size: live exchange equity; fall back to total then exposure.
        let accountSize = p._equity;
        if (!accountSize || accountSize <= 0) {
          accountSize = totalEquity > 0 ? totalEquity : (p.sizeUsd || 0);
          backfilled.push('equity');
        }

        const direction = p.side === 'Long' ? 'long' : 'short';
        const stop = vol.computeDynamicStop({
          entryPrice: p.entry,
          accountSize,
          riskPct,
          compositeVolPct: compositeVol,
          k,
          regimeLabel,
          direction
        });

        results.push({
          pair:        p.pair,
          exchange:    p.exchange,
          side:        p.side,
          entry:       p.entry,
          mark:        p.mark,
          ...stop,
          regimeLabel,
          allowTrend:   vol.shouldTakeEntry(regimeLabel, 'trend'),
          allowMeanRev: vol.shouldTakeEntry(regimeLabel, 'meanRev'),
          allowBreakout:vol.shouldTakeEntry(regimeLabel, 'breakout'),
          layers: {
            atrPct:    +(atrPct * 100).toFixed(3),
            bbwAdj:    +bbwAdj.toFixed(3),
            fundingAdj:+fundingAdj.toFixed(3),
            crossAdj:  +crossAdj.toFixed(3),
            crossCorr: +crossCorr.toFixed(3),
            crossRatio: crossRatio != null ? +crossRatio.toFixed(2) : null
          },
          accountSize: +accountSize.toFixed(2),
          backfilled
        });
      } catch (perr) {
        // Never let one position break the panel.
        results.push({
          pair: p.pair, exchange: p.exchange, side: p.side, entry: p.entry, mark: p.mark,
          error: perr.message, backfilled: ['error']
        });
      }
    }

    // ── Combined portfolio view ──
    const valid = results.filter(r => !r.error && r.compositeVolPct != null);
    const totalDollarRisk = valid.reduce((s, r) => s + (r.dollarRisk || 0), 0);
    const regimeCounts = { low: 0, medium: 0, high: 0, extreme: 0 };
    valid.forEach(r => { if (regimeCounts[r.regimeLabel] != null) regimeCounts[r.regimeLabel]++; });

    // Equity-weighted portfolio composite vol → portfolio regime.
    let wSum = 0, wVol = 0;
    valid.forEach(r => {
      const w = r.notionalValue || 1;
      wSum += w; wVol += (r.compositeVolPct || 0) * w;
    });
    const portfolioVol = wSum ? wVol / wSum : 0;

    // Classify against the portfolio's own history, not a cross-section of the positions
    // it is made of: a notional-weighted mean of N positions necessarily lands between
    // their 25th and 75th percentiles, so the old reading returned 'medium' for any book.
    const portfolioVolSeries = vol.weightedSeriesMean(volHistories);
    const portfolioRegime = vol.classifyRegime(portfolioVol / 100, portfolioVolSeries);
    const regimeBasis = portfolioVolSeries.length >= 10
      ? { bars: portfolioVolSeries.length,
          percentile: +(portfolioVolSeries.filter(v => v < portfolioVol / 100).length
                        / portfolioVolSeries.length * 100).toFixed(1) }
      : { bars: portfolioVolSeries.length, percentile: null };

    // ── Hedge-pair health ──
    // Correlation risk is BETWEEN assets. Netting per asset first means the two legs of a
    // same-symbol hedge collapse into a single delta (they cannot decorrelate from
    // themselves), and what remains is the book's real hedge structure: whatever is net
    // long against whatever is net short.
    const netByAsset = {};
    positions.forEach(p => {
      const a = p.asset || baseAsset(p.pair);
      const signed = (p.side === 'Long' ? 1 : -1) * (p.sizeUsd || 0);
      netByAsset[a] = (netByAsset[a] || 0) + signed;
    });

    const DUST = 50;   // residual delta too small to count as a hedge leg

    // Every net delta restated as BTC-equivalent, so legs of different volatility can be
    // matched against each other on comparable terms.
    const betaByAsset = {}, btcEquiv = {};
    for (const [asset, net] of Object.entries(netByAsset)) {
      const { x, y } = risk.alignedReturns(candlesByAsset[asset], btcCandles);
      betaByAsset[asset] = x.length > 2 ? +risk.beta(x, y).toFixed(3) : 1;
      btcEquiv[asset] = net * betaByAsset[asset];
    }

    const equivLongs  = Object.entries(btcEquiv).filter(([, v]) => v >  DUST);
    const equivShorts = Object.entries(btcEquiv).filter(([, v]) => v < -DUST);
    const { pairs: matched, unmatchedLong, unmatchedShort } =
      vol.matchHedgeLegs(equivLongs, equivShorts, DUST);

    const hedgePairs = matched.map(m => {
      const { x, y } = risk.alignedReturns(candlesByAsset[m.longAsset], candlesByAsset[m.shortAsset]);
      return {
        ...vol.assessHedgePair({ x, y, longAsset: m.longAsset, shortAsset: m.shortAsset }),
        longNet:  +netByAsset[m.longAsset].toFixed(2),
        shortNet: +netByAsset[m.shortAsset].toFixed(2),
        matchedBtcEquiv: +m.matched.toFixed(2)
      };
    }).sort((a, b) => (b.matchedBtcEquiv || 0) - (a.matchedBtcEquiv || 0));
    const hedgeWarnings = hedgePairs.filter(h => h.warning).map(h => ({ asset: `${h.longAsset}/${h.shortAsset}`, ...h }));

    // Same-symbol both-sides positions carry net delta but no correlation exposure —
    // reported so it is clear they were considered rather than skipped.
    const nettedSymbols = Object.entries(
      positions.reduce((acc, p) => {
        const a = p.asset || baseAsset(p.pair);
        (acc[a] = acc[a] || new Set()).add(p.side);
        return acc;
      }, {})
    ).filter(([, sides]) => sides.size > 1)
     .map(([asset]) => ({ asset, netDelta: +(netByAsset[asset] || 0).toFixed(2) }));

    // Whether the book is actually neutral. The unmatched leftover from the pairing is the
    // same quantity arrived at independently, so the two must agree.
    const rawNet = Object.values(netByAsset).reduce((s, v) => s + v, 0);
    const betaAdjustedNet = Object.values(btcEquiv).reduce((s, v) => s + v, 0);
    const nakedBtcEquiv = unmatchedLong - unmatchedShort;

    res.json({
      ok: true,
      lastUpdated: new Date().toISOString(),
      params: { riskPct, k },
      combined: {
        portfolioRegime,
        regimeBasis,
        portfolioVolPct: +portfolioVol.toFixed(3),
        totalDollarRisk: +totalDollarRisk.toFixed(2),
        totalEquity:     +totalEquity.toFixed(2),
        hlEquity:        +hlData.equity.toFixed(2),
        bnEquity:        +bnData.equity.toFixed(2),
        positionCount:   valid.length,
        regimeCounts,
        netByAsset,
        betaByAsset,
        rawNet:          +rawNet.toFixed(2),
        betaAdjustedNet: +betaAdjustedNet.toFixed(2),
        nakedBtcEquiv:   +nakedBtcEquiv.toFixed(2),
        unmatchedLong,
        unmatchedShort,
        nettedSymbols,
        hedgePairs,
        hedgeWarnings
      },
      positions: results
    });
  } catch (err) {
    console.error('[volstops]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Cross-pool stress simulator (Binance USDM) ────────────────────────────────
// Resolves the Binance cross-margin pool into the shape risk-engine.js consumes,
// calibrates the maintenance-margin model against the exchange's own reported
// numbers, and serves a baseline so the panel has something to show before the
// user touches a slider. All simulation itself happens in the browser against the
// same module, so dragging a price costs no network round-trip.

// Declared funding cadence per symbol. Checked against the cadence actually observed in the
// income history, because Binance's declared value can lag a change — LABUSDT settles hourly
// while fundingInfo still reports 4h.
const fundingMeta = {};
let fundingMetaAt = 0;

async function refreshFundingMeta() {
  if (Date.now() - fundingMetaAt < 6 * 60 * 60 * 1000) return fundingMeta;
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

// Lot step and tick, so any quantity a tool reports can actually be sent, and the account's
// real commission rate instead of a guessed one.
const symbolFilters = {};
let symbolFiltersAt = 0;
const commissionRates = {};

async function refreshSymbolFilters() {
  if (Date.now() - symbolFiltersAt < 24 * 60 * 60 * 1000) return symbolFilters;
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

async function commissionFor(symbol) {
  const hit = commissionRates[symbol];
  if (hit && Date.now() - hit.ts < 24 * 60 * 60 * 1000) return hit;
  try {
    const r = await binanceFetch('/fapi/v1/commissionRate', { symbol });
    commissionRates[symbol] = {
      maker: parseFloat(r.makerCommissionRate), taker: parseFloat(r.takerCommissionRate), ts: Date.now()
    };
  } catch (err) {
    commissionRates[symbol] = { maker: 0.0002, taker: 0.0005, ts: Date.now() - 23.5 * 3600e3, assumed: true };
  }
  return commissionRates[symbol];
}

// Order book snapshots, briefly cached: what the book can absorb right now, not what it will
// hold during a move.
const bookCache = {};
const BOOK_TTL_MS = 10_000;

async function getBook(symbol, limit = 50) {
  const hit = bookCache[symbol];
  if (hit && Date.now() - hit.ts < BOOK_TTL_MS) return hit.book;
  try {
    const d = await bnPublic(`/fapi/v1/depth?symbol=${symbol}&limit=${limit}`);
    if (!d) return hit?.book || null;
    const book = { bids: d.bids || [], asks: d.asks || [] };
    bookCache[symbol] = { book, ts: Date.now() };
    return book;
  } catch (err) {
    return hit?.book || null;
  }
}

const BRACKET_TTL_MS = 24 * 60 * 60 * 1000;
let bracketCache = { map: null, ts: 0 };

async function getBinanceLeverageBrackets() {
  if (bracketCache.map && Date.now() - bracketCache.ts < BRACKET_TTL_MS) return bracketCache.map;
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

// Fallback when the bracket table is unavailable: infer a flat rate from the one
// maintenance-margin number Binance reports per position. A single observation
// cannot separate rate from cum deduction, so cum is assumed 0 and the position is
// tagged estimated.
function inferredBrackets(p) {
  const notional = Math.abs(p.sizeRaw) * p.mark;
  const mmr = (p.reportedMm > 0 && notional > 0) ? p.reportedMm / notional : 0.005;
  return [{ notionalFloor: 0, notionalCap: 1e12, maintMarginRatio: mmr, cum: 0 }];
}

function toEnginePosition(p, info) {
  const hasTable = !!info?.brackets?.length;
  return {
    key:          `${p.symbol}:${p.positionSide}`,
    asset:        p.asset,
    symbol:       p.symbol,
    positionSide: p.positionSide,
    q:            p.sizeRaw,
    entry:        p.entry,
    mark:         p.mark,
    leverage:     p.leverageRaw || 1,
    brackets:     hasTable ? info.brackets : inferredBrackets(p),
    notionalCoef: info?.notionalCoef ?? 1,
    estimated:    !hasTable
  };
}

function toEngineOrder(o) {
  return {
    asset:        o.asset,
    positionSide: o.positionSide || 'BOTH',
    side:         o.side,
    q:            o.sizeRaw || 0,
    trigger:      o.stopPrice || o.price || 0,
    type:         o.type,
    closePosition: !!o.closePosition,
    reduceOnly:   !!o.reduceOnly
  };
}

// Per-asset beta to BTC and daily sigma, from the existing 1h candle cache. Candles
// are fetched by full symbol — ZECUSDC and ZECUSDT are separate books on the same
// underlying — and keyed by base asset, which is unique within one pool.
async function poolStats(positions) {
  // One fetch per asset, all in flight together. Serially this was the single largest cost
  // in the riskbook response.
  const unique = [...new Map(positions.map(p => [p.asset, p])).values()];
  const [btc, ...series] = await Promise.all([
    getBinanceKlines('BTCUSDT'),
    ...unique.map(p => getBinanceKlines(p.symbol))
  ]);

  const stats = {};
  unique.forEach((p, i) => {
    const candles = series[i];
    const own = candles ? vol.computeReturns(candles) : [];
    const { x, y } = risk.alignedReturns(candles, btc);
    stats[p.asset] = {
      dailySigmaPct: own.length > 2 ? +risk.dailySigmaPct(own).toFixed(3) : null,
      beta:          x.length > 2 ? +risk.beta(x, y).toFixed(3) : 1,
      bars:          candles?.length || 0,
      pairedBars:    x.length
    };
  });
  return stats;
}

// Binance applies MMR and cum per leg but brackets the tier on combined notional.
// Rather than trust that, both readings are scored against the maintenance margin the
// exchange reports per position and the closer one wins. Equity is checked against the
// asset's own marginBalance, so a wrong collateral base cannot pass silently.
function calibrate(pool, marks, positions, reported) {
  const reportedMm = positions
    .filter(p => p.reportedMm != null)
    .reduce((sum, p) => sum + p.reportedMm, 0);

  const combined = risk.evalPool(pool, marks);
  const perSide  = risk.evalPool(pool, marks, { perSideTiers: true });
  const errOf    = (model, ref) => ref > 0 ? Math.abs(model - ref) / ref * 100 : null;
  const cErr = errOf(combined.mm, reportedMm), pErr = errOf(perSide.mm, reportedMm);

  const tierMode = (pErr != null && cErr != null && pErr < cErr) ? 'perSide' : 'combined';
  const chosen   = tierMode === 'perSide' ? perSide : combined;
  const mmErr    = errOf(chosen.mm, reportedMm);
  const eqErr    = errOf(chosen.equity, reported?.marginBalance);
  const freeErr  = errOf(chosen.freeUsable, reported?.availableBalance);
  const reportedIm = positions.filter(p => p.reportedIm != null).reduce((sum, p) => sum + p.reportedIm, 0);
  const imErr      = errOf(chosen.im, reportedIm);

  return {
    tierMode,
    modelMm:     +chosen.mm.toFixed(4),
    reportedMm:  +reportedMm.toFixed(4),
    mmErrPct:    mmErr == null ? null : +mmErr.toFixed(3),
    modelEquity: +chosen.equity.toFixed(2),
    reportedEquity: reported?.marginBalance ?? null,
    equityErrPct: eqErr == null ? null : +eqErr.toFixed(3),
    modelIm:     +chosen.im.toFixed(4),
    reportedIm:  +reportedIm.toFixed(4),
    imErrPct:    imErr == null ? null : +imErr.toFixed(3),
    modelFree:   +chosen.freeUsable.toFixed(2),
    reportedFree: reported?.availableBalance ?? null,
    freeErrPct:  freeErr == null ? null : +freeErr.toFixed(3),
    freeAnchored: reported?.availableBalance > 0,
    freeReserved: +(pool.freeReserved || 0).toFixed(2),
    openOrderHold: reported?.openOrderInitialMargin ?? null,
    transferable: reported?.maxWithdrawAmount ?? null,
    trustworthy: mmErr != null && mmErr < 1 && (eqErr == null || eqErr < 1)
                 && (imErr == null || imErr < 1),
    estimatedBrackets: pool.positions.some(p => p.estimated),
    perPosition: chosen.positions.map(d => {
      const src = positions.find(p => `${p.symbol}:${p.positionSide}` === d.key);
      const rep = src?.reportedMm ?? null;
      return {
        key: d.key,
        modelMm:    +d.mm.toFixed(4),
        reportedMm: rep,
        errPct:     rep > 0 ? +(Math.abs(d.mm - rep) / rep * 100).toFixed(3) : null
      };
    })
  };
}

// Binance publishes an absurd sentinel (hundreds of millions) as the liquidation price
// of a position it considers unreachable — both legs of a flat hedge get one.
function reportedLiq(p) {
  const v = p.reportedLiqPrice;
  return (v > 0 && v < p.mark * 50) ? v : null;
}

// Cross-check: the pool-aware threshold should reproduce the liquidation price Binance
// reports, since their formula holds every other contract fixed exactly as this scan
// does. One caveat, and it is not an error: their published figure freezes each margin
// tier at the current notional, while their live engine re-tiers as notional moves
// ("MMR at the level of position notional"). Where a threshold crosses a bracket
// boundary the two legitimately differ, so both readings are reported — the frozen one
// is what validates the arithmetic, the re-tiered one is what should actually happen.
function liqCrossCheck(pool, marks, positions, opts) {
  const frozenPool = risk.freezeTiers(pool, marks);
  const cache = {}, frozenCache = {}, detailCache = {};
  return positions.map(p => {
    cache[p.asset]       = cache[p.asset]       || risk.killPrices(pool, p.asset, marks, opts);
    frozenCache[p.asset] = frozenCache[p.asset] || risk.killPrices(frozenPool, p.asset, marks, opts);
    // The closed form has no scan range, so it still validates when the threshold sits
    // beyond what killPrices will walk to.
    detailCache[p.asset] = detailCache[p.asset] || risk.liquidationDetail(pool, p.asset, marks, opts);
    const k   = cache[p.asset];
    const rep = reportedLiq(p);
    const candidates = [k.up, k.down].filter(v => v != null);
    const model = (rep && candidates.length)
      ? candidates.reduce((best, v) => Math.abs(v - rep) < Math.abs(best - rep) ? v : best)
      : (p.sizeRaw > 0 ? k.down : k.up);
    const side   = model == null ? null : (model === k.up ? 'up' : 'down');
    const f      = frozenCache[p.asset];
    const frozen = side === 'up' ? f.up : side === 'down' ? f.down : null;
    const err    = (a, b) => (a != null && b) ? +(Math.abs(a - b) / b * 100).toFixed(3) : null;

    const detail = detailCache[p.asset];
    return {
      key:              `${p.symbol}:${p.positionSide}`,
      modelKill:        model == null ? null : +model.toFixed(6),
      modelSide:        side,
      analyticKill:     detail.price == null ? null : +detail.price.toFixed(6),
      analyticErrPct:   (detail.price != null && rep) ? +(Math.abs(detail.price - rep) / rep * 100).toFixed(3) : null,
      illConditioned:   detail.illConditioned,
      movePerOnePctEquity: detail.movePerOnePctEquity ?? null,
      frozenKill:       frozen == null ? null : +frozen.toFixed(6),
      crossesTier:      model != null && risk.crossesTier(pool, p.asset, marks, model),
      reportedLiqPrice: rep,
      exchangeSaysUnreachable: p.reportedLiqPrice > 0 && rep == null,
      modelSaysUnreachable: !candidates.length,
      errPct:       err(model, rep),
      frozenErrPct: err(frozen, rep)
    };
  });
}

// One cross pool per collateral asset. With multi-assets margin off — the default —
// a USDC-margined contract is backed by the USDC wallet alone, so a USDT balance of any
// size is no protection at all. Multi-assets mode collapses them into one pool.
function buildPools(bn, brackets) {
  const cross  = bn.openPositions.filter(p => !p.isolated);
  const orders = bn.openOrders.filter(o => o.exchange === 'binance' && o.reduceOnly);

  const groups = bn.multiAssetsMode
    ? [{ marginAsset: 'MULTI', positions: cross, orders,
         reported: { wallet: bn.crossWalletBalance, marginBalance: bn.marginBalance,
                     maintMargin: bn.maintMargin, availableBalance: bn.availBal } }]
    : [...new Set(cross.map(p => p.quote))].map(quote => ({
        marginAsset: quote,
        positions:   cross.filter(p => p.quote === quote),
        orders:      orders.filter(o => o.quote === quote),
        reported:    bn.marginAssets[quote] || null
      }));

  return groups.map(g => ({
    ...g,
    pool: {
      collateral:   g.reported?.wallet ?? 0,
      freeReserved: g.reported?.openOrderInitialMargin ?? 0,
      positions:    g.positions.map(p => toEnginePosition(p, brackets?.[p.symbol])),
      orders:       g.orders.map(toEngineOrder)
    }
  }));
}

function marksOf(positions) {
  const marks = {};
  positions.forEach(p => { marks[p.asset] = p.mark; });
  return marks;
}

// Anchor the price-invariant hold to the exchange's own availableBalance. Position initial
// margin — the part that moves with price — is modelled exactly and checked separately, so
// this anchor cannot hide an error in the simulation itself.
function anchorFreeReserved(group) {
  const { pool, reported } = group;
  const marks = marksOf(group.positions);
  const atMarks = risk.evalPool({ ...pool, freeReserved: 0 }, marks);
  if (Number.isFinite(reported?.availableBalance)) {
    pool.freeReserved = atMarks.equity - atMarks.im - reported.availableBalance;
  }
  return group;
}

async function resolvePools(opts) {
  const [bn, brackets] = await Promise.all([getBinanceData(opts), getBinanceLeverageBrackets()]);
  return { bn, pools: buildPools(bn, brackets).map(anchorFreeReserved) };
}

async function describePool(group) {
  const { pool, positions, marginAsset, reported } = group;
  const marks = marksOf(positions);

  const calibration = calibrate(pool, marks, positions, reported);
  const opts   = { perSideTiers: calibration.tierMode === 'perSide' };
  const stats  = await poolStats(positions);
  const state  = risk.evalPool(pool, marks, opts);
  const deltas = risk.netDeltas(pool, marks);

  const frozenPool = risk.freezeTiers(pool, marks);
  const baseline = Object.keys(marks).map(asset => {
    const both = risk.killPricesBoth(pool, asset, marks, opts);
    const k = both.buffer, f = both.free;
    const d = risk.drainPer1Pct(pool, asset, marks, opts);
    const crossUp   = k.up   != null && risk.crossesTier(pool, asset, marks, k.up);
    const crossDown = k.down != null && risk.crossesTier(pool, asset, marks, k.down);
    const frozen = (crossUp || crossDown) ? risk.killPrices(frozenPool, asset, marks, opts) : null;
    const sigma   = stats[asset]?.dailySigmaPct || null;
    const inSigma = pct => (pct == null || !sigma) ? null : +(Math.abs(pct) / sigma).toFixed(2);
    return {
      asset,
      mark:        marks[asset],
      netDelta:    +(deltas[asset] || 0).toFixed(2),
      killUp:      k.up   == null ? null : +k.up.toFixed(6),
      killDown:    k.down == null ? null : +k.down.toFixed(6),
      killUpPct:   k.upPct   == null ? null : +k.upPct.toFixed(2),
      killDownPct: k.downPct == null ? null : +k.downPct.toFixed(2),
      sigmaUp:     inSigma(k.upPct),
      sigmaDown:   inSigma(k.downPct),
      safeUpBuffer:   k.up   == null ? +k.minBufferUp.toFixed(2)   : null,
      safeDownBuffer: k.down == null ? +k.minBufferDown.toFixed(2) : null,
      drainUp:     +d.up.toFixed(2),
      drainDown:   +d.down.toFixed(2),
      freeZeroUp:     f.up   == null ? null : +f.up.toFixed(6),
      freeZeroDown:   f.down == null ? null : +f.down.toFixed(6),
      freeZeroUpPct:  f.upPct   == null ? null : +f.upPct.toFixed(2),
      freeZeroDownPct:f.downPct == null ? null : +f.downPct.toFixed(2),
      freeDrainUp:    +d.freeUp.toFixed(2),
      freeDrainDown:  +d.freeDown.toFixed(2),
      crossesTierUp:   crossUp,
      crossesTierDown: crossDown,
      killUpFrozen:    crossUp   && frozen?.up   != null ? +frozen.up.toFixed(6)   : null,
      killDownFrozen:  crossDown && frozen?.down != null ? +frozen.down.toFixed(6) : null,
      scannedUpPct:    +k.scannedUpPct.toFixed(1),
      scannedDownPct:  +k.scannedDownPct.toFixed(1)
    };
  }).sort((a, b) => {
    const near = x => Math.min(
      x.killUpPct   == null ? Infinity : Math.abs(x.killUpPct),
      x.killDownPct == null ? Infinity : Math.abs(x.killDownPct)
    );
    return near(a) - near(b);
  });

  const hedgedSymbols = [...new Set(
    positions
      .filter(p => positions.some(q => q.symbol === p.symbol && Math.sign(q.sizeRaw) !== Math.sign(p.sizeRaw)))
      .map(p => p.symbol)
  )];

  // Depth, lot filters and the real commission rate, so the unwind tools price a close the
  // way it would actually fill instead of assuming the mark.
  // One round-trip per asset, not one per position, and all of them in parallel — served
  // sequentially this added seconds to a panel that has to feel instant.
  await refreshSymbolFilters();
  const byAsset = [...new Map(positions.map(p => [p.asset, p])).values()];
  const fetched = await Promise.all(byAsset.map(async p => ({
    asset: p.asset,
    book: await getBook(p.symbol),
    fee: await commissionFor(p.symbol),
    filter: symbolFilters[p.symbol] || null
  })));
  const books = {}, filters = {}, fees = {};
  for (const f of fetched) { books[f.asset] = f.book; fees[f.asset] = f.fee; filters[f.asset] = f.filter; }

  return {
    marginAsset,
    pool,
    marks,
    opts,
    stats,
    baseline,
    hedgedSymbols,
    books,
    filters,
    fees,
    adl: positions.map(p => ({ key: `${p.symbol}:${p.positionSide}`, asset: p.asset,
                               side: p.side, quantile: p.adlQuantile ?? null })),
    reported,
    calibration,
    liqCheck: liqCrossCheck(pool, marks, positions, opts),
    state: {
      equity:      +state.equity.toFixed(2),
      mm:          +state.mm.toFixed(2),
      im:          +state.im.toFixed(2),
      free:        +state.freeUsable.toFixed(2),
      buffer:      +state.buffer.toFixed(2),
      usedPct:     +state.usedPct.toFixed(2),
      marginRatio: +state.marginRatio.toFixed(4),
      liquidated:  state.liquidated
    }
  };
}

app.get('/api/riskbook', async (req, res) => {
  try {
    const { bn, pools: groups } = await resolvePools(req.query.fresh === '1' ? { maxAgeMs: 0 } : undefined);
    const pools = await Promise.all(groups.map(describePool));

    res.json({
      ok: true,
      lastUpdated: new Date().toISOString(),
      pools,
      account: {
        crossWalletBalance:  +bn.crossWalletBalance.toFixed(2),
        marginBalance:       +bn.marginBalance.toFixed(2),
        availableBalance:    +bn.availBal.toFixed(2),
        reportedMaintMargin: +bn.maintMargin.toFixed(2),
        multiAssetsMode:     bn.multiAssetsMode,
        marginAssets:        bn.marginAssets,
        orderFeed: {
          lastReconcileAt: lastReconcile.at,
          lastDrift: lastReconcile.added + lastReconcile.removed,
          lastWsMessageAgeSec: lastWsMessage ? Math.round((Date.now() - lastWsMessage) / 1000) : null
        }
      },
      isolated: bn.openPositions.filter(p => p.isolated).map(p => ({
        pair: p.pair, asset: p.asset, side: p.side, wallet: p.isolatedWallet,
        liqPrice: reportedLiq(p), upnl: p.upnl
      }))
    });
  } catch (err) {
    console.error('[riskbook]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Account history sync ──────────────────────────────────────────────────────
// Binance keeps income for three months and serves fills only through `fromId` paging, so
// the history is cached locally and topped up. Both datasets dedupe on their own ids, which
// means an overlapping refetch is harmless and the cursors are an optimisation rather than
// a correctness requirement.

const DATA_DIR    = process.env.DASHBOARD_DATA_DIR || path.join(__dirname, 'data');
const INCOME_FILE = path.join(DATA_DIR, 'income.ndjson');
const META_FILE   = path.join(DATA_DIR, 'meta.json');
const INCOME_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

let syncState = { running: false, startedAt: null, finishedAt: null, phase: 'idle',
                  symbolsDone: 0, symbolsTotal: 0, incomeAdded: 0, tradesAdded: 0, error: null };

const incomeKey = r => `${r.tranId}:${r.incomeType}:${r.symbol || ''}:${r.time}`;

async function syncIncome(meta) {
  // Resume a little before the cursor: a record can land with a timestamp just behind the
  // last one seen, and the dedupe makes the overlap free.
  const from = meta.lastIncomeTime ? meta.lastIncomeTime - 60_000 : Date.now() - INCOME_WINDOW_MS;
  let added = 0, newest = meta.lastIncomeTime || 0;

  for (let page = 1; page <= 60; page++) {
    await throttleWeight();
    const batch = await binanceFetch('/fapi/v1/income', { startTime: from, limit: 1000, page });
    if (!Array.isArray(batch) || !batch.length) break;

    added += store.appendNdjson(INCOME_FILE, batch, incomeKey).added;
    for (const r of batch) newest = Math.max(newest, r.time);
    if (batch.length < 1000) break;
  }

  meta.lastIncomeTime = newest || meta.lastIncomeTime;
  return added;
}

async function syncTradesFor(symbol, meta) {
  meta.trades = meta.trades || {};
  const file = store.tradesFile(DATA_DIR, symbol);
  let fromId = (meta.trades[symbol] || 0) + 1;
  let added = 0;

  for (let page = 0; page < 40; page++) {
    await throttleWeight();
    const batch = await binanceFetch('/fapi/v1/userTrades', { symbol, limit: 1000, fromId });
    if (!Array.isArray(batch) || !batch.length) break;

    added += store.appendNdjson(file, batch, t => t.id).added;
    const last = batch[batch.length - 1].id;
    meta.trades[symbol] = Math.max(meta.trades[symbol] || 0, last);
    if (batch.length < 1000) break;
    fromId = last + 1;
  }
  return added;
}

// A symbol needs syncing when it has never been pulled, or when it has traded recently.
// Walking all 81 every time costs 44s of round-trips to add nothing; this keeps a routine
// refresh to a handful of calls while a first build still covers everything.
function symbolsToSync(meta, recentMs = 7 * 24 * 60 * 60 * 1000) {
  const cutoff = Date.now() - recentMs;
  const everSeen = new Set();
  const recent = new Set();

  for (const r of store.readNdjson(INCOME_FILE)) {
    if (!r.symbol) continue;
    everSeen.add(r.symbol);
    if (r.time >= cutoff) recent.add(r.symbol);
  }

  const cursors = meta.trades || {};
  const never = [...everSeen].filter(s => cursors[s] == null);
  return { all: [...everSeen].sort(), due: [...new Set([...never, ...recent])].sort() };
}

async function runHistorySync(req_full = false) {
  if (syncState.running) return syncState;
  syncState = { running: true, startedAt: Date.now(), finishedAt: null, phase: 'income',
                symbolsDone: 0, symbolsTotal: 0, symbolsKnown: 0, full: req_full,
                incomeAdded: 0, tradesAdded: 0, error: null };

  try {
    const meta = store.readJson(META_FILE, {});
    syncState.incomeAdded = await syncIncome(meta);
    store.writeJson(META_FILE, meta);

    const open = (await getBinanceData()).openPositions.map(p => p.symbol);
    const { all, due } = symbolsToSync(meta);
    const symbols = [...new Set([...(req_full ? all : due), ...open])];
    syncState.phase = 'trades';
    syncState.symbolsTotal = symbols.length;
    syncState.symbolsKnown = all.length;

    for (const symbol of symbols) {
      syncState.tradesAdded += await syncTradesFor(symbol, meta);
      syncState.symbolsDone++;
      if (syncState.symbolsDone % 10 === 0) store.writeJson(META_FILE, meta);
    }
    store.writeJson(META_FILE, meta);
    syncState.phase = 'done';
  } catch (err) {
    console.error('[sync]', err);
    syncState.error = err.message;
    syncState.phase = 'failed';
  } finally {
    syncState.running = false;
    syncState.finishedAt = Date.now();
  }
  return syncState;
}

// Starts a sync when idle and reports progress; the panel polls the same URL.
app.get('/api/history/sync', async (req, res) => {
  if (req.query.start === 'true' && !syncState.running) runHistorySync(req.query.full === 'true');
  res.json({
    ok: true,
    state: syncState,
    store: store.storeStats(DATA_DIR),
    meta: store.readJson(META_FILE, {})
  });
});

// ── Performance analytics ─────────────────────────────────────────────────────
// Reads only the local cache; a sync is what refreshes it. Round trips are rebuilt from
// fills, so the whole 82-file corpus is parsed once and held until the next sync.

let analyticsCache = null;   // { key, built }

function buildAnalytics() {
  const income = store.readNdjson(INCOME_FILE);
  const symbols = store.storeStats(DATA_DIR).symbols;

  let trips = [], stillOpen = [], nonQuoteFees = 0;
  const orphans = { fills: 0, realized: 0, commission: 0 };
  const fillTimes = [];
  let maker = 0, taker = 0, makerFee = 0, takerFee = 0;

  for (const symbol of symbols) {
    const fills = store.readNdjson(store.tradesFile(DATA_DIR, symbol));
    const r = ta.buildRoundTrips(fills);
    trips = trips.concat(r.trips);
    stillOpen = stillOpen.concat(r.stillOpen);
    nonQuoteFees += r.nonQuoteFees;
    orphans.fills += r.orphans.fills;
    orphans.realized += r.orphans.realized;
    orphans.commission += r.orphans.commission;

    // aggregated here rather than holding 20k fill objects for the life of the cache
    for (const f of fills) {
      const fee = Math.abs(parseFloat(f.commission) || 0);
      if (f.maker) { maker++; makerFee += fee; } else { taker++; takerFee += fee; }
      fillTimes.push(f.time);
    }
  }

  const total = maker + taker;
  const execution = {
    maker, taker, fills: total,
    makerPct: total ? +(maker / total * 100).toFixed(1) : null,
    makerFee: +makerFee.toFixed(2), takerFee: +takerFee.toFixed(2),
    totalFee: +(makerFee + takerFee).toFixed(2),
    firstFill: fillTimes.length ? fillTimes.reduce((a, b) => Math.min(a, b)) : null,
    lastFill: fillTimes.length ? fillTimes.reduce((a, b) => Math.max(a, b)) : null
  };
  return { income, symbols, trips, stillOpen, nonQuoteFees, orphans, execution };
}

function analytics() {
  const meta = store.readJson(META_FILE, {});
  const key = `${meta.lastIncomeTime || 0}:${Object.keys(meta.trades || {}).length}:${syncState.finishedAt || 0}`;
  if (analyticsCache?.key === key) return analyticsCache.built;
  const built = buildAnalytics();
  analyticsCache = { key, built };
  return built;
}

app.get('/api/performance', (req, res) => {
  try {
    const { income, trips, stillOpen, nonQuoteFees, orphans, execution } = analytics();
    if (!income.length && !trips.length) {
      return res.json({ ok: true, empty: true,
                        hint: 'No cached history yet — run a sync first.' });
    }

    const days = parseInt(req.query.days, 10);
    const cutoff = days > 0 ? Date.now() - days * 86_400_000 : 0;
    const inWindow = trips.filter(t => t.closeTime >= cutoff);
    const incomeWindow = income.filter(r => r.time >= cutoff);

    const equity = ta.equityCurve(incomeWindow);
    const totals = ta.incomeTotals(incomeWindow);

    res.json({
      ok: true,
      lastUpdated: new Date().toISOString(),
      window: { days: days > 0 ? days : null,
                from: incomeWindow.length ? new Date(incomeWindow.reduce((m, r) => Math.min(m, r.time), Infinity)).toISOString() : null,
                tripsFrom: inWindow.length ? new Date(inWindow.reduce((m, t) => Math.min(m, t.openTime), Infinity)).toISOString() : null },
      overall: ta.summarise(inWindow),
      behaviour: ta.behaviourSplit(inWindow),
      bySymbol: ta.bySymbol(inWindow),
      equity,
      calendar: ta.calendar(incomeWindow),
      totals: totals.totals,
      feeDragPct: totals.feeDragPct,
      nonQuoteFees: +nonQuoteFees.toFixed(4),
      stillOpen: stillOpen.length,
      orphans: { fills: orphans.fills, realized: +orphans.realized.toFixed(2), commission: +orphans.commission.toFixed(2) },

      // journal sections
      holdTime: ta.byHoldTime(inWindow),
      dayOfWeek: ta.byDayOfWeek(inWindow),
      hourOfDay: ta.byHourOfDay(inWindow),
      side: ta.bySide(inWindow),
      month: ta.byMonth(inWindow),
      streaks: ta.streaks(inWindow),
      sequence: ta.sequenceEffect(inWindow),
      size: ta.sizeDistribution(inWindow),
      execution,
      records: ta.records(inWindow, equity),
      fundingBySymbol: Object.entries(incomeWindow
          .filter(r => r.incomeType === 'FUNDING_FEE' && r.symbol)
          .reduce((acc, r) => { acc[r.symbol] = (acc[r.symbol] || 0) + parseFloat(r.income); return acc; }, {}))
        .map(([symbol, v]) => ({ symbol, funding: +v.toFixed(2) }))
        .sort((a, b) => a.funding - b.funding),
      feesBySymbol: Object.entries(incomeWindow
          .filter(r => r.incomeType === 'COMMISSION' && r.symbol)
          .reduce((acc, r) => { acc[r.symbol] = (acc[r.symbol] || 0) + Math.abs(parseFloat(r.income)); return acc; }, {}))
        .map(([symbol, v]) => ({ symbol, fees: +v.toFixed(2) }))
        .sort((a, b) => b.fees - a.fees),

      worstTrips: [...inWindow].sort((a, b) => a.net - b.net).slice(0, 10),
      bestTrips: [...inWindow].sort((a, b) => b.net - a.net).slice(0, 10),
      recentTrips: [...inWindow].sort((a, b) => b.closeTime - a.closeTime).slice(0, 25),
      syncedAt: syncState.finishedAt
    });
  } catch (err) {
    console.error('[performance]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Hedge ledger ──────────────────────────────────────────────────────────────
app.get('/api/hedgeledger', async (req, res) => {
  try {
    const { bn, pools: groups } = await resolvePools();
    const { income } = analytics();

    const pools = groups.map(g => {
      const marks = marksOf(g.positions);
      const { tierMode } = calibrate(g.pool, marks, g.positions, g.reported);
      const opts = { perSideTiers: tierMode === 'perSide' };
      const ledger = risk.lockedPnl(g.pool, marks);
      const state = risk.evalPool(g.pool, marks, opts);

      // carry, using the settlement cadence actually observed rather than the declared one
      const carry = g.positions.map(p => {
        const observed = ta.inferFundingInterval(income, p.symbol);
        const hours = observed.inferredHours ?? fundingMeta[p.symbol]?.intervalHours ?? 8;
        const rate = (p.fundingRate ?? 0) / 100;
        const perDay = (p.side === 'Long' ? -1 : 1) * rate * p.sizeUsd * (24 / hours);
        return { key: `${p.symbol}:${p.positionSide}`, asset: p.asset, side: p.side,
                 notional: +p.sizeUsd.toFixed(2), ratePct: +(rate * 100).toFixed(5),
                 intervalHours: hours,
                 declaredHours: fundingMeta[p.symbol]?.intervalHours ?? null,
                 observedHours: observed.inferredHours,
                 settlementsSeen: observed.settlements,
                 perDay: +perDay.toFixed(2) };
      });

      return {
        marginAsset: g.marginAsset,
        ...ledger,
        inflation: risk.marginUnderMove(g.pool, marks, [0, 25, 50, 100, 200], opts),
        carryPerDay: +carry.reduce((s, c) => s + c.perDay, 0).toFixed(2),
        carry,
        marginLocked: +state.im.toFixed(2),
        equity: +state.equity.toFixed(2),
        grossNotional: +state.positions.reduce((s, p) => s + p.notional, 0).toFixed(2)
      };
    });

    res.json({ ok: true, lastUpdated: new Date().toISOString(),
               multiAssetsMode: bn.multiAssetsMode, pools });
  } catch (err) {
    console.error('[hedgeledger]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Unwind planner ────────────────────────────────────────────────────────────
// Closing a position does not change equity — realised PnL replaces unrealised one for
// one. What it releases is margin: initial margin becomes free margin, maintenance margin
// becomes liquidation buffer. Free margin is therefore capped by equity no matter what is
// closed, which is why every response leads with the ceiling.
app.get('/api/deleverage', async (req, res) => {
  try {
    const objective = req.query.objective === 'buffer' ? 'buffer' : 'free';
    const feeRate   = Math.max(0, Math.min(0.01, parseFloat(req.query.fee) || 0.00045));
    const target    = parseFloat(req.query.target);
    const maxLossIn = Math.abs(parseFloat(req.query.maxLoss));
    const maxLoss   = Number.isFinite(maxLossIn) ? maxLossIn : Infinity;
    const allowBreakingHedges = req.query.breakHedges === 'true';

    const { bn, pools: groups } = await resolvePools();

    const plans = groups.map(g => {
      const marks = marksOf(g.positions);
      // the same tier-lookup mode the stress panel calibrated to, so both endpoints agree
      // on maintenance margin rather than one quietly assuming a default
      const { tierMode } = calibrate(g.pool, marks, g.positions, g.reported);
      const opts = { perSideTiers: tierMode === 'perSide', feeRate };
      const keyed = Object.fromEntries(g.positions.map(p => [`${p.symbol}:${p.positionSide}`, p]));

      const plan = risk.deleveragePlan(g.pool, marks, {
        ...opts, objective,
        target: isFinite(target) ? target : Infinity,
        maxRealizedLoss: maxLoss,
        allowBreakingHedges
      });

      const { resultPool, ...rest } = plan;
      return {
        marginAsset: g.marginAsset,
        marks,
        ...rest,
        // what is left standing, and where it would liquidate
        remaining: risk.evalPool(resultPool, marks, opts).positions.map(p => ({
          asset: p.asset, positionSide: p.positionSide, notional: +p.notional.toFixed(2),
          upnl: +p.upnl.toFixed(2)
        })),
        thresholdsAfter: Object.keys(marks).map(asset => {
          const k = risk.killPricesBoth(resultPool, asset, marks, opts).buffer;
          return { asset,
                   upPct:   k.up   == null ? null : +k.upPct.toFixed(2),
                   downPct: k.down == null ? null : +k.downPct.toFixed(2) };
        }),
        steps: rest.steps.map(s => ({
          ...s,
          legs: s.closes.map(c => {
            const p = keyed[c.key];
            return { key: c.key, asset: p?.asset, positionSide: p?.positionSide,
                     qty: +(c.qty ?? Math.abs(p?.sizeRaw ?? 0)).toFixed(8),
                     ofQty: Math.abs(p?.sizeRaw ?? 0) };
          })
        }))
      };
    });

    res.json({
      ok: true,
      lastUpdated: new Date().toISOString(),
      params: { objective, target: isFinite(target) ? target : null, feeRate,
                maxLoss: isFinite(maxLoss) ? maxLoss : null, allowBreakingHedges },
      multiAssetsMode: bn.multiAssetsMode,
      plans
    });
  } catch (err) {
    console.error('[deleverage]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Confluence ────────────────────────────────────────────────────────────
// Klines on any timeframe with taker-buy volume, and the public positioning series, each
// briefly cached. Only closed bars are scored; the forming bar is returned alongside.
const CF_TTL_MS = { '15m': 60e3, '1h': 120e3, '4h': 300e3, '1d': 600e3 };
const CF_KLINE_LIMIT = 1000;
const cfKlineCache = {};
const publicCache = {};

function getKlinesTf(symbol, interval) {
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

function publicGet(pathname, params, ttlMs) {
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

const rowsOf = (data, tKey, vKey) =>
  (data || []).map(r => ({ t: Number(r[tKey]), v: parseFloat(r[vKey]) })).filter(r => Number.isFinite(r.v));

async function positioningSeries(symbol, period) {
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

const CF_INFORMATIONAL = { '1d': ['leverage', 'positioning'] };

function perpSymbols() {
  return Object.entries(symbolFilters)
    .filter(([, f]) => f.contractType === 'PERPETUAL' && f.status === 'TRADING')
    .map(([symbol, f]) => ({ symbol, quote: f.quoteAsset }));
}

app.get('/api/symbols', async (req, res) => {
  try {
    await refreshSymbolFilters();
    const symbols = perpSymbols().sort((a, b) => a.symbol.localeCompare(b.symbol));
    res.json({ ok: true, symbols });
  } catch (err) {
    console.error('[symbols]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/confluence', async (req, res) => {
  try {
    const symbol = String(req.query.symbol || 'BTCUSDT').toUpperCase();
    if (!/^[A-Z0-9]{2,30}$/.test(symbol)) return res.status(400).json({ ok: false, error: 'invalid symbol' });
    await refreshSymbolFilters();
    const known = symbolFilters[symbol];
    if (Object.keys(symbolFilters).length && (!known || known.contractType !== 'PERPETUAL')) {
      return res.status(400).json({ ok: false, error: `${symbol} is not a Binance USDM perpetual` });
    }
    const tfs = String(req.query.tfs || Object.keys(cf.TIMEFRAMES).join(','))
      .split(',').filter(tf => cf.TIMEFRAMES[tf]);
    if (!tfs.length) return res.status(400).json({ ok: false, error: 'no valid timeframes' });

    const isBtc = symbol === 'BTCUSDT';
    const [meta, fundingRaw, klines, positioning, btcKlines, btcHourly, assetHourly] = await Promise.all([
      refreshFundingMeta(),
      publicGet('/fapi/v1/fundingRate', { symbol, limit: 1000 }, 300e3),
      Promise.all(tfs.map(tf => getKlinesTf(symbol, tf))),
      Promise.all(tfs.map(tf => positioningSeries(symbol, tf))),
      isBtc ? null : Promise.all(tfs.map(tf => getKlinesTf('BTCUSDT', tf))),
      isBtc ? null : getKlinesTf('BTCUSDT', '1h'),
      isBtc ? null : getKlinesTf(symbol, '1h')
    ]);
    const fundingIntervalMs = (meta[symbol]?.intervalHours || 8) * 3600e3;
    const funding = rowsOf(fundingRaw, 'fundingTime', 'fundingRate');
    const btcCorr = isBtc ? null : cf.btcCorrelation(assetHourly?.candles, btcHourly?.candles);

    const timeframes = {};
    const dataGaps = [];
    tfs.forEach((tf, k) => {
      const kl = klines[k];
      if (!kl?.candles?.length) { dataGaps.push(`${tf}: no klines`); timeframes[tf] = null; return; }
      const deriv = { ...positioning[k], funding };
      for (const [name, rows] of Object.entries(deriv)) if (!rows.length) dataGaps.push(`${tf}: no ${name} series`);
      const informational = CF_INFORMATIONAL[tf] || [];
      const x = cf.buildIndicators(kl.candles, { tf, deriv, fundingIntervalMs });
      const now = cf.scoreTimeframe(x, { informational });
      const calibration = cf.calibrate(x, { informational });

      let btc = null;
      if (!isBtc && btcKlines?.[k]?.candles?.length) {
        const bx = cf.buildIndicators(btcKlines[k].candles, { tf });
        const bs = cf.scoreTimeframe(bx, { informational }).score;
        const adj = cf.btcAlignment(now.score, bs, btcCorr);
        btc = { score: bs, corr: btcCorr, discounted: adj.discounted, rawScore: now.score };
        now.score = adj.score;
        now.state = adj.score == null ? 'n/a' : cf.stateOf(adj.score);
      }

      timeframes[tf] = {
        ...now,
        signals: now.signals.map(s => ({ ...s, hit: calibration.signals[s.id] })),
        calibration: { horizon: calibration.horizon, bars: calibration.bars, baseUp: calibration.baseUp,
          composite: calibration.composite },
        informational, btc,
        bars: x.n,
        lastClose: x.close.at(-1),
        lastClosedAt: kl.candles.at(-1).closeTime,
        live: kl.live ? { close: kl.live.close, openedAt: kl.live.t } : null,
        firstBarAt: kl.candles[0].t
      };
    });

    res.json({
      ok: true,
      lastUpdated: new Date().toISOString(),
      symbol,
      quote: known?.quoteAsset ?? null,
      fundingIntervalHours: fundingIntervalMs / 3600e3,
      lastFundingRate: funding.at(-1)?.v ?? null,
      timeframes,
      overall: cf.combineTimeframes(timeframes),
      tfWeights: Object.fromEntries(tfs.map(tf => [tf, cf.TF_WEIGHTS[tf]])),
      sources: cf.SOURCES,
      dataGaps
    });
  } catch (err) {
    console.error('[confluence]', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// The stress engine runs in the browser too — same file, so the panel and the API
// can never drift apart.
app.get('/risk-engine.js', (req, res) => {
  res.type('application/javascript').sendFile(path.join(__dirname, 'risk-engine.js'));
});


export { app, reconcileOrders };

// Timers, the websocket and the listener start only when this file is run, so the route
// tests can import the app against a fake exchange without opening real connections.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function startServices() {
  // A stream that stays open but stops delivering is the failure the reconcile loop covers
  // for correctness; this restores the low-latency path too.
  setInterval(() => {
    if (!BINANCE_API_KEY || !lastWsMessage) return;
    const quiet = Date.now() - lastWsMessage;
    if (quiet > 20 * 60 * 1000) {
      console.warn(`[bnWS] no messages for ${Math.round(quiet / 60000)}m — reconnecting`);
      lastWsMessage = Date.now();
      try { bnWs?.terminate(); } catch (_) {}
    }
  }, 5 * 60 * 1000);

  // Warm the slow, long-lived caches at boot: exchangeInfo is a large payload and the funding
  // table is a second round-trip, and paying for both on a user's first panel open cost 13s.
  (async () => {
    try {
      const [, , brackets] = await Promise.all([
        refreshSymbolFilters(), refreshFundingMeta(), getBinanceLeverageBrackets()
      ]);
      console.log(`[cache] ${Object.keys(symbolFilters).length} symbol filters, `
        + `${Object.keys(fundingMeta).length} funding intervals, `
        + `${Object.keys(brackets || {}).length} margin bracket tables`);
    } catch (err) {
      console.warn('[cache] warm-up failed, will load on demand:', err.message);
    }
  })();

  // Start Binance User Data Stream only when credentials are present
  if (BINANCE_API_KEY) {
    startBinanceUserDataStream();
  } else {
    console.warn('[bnWS] No BINANCE_API_KEY — skipping User Data Stream');
  }

  app.listen(PORT, () => console.log(`Dashboard running → http://localhost:${PORT}`));
}

if (isMain) startServices();
