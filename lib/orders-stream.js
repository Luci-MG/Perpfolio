// orders-stream.js — the user-data websocket that keeps the regular-order cache live, the 60s
// REST reconcile that heals it, and the stalled-stream watchdog. The stream is an
// accelerator; REST is the truth.

import WebSocket from 'ws';
import { binanceFetch, splitSymbol } from './binance-client.js';
import { BINANCE_API_KEY, BINANCE_BASE, BINANCE_WS_BASE } from './config.js';

// ── Binance User Data Stream state ────────────────────────────────────────
export let bnOrderCache     = [];   // normalised regular open orders, kept live by WS + reconcile
export let lastWsMessage    = 0;    // a socket can stay open and stop delivering
let listenKey        = null;
let bnWs             = null;
let keepaliveTimer   = null;
let reconnectTimeout = null;

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
export async function startBinanceUserDataStream() {
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
export function startStreamWatchdog() {
  setInterval(() => {
    if (!BINANCE_API_KEY || !lastWsMessage) return;
    const quiet = Date.now() - lastWsMessage;
    if (quiet > 20 * 60 * 1000) {
      console.warn(`[bnWS] no messages for ${Math.round(quiet / 60000)}m — reconnecting`);
      lastWsMessage = Date.now();
      try { bnWs?.terminate(); } catch (_) {}
    }
  }, 5 * 60 * 1000);
}
