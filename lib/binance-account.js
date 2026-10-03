// binance-account.js — the Binance account read (balances, positions, algo orders, funding),
// shared across routes and tabs through one snapshot.

import { binanceFetch, bnPublic, splitSymbol } from './binance-client.js';
import { fundingMeta, refreshFundingMeta } from './binance-meta.js';
import { bnOrderCache } from './orders-stream.js';
import { sharedSnapshot } from './util.js';

// Only the REST half is shared: regular orders are rebuilt from bnOrderCache on every read,
// so the websocket's freshness is not held back by the snapshot.
const bnRaw = sharedSnapshot(() => Promise.all([
  binanceFetch('/fapi/v2/account'),
  binanceFetch('/fapi/v2/positionRisk'),
  bnPublic('/fapi/v1/premiumIndex').catch(err => { console.warn('[funding]', err.message); return []; }),
  binanceFetch('/fapi/v1/openAlgoOrders').catch(() => []),
  refreshFundingMeta()
]));

export const binanceSnapshotAgeMs = () => bnRaw.ageMs();

export async function getBinanceData(opts) {
  // Regular open orders are served from bnOrderCache (kept live by WS).
  // Algo/conditional orders (TP/SL, trailing stop) remain on REST — they are
  // low-weight and not covered by ORDER_TRADE_UPDATE events.
  const [account, positions, premiumIndex, rawAlgo] = await bnRaw(opts);

  const fundingMap = {}, nextFundingMap = {}, markMap = {};
  (Array.isArray(premiumIndex) ? premiumIndex : []).forEach(p => {
    markMap[p.symbol] = parseFloat(p.markPrice || 0);
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

  const multiAssetsMode = account.multiAssetsMargin === true;
  const usdPrice = asset => asset === 'USDT' ? 1 : (markMap[`${asset}USDT`] || 1);
  const assets = Object.entries(marginAssets).map(([asset, a]) => ({
    asset,
    collateral:       /USD/.test(asset),
    wallet:           a.wallet,
    marginBalance:    a.marginBalance,
    unrealizedProfit: a.unrealizedProfit,
    availableBalance: a.availableBalance,
    usdPrice:         usdPrice(asset),
    usdValue:         a.marginBalance * usdPrice(asset)
  }));

  // In single-asset mode Binance's account totals cover USDT only, so a USDC pool is
  // missing from every one of them — sum the collateral pools instead, valued in USD.
  const totals = multiAssetsMode ? {
    walletBalance:      parseFloat(account.totalWalletBalance || 0),
    crossWalletBalance: parseFloat(account.totalCrossWalletBalance || account.totalWalletBalance || 0),
    marginBalance:      parseFloat(account.totalMarginBalance ?? account.totalWalletBalance ?? 0),
    marginUsed:         parseFloat(account.totalInitialMargin || 0),
    maintMargin:        parseFloat(account.totalMaintMargin || 0),
    availBal:           parseFloat(account.availableBalance || 0),
    crossUnPnl:         parseFloat(account.totalCrossUnPnl ?? account.crossUnPnl ?? 0)
  } : sumCollateral(marginAssets, usdPrice);

  // Equity is the margin balance — wallet plus unrealised PnL. The wallet alone overstated a
  // book carrying a large unrealised loss by nearly 4×, and stop sizing risked a share of it.
  const { walletBalance, crossWalletBalance, marginBalance, marginUsed, maintMargin, availBal, crossUnPnl } = totals;
  const equity     = marginBalance;
  const marginPct  = equity > 0 ? ((marginUsed / equity) * 100).toFixed(1) : '0.0';
  const freeMargin = availBal;

  return {
    equity, walletBalance, marginPct, marginUsed, freeMargin, availBal, maintMargin, openPositions, openOrders,
    crossWalletBalance, marginBalance, crossUnPnl, multiAssetsMode, marginAssets, assets
  };
}

function sumCollateral(marginAssets, usdPrice) {
  const totals = { walletBalance: 0, crossWalletBalance: 0, marginBalance: 0, marginUsed: 0,
                   maintMargin: 0, availBal: 0, crossUnPnl: 0 };
  for (const [asset, a] of Object.entries(marginAssets)) {
    if (!/USD/.test(asset)) continue;
    const px = usdPrice(asset);
    totals.walletBalance      += a.wallet * px;
    totals.crossWalletBalance += a.wallet * px;
    totals.marginBalance      += a.marginBalance * px;
    totals.marginUsed         += a.initialMargin * px;
    totals.maintMargin        += a.maintMargin * px;
    totals.availBal           += a.availableBalance * px;
    totals.crossUnPnl         += a.unrealizedProfit * px;
  }
  return totals;
}
