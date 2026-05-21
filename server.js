import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import WebSocket from 'ws';
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

// ── Binance User Data Stream state ────────────────────────────────────────
let bnOrderCache     = [];   // normalised regular open orders, kept live by WS
let listenKey        = null;
let bnWs             = null;
let keepaliveTimer   = null;
let reconnectTimeout = null;

function binanceSign(params) {
  const query = new URLSearchParams(params).toString();
  const sig = crypto.createHmac('sha256', BINANCE_API_SECRET).update(query).digest('hex');
  return `${query}&signature=${sig}`;
}

async function binanceFetch(endpoint, params = {}, method = 'GET') {
  const MAX_RETRIES = 4;
  let delay = 500;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    params.timestamp = Date.now();
    const qs  = binanceSign(params);
    const url = `${BINANCE_BASE}${endpoint}?${qs}`;
    const res = await fetch(url, { method, headers: { 'X-MBX-APIKEY': BINANCE_API_KEY } });

    if (res.ok) return res.json();

    if (res.status === 418) {
      // IP auto-banned — retrying makes the ban longer; fail immediately
      throw new Error(`Binance IP banned (418) on ${endpoint} — stop polling and wait`);
    }

    if (res.status === 429) {
      // Rate-limited — respect Retry-After if present, otherwise exponential backoff
      const retryAfterSec = res.headers.get('Retry-After');
      const waitMs = retryAfterSec ? parseInt(retryAfterSec, 10) * 1000 : jitter(delay);
      console.warn(`[rate-limit] Binance 429 on ${endpoint}, retry ${attempt}/${MAX_RETRIES} in ${waitMs}ms`);
      if (attempt === MAX_RETRIES) throw new Error(`Binance ${endpoint} rate-limited after ${MAX_RETRIES} retries`);
      await sleep(waitMs);
      delay *= 2;
      continue;
    }

    // Any other non-2xx — fail immediately (don't retry 4xx auth errors etc.)
    throw new Error(`Binance ${endpoint} → ${res.status}`);
  }
}

