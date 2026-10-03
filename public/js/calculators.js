// calculators.js — the context menu and the calculator modal: a position picker that fills
// every tab, and the tabs' inputs and results. The arithmetic is calc-engine.js; Binance
// liquidation comes from the Stress tab's pool and risk-engine.js.

let ctxPosition = null;
let calcEngine = null;
let calcPick = null;
let activeCalcTab = 'pnl';
let pnlMode = 'std';
let pnlSizeMode = 'usdt';
let avgSizeMode = 'usdt';

const CALC_TABS = ['pnl', 'avg', 'liq', 'size', 'be'];
const CALC_TITLES = { pnl: 'P&L Calculator', avg: 'Average Down / Up', liq: 'Liquidation Price',
                      size: 'Size From Risk', be: 'Break-even' };
const DEFAULT_FEE_PCT = 0.05;
const calcEl = id => document.getElementById(id);
const calcNum = id => parseFloat(calcEl(id).value);
const setCalc = (id, value) => { calcEl(id).value = value ?? ''; };

function showCtxMenu(e, posData) {
  e.preventDefault();
  ctxPosition = posData;
  const menu = calcEl('ctxMenu');
  menu.classList.add('open');
  const x = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8);
  const y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8);
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}

function hideCtxMenu() {
  calcEl('ctxMenu').classList.remove('open');
}

function calcPositions() {
  return lastData ? [...lastData.binance.positions, ...lastData.hyperliquid.positions] : [];
}

const calcKeyOf = p => `${p.exchange}:${p.symbol || p.pair}:${p.positionSide || 'BOTH'}:${p.side}`;
const leverageOf = p => parseFloat(String(p.leverage || '1').replace(/[×x]/, '')) || 1;
const calcQuote = () => calcPick?.quote || 'USD';

function renderCalcPicker() {
  const options = calcPositions().map(p =>
    `<option value="${esc(calcKeyOf(p))}"${calcPick && calcKeyOf(p) === calcKeyOf(calcPick) ? ' selected' : ''}>${esc(p.pair)} ${p.side} ${esc(p.leverage)}</option>`);
  calcEl('calcPick').innerHTML = `<option value="">Manual</option>${options.join('')}`;
}

function poolLegFor(p) {
  if (p?.exchange !== 'binance' || !riskBook?.pools || !riskEngine) return null;
  const key = `${p.symbol}:${p.positionSide}`;
  const P = riskBook.pools.find(pool => pool.pool.positions.some(x => x.key === key));
  return P ? { P, pos: P.pool.positions.find(x => x.key === key) } : null;
}

const inputNum = (n, decimals) => String(+n.toFixed(decimals));

function fillSize(fieldId, mode, p, lev) {
  setCalc(fieldId, mode === 'usdt' ? inputNum(p.sizeUsd / lev, 2) : inputNum(p.sizeUsd / p.entry, 6));
}

function clearCalcInputs() {
  ['pnlEntry', 'pnlInvested', 'pnlCurrent', 'pnlLev', 'pnlTargetRoi',
   'avgEntry', 'avgInvested', 'avgNewEntry', 'avgTarget', 'avgLev', 'liqEntry', 'liqLev', 'liqMmr',
   'sizeEntry', 'sizeStop', 'sizeLev', 'beEntry', 'beQty', 'beFunding'].forEach(id => setCalc(id, ''));
  setCalc('sizeEquity', lastData ? +parseFloat(lastData.summary.totalEquity).toFixed(2) : '');
  calcEl('sizeStopHint').textContent = '';
  setCalc('beFeeIn', DEFAULT_FEE_PCT);
  setCalc('beFeeOut', DEFAULT_FEE_PCT);
}

function suggestedStopFor(p) {
  return (volStopData?.positions || []).find(v => v.pair === p.pair && v.side === p.side && v.exchange === p.exchange)?.stopPrice ?? null;
}

