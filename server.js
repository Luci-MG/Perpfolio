import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

app.use(express.static(path.join(__dirname, 'public')));

const BINANCE_API_KEY    = process.env.BINANCE_API_KEY || '';
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET || '';
const HL_WALLET          = process.env.HL_WALLET_ADDRESS || '';

const BINANCE_BASE = 'https://fapi.binance.com';
const HL_BASE      = 'https://api.hyperliquid.xyz/info';

function binanceSign(params) {
  const query = new URLSearchParams(params).toString();
  const sig = crypto.createHmac('sha256', BINANCE_API_SECRET).update(query).digest('hex');
  return `${query}&signature=${sig}`;
}

async function binanceFetch(endpoint, params = {}) {
  params.timestamp = Date.now();
  const url = `${BINANCE_BASE}${endpoint}?${binanceSign(params)}`;
  const res = await fetch(url, { headers: { 'X-MBX-APIKEY': BINANCE_API_KEY } });
  if (!res.ok) throw new Error(`Binance ${endpoint} → ${res.status}`);
  return res.json();
}

async function hlFetch(body) {
  const res = await fetch(HL_BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`HL → ${res.status}`);
  return res.json();
}

async function getHyperliquidData() {
  const [state, meta, rawOrders] = await Promise.all([
    hlFetch({ type: 'clearinghouseState', user: HL_WALLET }),
    hlFetch({ type: 'metaAndAssetCtxs' }),
    hlFetch({ type: 'openOrders', user: HL_WALLET }).catch(() => [])
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
    type:       'Limit',
    price:      parseFloat(o.limitPx || 0),
    size:       `${parseFloat(o.sz || 0)} ${o.coin}`,
    reduceOnly: o.reduceOnly || false,
    exchange:   'hyperliquid'
  }));

  const equity     = parseFloat(state.marginSummary?.accountValue || 0);
  const marginUsed = parseFloat(state.marginSummary?.totalMarginUsed || 0);
  const marginPct  = equity > 0 ? ((marginUsed / equity) * 100).toFixed(1) : '0.0';
  const freeMargin = equity - marginUsed;

  return { equity, marginPct, marginUsed, freeMargin, openPositions, openOrders };
}

async function getBinanceData() {
  const [account, positions, premiumIndex, rawOrders] = await Promise.all([
    binanceFetch('/fapi/v2/account'),
    binanceFetch('/fapi/v2/positionRisk'),
    fetch(`${BINANCE_BASE}/fapi/v1/premiumIndex`).then(r => r.ok ? r.json() : []),
    binanceFetch('/fapi/v1/openOrders').catch(() => [])
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

  const openOrders = (Array.isArray(rawOrders) ? rawOrders : []).map(o => {
    const asset = o.symbol.replace('USDT', '');
    const typeStr = o.type ? (o.type.charAt(0) + o.type.slice(1).toLowerCase().replace(/_/g, ' ')) : 'Limit';
    return {
      pair:       o.symbol.replace('USDT', '/USDT'),
      side:       o.side === 'BUY' ? 'Buy' : 'Sell',
      type:       typeStr,
      price:      parseFloat(o.price || 0),
      size:       `${parseFloat(o.origQty || 0)} ${asset}`,
      reduceOnly: o.reduceOnly || false,
      exchange:   'binance'
    };
  });

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
        equity:     hlData.equity.toFixed(2),
        marginPct:  hlData.marginPct,
        marginUsed: hlData.marginUsed.toFixed(2),
        freeMargin: hlData.freeMargin.toFixed(2),
        positions:  hlData.openPositions,
        orders:     hlData.openOrders
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

app.listen(PORT, () => console.log(`Dashboard running → http://localhost:${PORT}`));