async function hlFetch(body) {
  const MAX_RETRIES = 4;
  let delay = 500;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(HL_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
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

async function getHyperliquidData() {
  const [state, meta, rawOrders, spotState] = await Promise.all([
    hlFetch({ type: 'clearinghouseState', user: HL_WALLET }),
    hlFetch({ type: 'metaAndAssetCtxs' }),
    hlFetch({ type: 'openOrders', user: HL_WALLET }).catch(() => []),
    hlFetch({ type: 'spotClearinghouseState', user: HL_WALLET }).catch(() => null)
  ]);

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
      const leverage = parseFloat(pos.leverage?.value || pos.leverage || 1);
      const fundingSign = funding >= 0 ? '+' : '';
      return {
        pair:        `${asset}-PERP`,
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
  const asset   = o.symbol.replace('USDT', '');
  const typeStr = o.type ? (o.type.charAt(0) + o.type.slice(1).toLowerCase().replace(/_/g, ' ')) : 'Limit';
  const stopPx  = parseFloat(o.stopPrice || 0);
  return {
    orderId:    o.orderId,           // kept for WS cache keying; not sent to frontend
    pair:       o.symbol.replace('USDT', '/USDT'),
    side:       o.side === 'BUY' ? 'Buy' : 'Sell',
    type:       typeStr,
    price:      parseFloat(o.price || 0),
    stopPrice:  stopPx > 0 ? stopPx : null,
    size:       `${parseFloat(o.origQty || 0)} ${asset}`,
    reduceOnly: o.reduceOnly || false,
    exchange:   'binance'
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
      console.warn('[bnWS] Seed failed (cache starts empty):', err.message);
      bnOrderCache = [];
    }

    // 4. listenKey keepalive — PUT every 30 min (expires after 60 min)
    if (keepaliveTimer) clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(async () => {
      try {
        await fetch(`${BINANCE_BASE}/fapi/v1/listenKey`, {
          method: 'PUT',
          headers: { 'X-MBX-APIKEY': BINANCE_API_KEY }
        });
      } catch (err) {
        console.warn('[bnWS] listenKey keepalive failed:', err.message);
      }
    }, 30 * 60 * 1000);
  });

  bnWs.on('message', raw => {
    let evt;
    try { evt = JSON.parse(raw); } catch (_) { return; }

    // Only handle regular order updates (algo orders stay on REST)
    if (evt.e !== 'ORDER_TRADE_UPDATE') return;

    const o      = evt.o;                // order object inside the event
    const id     = o.i;                  // orderId
    const status = o.X;                  // order status string

    if (status === 'NEW') {
      // Add to cache — reconstruct into a REST-compatible shape for normaliseBnOrder
      const synthetic = {
        orderId:    id,
        symbol:     o.s,
        side:       o.S,
        type:       o.o,
        price:      o.p,
        origQty:    o.q,
        stopPrice:  o.sp,
        reduceOnly: o.R
      };
      // Remove any stale entry first (order updates can arrive out of order)
      bnOrderCache = bnOrderCache.filter(c => c.orderId !== id);
      bnOrderCache.push(normaliseBnOrder(synthetic));

    } else if (status === 'PARTIALLY_FILLED') {
      // Update remaining quantity
      const remaining = parseFloat(o.q) - parseFloat(o.z);  // origQty - cumQty
      const asset     = o.s.replace('USDT', '');
      bnOrderCache = bnOrderCache.map(c =>
        c.orderId === id ? { ...c, size: `${remaining} ${asset}` } : c
      );

    } else if (['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED'].includes(status)) {
      // Remove from cache
      bnOrderCache = bnOrderCache.filter(c => c.orderId !== id);
    }
  });

  bnWs.on('error', err => {
    console.error('[bnWS] WebSocket error:', err.message);
  });

  bnWs.on('close', (code, reason) => {
    console.warn(`[bnWS] Connection closed (${code}) — reconnecting in 5s`);
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
    reconnectTimeout = setTimeout(startBinanceUserDataStream, 5_000);
  });
}

async function getBinanceData() {
  // Regular open orders are served from bnOrderCache (kept live by WS).
  // Algo/conditional orders (TP/SL, trailing stop) remain on REST — they are
  // low-weight and not covered by ORDER_TRADE_UPDATE events.
  const [account, positions, premiumIndex, rawAlgo] = await Promise.all([
    binanceFetch('/fapi/v2/account'),
    binanceFetch('/fapi/v2/positionRisk'),
    fetch(`${BINANCE_BASE}/fapi/v1/premiumIndex`).then(r => r.ok ? r.json() : []),
    binanceFetch('/fapi/v1/openAlgoOrders').catch(() => [])  // algo/conditional orders
  ]);

  const fundingMap = {};
  (Array.isArray(premiumIndex) ? premiumIndex : []).forEach(p => {
    fundingMap[p.symbol] = parseFloat(p.lastFundingRate || 0) * 100;
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
      return {
        pair:        p.symbol.replace('USDT', '/USDT'),
        type:        'futures',
        side:        size > 0 ? 'Long' : 'Short',
        leverage:    `${leverage}×`,
        size:        `${Math.abs(size)} ${p.symbol.replace('USDT', '')}`,
        sizeUsd:     notional,
        entry,
        mark,
        liqPrice:    liqPx,
        upnl,
        fundingRate: funding,
        funding8h:   `${fundingSign}${funding.toFixed(4)}%`,
        exchange:    'binance'
      };
    });

  // Regular orders come from WS cache — strip the internal orderId before sending
  const regularOrders = bnOrderCache.map(({ orderId, ...rest }) => rest);

  // Normalise algo/conditional orders — different shape: algoId, orderType, triggerPrice, quantity
  // These are TP/SL and trailing-stop orders placed via the algo endpoint.
  const algoOrders = (Array.isArray(rawAlgo) ? rawAlgo : []).map(o => {
    const asset      = o.symbol.replace('USDT', '');
    const rawType    = o.orderType || o.algoType || 'Conditional';
    const typeStr    = rawType.charAt(0) + rawType.slice(1).toLowerCase().replace(/_/g, ' ');
    const triggerPx  = parseFloat(o.triggerPrice || 0);
    const limitPx    = parseFloat(o.price || 0);
    return {
      pair:       o.symbol.replace('USDT', '/USDT'),
      side:       o.side === 'BUY' ? 'Buy' : 'Sell',
      type:       typeStr,
      price:      limitPx > 0 ? limitPx : 0,
      stopPrice:  triggerPx > 0 ? triggerPx : null,
      size:       `${parseFloat(o.quantity || 0)} ${asset}`,
      reduceOnly: o.reduceOnly || o.closePosition || false,
      exchange:   'binance'
    };
  });

  const openOrders = [...regularOrders, ...algoOrders];

  const equity      = parseFloat(account.totalWalletBalance || 0);
  const marginUsed  = parseFloat(account.totalInitialMargin || 0);
  const marginPct   = equity > 0 ? ((marginUsed / equity) * 100).toFixed(1) : '0.0';
  const availBal    = parseFloat(account.availableBalance || 0);
  const maintMargin = parseFloat(account.totalMaintMargin || 0);
  const freeMargin  = availBal;

  return { equity, marginPct, marginUsed, freeMargin, availBal, maintMargin, openPositions, openOrders };
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

// Start Binance User Data Stream only when credentials are present
if (BINANCE_API_KEY) {
  startBinanceUserDataStream();
} else {
  console.warn('[bnWS] No BINANCE_API_KEY — skipping User Data Stream');
}

app.listen(PORT, () => console.log(`Dashboard running → http://localhost:${PORT}`));