function takerFeePct(p) {
  const leg = poolLegFor(p);
  const taker = leg?.P.fees?.[leg.pos.asset]?.taker;
  return taker > 0 ? +(taker * 100).toFixed(4) : DEFAULT_FEE_PCT;
}

function fillSizeAndBreakEven(p, lev) {
  const stop = suggestedStopFor(p);
  setCalc('sizeSide', p.side);
  setCalc('sizeLev', lev);
  setCalc('sizeEntry', p.mark);
  setCalc('sizeEquity', +parseFloat(lastData?.[p.exchange]?.equity ?? 0).toFixed(2));
  setCalc('sizeStop', stop ?? '');
  calcEl('sizeStopHint').textContent = stop ? 'the Stops tab\'s suggestion' : '';
  setCalc('beSide', p.side);
  setCalc('beEntry', p.entry);
  setCalc('beQty', +(p.sizeUsd / p.entry).toFixed(6));
  setCalc('beFeeIn', takerFeePct(p));
  setCalc('beFeeOut', takerFeePct(p));
  setCalc('beFunding', p.fundingRate ?? '');
  setCalc('beInterval', p.fundingIntervalHours ?? 8);
}

function fillFromPosition(p) {
  document.querySelectorAll('.calc-quote').forEach(el => { el.textContent = calcQuote(); });
  calcEl('calcSub').textContent = p ? `${p.pair} · ${p.side}` : '';
  if (!p) { clearCalcInputs(); return; }
  const lev = leverageOf(p);
  setCalc('pnlSide', p.side);
  setCalc('pnlEntry', p.entry);
  setCalc('pnlCurrent', p.mark);
  setCalc('pnlLev', lev);
  fillSize('pnlInvested', pnlSizeMode, p, lev);
  setCalc('avgEntry', p.entry);
  setCalc('avgNewEntry', p.mark);
  setCalc('avgLev', lev);
  fillSize('avgInvested', avgSizeMode, p, lev);
  setCalc('liqSide', p.side);
  setCalc('liqEntry', p.entry);
  setCalc('liqLev', lev);
  setCalc('liqAddPrice', p.mark);
  fillSizeAndBreakEven(p, lev);
  const leg = poolLegFor(p);
  const mmr = leg && calcEngine.maintRatePct(leg.pos.brackets, Math.abs(leg.pos.q) * leg.pos.mark * (leg.pos.notionalCoef || 1));
  setCalc('liqMmr', mmr != null ? +mmr.toFixed(3) : '');
  calcEl('liqMmrHint').textContent = mmr != null ? `tier rate for this size` : 'default 0.5%';
}

function recalcActiveTab() {
  ({ pnl: calcPnl, avg: calcAvg, liq: calcLiq, size: calcSize, be: calcBreakEven })[activeCalcTab]();
}

function switchCalcTab(tab) {
  activeCalcTab = tab;
  CALC_TABS.forEach(t => {
    calcEl(`tab-${t}`).classList.toggle('active', t === tab);
    calcEl(`calcBody-${t}`).style.display = t === tab ? '' : 'none';
  });
  calcEl('calcTitle').textContent = CALC_TITLES[tab];
  recalcActiveTab();
}

async function loadBookForPick() {
  if (calcPick?.exchange !== 'binance' || riskBook?.pools) return;
  await fetchRiskBook();
  fillFromPosition(calcPick);
  recalcActiveTab();
}

function pickCalcPosition(key) {
  calcPick = calcPositions().find(p => calcKeyOf(p) === key) || null;
  fillFromPosition(calcPick);
  recalcActiveTab();
  loadBookForPick();
}

async function openCalc(type) {
  hideCtxMenu();
  if (!calcEngine) calcEngine = await import('/calc-engine.js');
  calcPick = ctxPosition;
  renderCalcPicker();
  fillFromPosition(calcPick);
  ['pnlResult', 'avgResult', 'liqResult', 'sizeResult', 'beResult'].forEach(id => calcEl(id).classList.remove('show'));
  switchCalcTab(type);
  calcEl('calcOverlay').classList.add('open');
  loadBookForPick();
}

