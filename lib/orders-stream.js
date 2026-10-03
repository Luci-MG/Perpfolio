// orders-stream.js — the user-data websocket that keeps the regular-order cache live, the 60s
// REST reconcile that heals it, and the stalled-stream watchdog. The stream is an
// accelerator; REST is the truth.

import WebSocket from 'ws';
import { binanceFetch, splitSymbol } from './binance-client.js';
import { BINANCE_API_KEY, BINANCE_BASE, BINANCE_WS_BASE } from './config.js';
import { isEnabled } from './venues.js';

// ── Binance User Data Stream state ────────────────────────────────────────
export let bnOrderCache     = [];   // normalised regular open orders, kept live by WS + reconcile
export let lastWsMessage    = 0;    // a socket can stay open and stop delivering
let listenKey        = null;
let bnWs             = null;
let keepaliveTimer   = null;
let reconnectTimeout = null;
let streamStartedByServer = false;
let reconcileTimer   = null;

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
    activatePrice: parseFloat(o.activatePrice || 0) || null,
    callbackRate: parseFloat(o.priceRate || 0) || null,
    exchange:     'binance'
  };
}

// ── Binance User Data Stream — keeps bnOrderCache live ───────────────────
export async function startBinanceUserDataStream() {
  streamStartedByServer = true;
  // Clear any pending reconnect so we don't stack timers
  if (reconnectTimeout) { clearTimeout(reconnectTimeout); reconnectTimeout = null; }
  if (!isEnabled('binance')) return;

  try {
    // 1. Get a fresh listenKey
    const data = await binanceFetch('/fapi/v1/listenKey', {}, 'POST');
    listenKey = data.listenKey;
    if (!isEnabled('binance')) return;
  } catch (err) {
    console.error('[bnWS] Failed to create listenKey:', err.message, '— retrying in 15s');
    reconnectTimeout = setTimeout(startBinanceUserDataStream, 15_000);
    return;
  }

  // 2. Open the WebSocket
  if (bnWs) { try { bnWs.terminate(); } catch (_) {} }
  bnWs = new WebSocket(`${BINANCE_WS_BASE}/${listenKey}`);
  const socket = bnWs;

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

    applyUserDataEvent(evt);
  });

  bnWs.on('error', err => {
    if (socket !== bnWs) return;
    // 'error' is not guaranteed to be followed by 'close', and when it is not the socket is
    // simply dead: an ECONNRESET here once froze the order cache for three days.
    console.error('[bnWS] WebSocket error:', err.message, '— forcing reconnect');
    try { bnWs.terminate(); } catch (_) {}
    if (!reconnectTimeout && isEnabled('binance')) reconnectTimeout = setTimeout(startBinanceUserDataStream, 5_000);
  });

  bnWs.on('close', (code, reason) => {
    if (socket !== bnWs) return;
    console.warn(`[bnWS] Connection closed (${code}) — reconnecting in 5s`);
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
    if (isEnabled('binance')) reconnectTimeout = setTimeout(startBinanceUserDataStream, 5_000);
  });
}

const fillListeners = [];

/** Registers `listener(order)` for every fill the user-data stream reports (`ORDER_TRADE_UPDATE`, execution `TRADE`). */
export function onFill(listener) {
  fillListeners.push(listener);
}

function notifyFill(o) {
  for (const listener of fillListeners) {
    try { listener(o); } catch (err) { console.warn('[bnWS] fill listener failed:', err.message); }
  }
}

function cacheNewOrder(o) {
  const synthetic = {
    orderId:      o.i,
    symbol:       o.s,
    side:         o.S,
    type:         o.o,
    price:        o.p,
    origQty:      o.q,
    stopPrice:    o.sp,
    positionSide: o.ps,
    closePosition: o.cp,
    reduceOnly:   o.R,
    activatePrice: o.AP,
    priceRate:    o.cr
  };
  bnOrderCache = bnOrderCache.filter(c => c.orderId !== o.i);
  bnOrderCache.push(normaliseBnOrder(synthetic));
}

function cacheRemainingQty(o) {
  const remaining = parseFloat(o.q) - parseFloat(o.z);
  const { base } = splitSymbol(o.s);
  bnOrderCache = bnOrderCache.map(c =>
    c.orderId === o.i ? { ...c, size: `${remaining} ${base}`, sizeRaw: Math.abs(remaining) } : c);
}

/**
 * Applies one user-data event to the order cache and tells the fill listeners. Any status
 * other than NEW or PARTIALLY_FILLED removes the order, so a status Binance adds later (as
 * EXPIRED_IN_MATCH was, for self-trade prevention) cannot leave it on screen forever.
 */
export function applyUserDataEvent(evt) {
  if (evt.e !== 'ORDER_TRADE_UPDATE') return;
  const o = evt.o;
  if (o.x === 'TRADE') notifyFill(o);
  if (o.X === 'NEW') cacheNewOrder(o);
  else if (o.X === 'PARTIALLY_FILLED') cacheRemainingQty(o);
  else bnOrderCache = bnOrderCache.filter(c => c.orderId !== o.i);
}

// Switching Binance off closes the stream and every timer behind it, and releases the
// listenKey; nothing reconnects until it is switched back on.
export function stopBinanceUserDataStream() {
  clearTimeout(reconnectTimeout); reconnectTimeout = null;
  clearInterval(keepaliveTimer);  keepaliveTimer = null;
  clearInterval(reconcileTimer);  reconcileTimer = null;
  const ws = bnWs, key = listenKey;
  bnWs = null; listenKey = null;
  try { ws?.terminate(); } catch (_) {}
  if (key) {
    fetch(`${BINANCE_BASE}/fapi/v1/listenKey`, { method: 'DELETE', headers: { 'X-MBX-APIKEY': BINANCE_API_KEY } })
      .catch(err => console.warn('[bnWS] listenKey release failed:', err.message));
  }
  bnOrderCache = [];
  lastWsMessage = 0;
}

export async function resumeBinanceUserDataStream() {
  await reconcileOrders('resume');
  if (streamStartedByServer && !bnWs) startBinanceUserDataStream();
}

// A websocket-fed cache drifts the moment one event is missed, and nothing in the stream
// tells you it happened: a phantom order simply stays on screen. This re-reads the
// authoritative snapshot on a timer so the cache is self-healing regardless of stream
// health, and says so when it finds a difference.
export let lastReconcile = { at: null, added: 0, removed: 0 };

export async function reconcileOrders(reason = 'timer') {
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


// A stream that stays open but stops delivering is the failure the reconcile loop covers
// for correctness; this restores the low-latency path too.
export function getOrderFeedHealth() {
  return {
    connected: bnWs?.readyState === WebSocket.OPEN,
    lastMessageAgeSec: lastWsMessage ? Math.round((Date.now() - lastWsMessage) / 1000) : null,
    lastReconcile
  };
}

export function startStreamWatchdog() {
  setInterval(() => {
    if (!isEnabled('binance') || !lastWsMessage) return;
    const quiet = Date.now() - lastWsMessage;
    if (quiet > 20 * 60 * 1000) {
      console.warn(`[bnWS] no messages for ${Math.round(quiet / 60000)}m — reconnecting`);
      lastWsMessage = Date.now();
      try { bnWs?.terminate(); } catch (_) {}
    }
  }, 5 * 60 * 1000);
}
