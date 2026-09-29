// hyperliquid.js — Hyperliquid info requests and the normalised account view (read-only).

import { FETCH_TIMEOUT_MS, HL_BASE, HL_WALLET } from './config.js';
import { jitter, sharedSnapshot, sleep } from './util.js';

export async function hlFetch(body) {
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

const hlRaw = sharedSnapshot(() => Promise.all([
  hlFetch({ type: 'clearinghouseState', user: HL_WALLET }),
  hlFetch({ type: 'metaAndAssetCtxs' }),
  hlFetch({ type: 'openOrders', user: HL_WALLET }).catch(() => []),
  hlFetch({ type: 'spotClearinghouseState', user: HL_WALLET }).catch(() => null)
]));

export const hyperliquidSnapshotAgeMs = () => hlRaw.ageMs();

export async function getHyperliquidData(opts) {
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