function openCalcFromSidebar(tab) {
  ctxPosition = null;
  openCalc(tab);
}

function closeCalc(id) { calcEl(id).classList.remove('open'); }
function closeCalcOnBg(e, id) { if (e.target === calcEl(id)) closeCalc(id); }

function setPnlMode(mode) {
  pnlMode = mode;
  calcEl('pnlMode-std').classList.toggle('active', mode === 'std');
  calcEl('pnlMode-rev').classList.toggle('active', mode === 'rev');
  calcEl('pnlExitWrap').style.display   = mode === 'std' ? '' : 'none';
  calcEl('pnlTargetWrap').style.display = mode === 'rev' ? '' : 'none';
  calcEl('pnlPnlRow').style.display     = mode === 'std' ? '' : 'none';
  calcEl('pnlRoiRow').style.display     = mode === 'std' ? '' : 'none';
  calcEl('pnlExitRow').style.display    = mode === 'rev' ? '' : 'none';
  calcEl('pnlResult').classList.remove('show');
  calcPnl();
}

function switchSizeMode(prefix, mode) {
  const entry = calcNum(`${prefix}Entry`);
  const value = calcNum(`${prefix}Invested`);
  const toQty = mode === 'qty';
  calcEl(`${prefix}SizeLbl`).innerHTML = toQty ? 'Position size (units)' : `Amount invested (<span class="calc-quote">${calcQuote()}</span>)`;
  document.querySelector(`[onclick="toggle${prefix === 'pnl' ? 'Pnl' : 'Avg'}SizeMode()"]`).textContent = toQty ? 'Switch to USD' : 'Switch to qty';
  if (value && entry) setCalc(`${prefix}Invested`, toQty ? inputNum(value / entry, 6) : inputNum(value * entry, 2));
}

function togglePnlSizeMode() {
  pnlSizeMode = pnlSizeMode === 'usdt' ? 'qty' : 'usdt';
  switchSizeMode('pnl', pnlSizeMode);
  calcPnl();
}

function toggleAvgSizeMode() {
  avgSizeMode = avgSizeMode === 'usdt' ? 'qty' : 'usdt';
  switchSizeMode('avg', avgSizeMode);
  calcAvg();
}

const signedPct = v => `${v < 0 ? '−' : '+'}${fmt(Math.abs(v), 2)}%`;

function ladderHtml(rows) {
  return `<table class="calc-ladder"><tr><th>Exit move</th><th>Price</th><th>P&amp;L</th><th>Return</th></tr>${rows.map(r =>
    `<tr><td>${signedPct(r.movePct)}</td><td>${fmtPrice(r.price)}</td><td>${signedHtml(r.pnl, fmtSignedUsd(r.pnl))}</td><td>${signedHtml(r.pnl, signedPct(r.roiPct))}</td></tr>`).join('')}</table>`;
}

const signedHtml = (v, text) => `<span style="color:${v >= 0 ? 'var(--success)' : 'var(--danger)'}">${text}</span>`;

function calcPnl() {
  const res = calcEl('pnlResult');
  const side = calcEl('pnlSide').value;
  const entry = calcNum('pnlEntry');
  const size = calcEngine.sizeFrom({ mode: pnlSizeMode === 'qty' ? 'qty' : 'usd', value: calcNum('pnlInvested'),
                                     entry, lev: calcNum('pnlLev') || 1 });
  if (!size) { res.classList.remove('show'); return; }
  calcEl('pnlSize').textContent = fmt(size.qty, 6) + ' units';
  calcEl('pnlMargin').textContent = '$' + fmt(size.margin);

  if (pnlMode === 'std') {
    const exit = calcNum('pnlCurrent');
    if (!exit) { res.classList.remove('show'); return; }
    const { pnl, roiPct } = calcEngine.pnlAt({ side, entry, qty: size.qty, exit, margin: size.margin });
    calcEl('pnlPnl').innerHTML = signedHtml(pnl, fmtSignedUsd(pnl));
    calcEl('pnlRoi').innerHTML = signedHtml(pnl, signedPct(roiPct));
    calcEl('pnlLadder').innerHTML = ladderHtml(calcEngine.pnlLadder({ side, entry, qty: size.qty, margin: size.margin, base: exit }));
  } else {
    const targetPct = calcNum('pnlTargetRoi');
    if (isNaN(targetPct)) { res.classList.remove('show'); return; }
    const exit = calcEngine.exitForReturn({ side, entry, qty: size.qty, margin: size.margin, targetPct });
    calcEl('pnlExitPrice').innerHTML = signedHtml(targetPct, fmtPrice(exit));
    calcEl('pnlLadder').innerHTML = '';
  }
  res.classList.add('show');
}

function liqText(detail, mark) {
  if (!detail?.price) return { price: 'none in range', dist: '—' };
  const dist = (detail.price - mark) / mark * 100;
  return { price: fmtPrice(detail.price), dist: `${dist < 0 ? '−' : '+'}${fmt(Math.abs(dist), 2)}%` };
}

function calcAvg() {
  const res = calcEl('avgResult');
  const warn = calcEl('avgWarnWrap');
  warn.innerHTML = '';
  const entry = calcNum('avgEntry'), newEntry = calcNum('avgNewEntry'), target = calcNum('avgTarget');
  const lev = calcNum('avgLev') || 1;
  const size = calcEngine.sizeFrom({ mode: avgSizeMode === 'qty' ? 'qty' : 'usd', value: calcNum('avgInvested'), entry, lev });
  if (!size || !newEntry || !target) { res.classList.remove('show'); return; }

  const r = calcEngine.averageAdd({ entry, qtyOld: size.qty, newEntry, target });
  if (r.unreachable) {
    res.classList.remove('show');
    warn.innerHTML = `<p class="calc-warn">Target average $${fmt(target)} is not reachable by adding at $${fmt(newEntry)}. Try a different new entry or target.</p>`;
    return;
  }
  calcEl('avgAdd').textContent       = '$' + fmt(r.addNotional);
  calcEl('avgAddMargin').textContent = '$' + fmt(r.addNotional / lev) + ` (${lev}× lev)`;
  calcEl('avgNewSize').textContent   = fmt(r.newQty, 6) + ' units';
  calcEl('avgAchieved').textContent  = '$' + fmt(r.achieved);
  calcEl('avgTotal').textContent     = '$' + fmt(r.totalNotional);

  const leg = poolLegFor(calcPick);
  calcEl('avgLiqRow').style.display = leg ? '' : 'none';
  if (leg) {
    const { P, pos } = leg;
    const after = riskEngine.liquidationDetail(riskEngine.addToPosition(P.pool, pos.key, r.addQty, newEntry), pos.asset, P.marks, P.opts);
    const t = liqText(after, P.marks[pos.asset]);
    calcEl('avgLiq').textContent = `${t.price} (${t.dist})`;
  }
  if (newEntry > entry) warn.innerHTML = '<p class="calc-warn">Averaging up — adding at a higher price than current entry.</p>';
  res.classList.add('show');
}

function calcLiq() {
  const leg = poolLegFor(calcPick);
  calcEl('liqAccount').style.display = leg ? '' : 'none';
  calcEl('liqManual').style.display = leg ? 'none' : '';
  if (leg) { calcLiqAccount(leg); return; }

  const res = calcEl('liqResult');
  const entry = calcNum('liqEntry');
  const mmrRaw = calcNum('liqMmr');
  const r = calcEngine.isolatedLiq({ side: calcEl('liqSide').value, entry, lev: calcNum('liqLev'),
                                     mmrPct: isNaN(mmrRaw) ? 0.5 : mmrRaw });
  if (!r) { res.classList.remove('show'); return; }
  const col = r.distPct < 10 ? 'var(--danger)' : r.distPct < 30 ? 'var(--warning)' : 'var(--success)';
  calcEl('liqPrice').innerHTML = `<span style="color:${col}">${fmtPrice(r.price)}</span>`;
  calcEl('liqDist').innerHTML  = `<span style="color:${col}">${fmt(r.distPct, 2)}%</span>`;
  calcEl('liqMove').textContent = '$' + fmt(Math.abs(entry - r.price)) + ' per unit';
  res.classList.add('show');
}

function calcLiqAccount({ P, pos }) {
  const mark = P.marks[pos.asset];
  const detail = riskEngine.liquidationDetail(P.pool, pos.asset, P.marks, P.opts);
  const now = liqText(detail, mark);
  const reported = P.liqCheck?.find(x => x.key === pos.key)?.reportedLiqPrice;
  calcEl('liqAccPrice').textContent = now.price;
  calcEl('liqAccDist').textContent = now.dist;
  calcEl('liqAccReported').textContent = reported ? fmtPrice(reported) : 'none';
  calcEl('liqAccNote').textContent = detail.illConditioned
    ? `A near-flat book: each 1% of equity moves this by about $${fmt(detail.movePerOnePctEquity)} — read it as a region, not a price.`
    : '';

  const addRes = calcEl('liqAddResult');
  const addUsd = calcNum('liqAddUsd');
  const addPrice = calcNum('liqAddPrice') || mark;
  if (!(addUsd > 0)) { addRes.classList.remove('show'); return; }
  const after = liqText(riskEngine.liquidationDetail(
    riskEngine.addToPosition(P.pool, pos.key, addUsd / addPrice, addPrice), pos.asset, P.marks, P.opts), mark);
  calcEl('liqAddPrice2').textContent = after.price;
  calcEl('liqAddDist').textContent = after.dist;
  addRes.classList.add('show');
}

function calcSize() {
  const res = calcEl('sizeResult');
  const warn = calcEl('sizeWarn');
  warn.innerHTML = '';
  const r = calcEngine.sizeFromRisk({ side: calcEl('sizeSide').value, equity: calcNum('sizeEquity'),
    riskPct: calcNum('sizeRisk'), entry: calcNum('sizeEntry'), stop: calcNum('sizeStop'), lev: calcNum('sizeLev') || 1 });
  if (!r || r.wrongSide) {
    res.classList.remove('show');
    if (r?.wrongSide) warn.innerHTML = `<p class="calc-warn">The stop is on the wrong side of entry for a ${calcEl('sizeSide').value.toLowerCase()}.</p>`;
    return;
  }
  calcEl('sizeRiskUsd').textContent = fmtUsd(r.riskUsd);
  calcEl('sizeStopPct').textContent = `${fmt(r.stopPct, 2)}%`;
  calcEl('sizeQty').textContent = fmt(r.qty, 6) + ' units';
  calcEl('sizeNotional').textContent = fmtUsd(r.notional);
  calcEl('sizeMargin').textContent = fmtUsd(r.margin);
  res.classList.add('show');
}

function calcBreakEven() {
  const res = calcEl('beResult');
  const pct = id => (calcNum(id) || 0) / 100;
  const r = calcEngine.breakEven({ side: calcEl('beSide').value, entry: calcNum('beEntry'), qty: calcNum('beQty'),
    feeIn: pct('beFeeIn'), feeOut: pct('beFeeOut'), fundingRatePct: calcNum('beFunding') || 0,
    intervalHours: calcNum('beInterval'), hours: calcNum('beHours') || 0 });
  if (!r) { res.classList.remove('show'); return; }
  calcEl('beExit').textContent = fmtPrice(r.exit);
  calcEl('beMove').textContent = signedPct(r.movePct);
  calcEl('beFees').textContent = fmtUsd(r.fees);
  calcEl('beFundingUsd').innerHTML = signedHtml(-r.funding, r.funding > 0 ? `${fmtUsd(r.funding)} paid` : `${fmtUsd(-r.funding)} received`);
  res.classList.add('show');
}
