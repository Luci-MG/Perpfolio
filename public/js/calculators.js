// calculators.js — the context menu and the P&L / average / liquidation calculators.

// ── Context menu & calculators ────────────────────────────────────────────
let ctxPosition = null;
let activeCalcTab = 'pnl';
let pnlMode = 'std';        // 'std' | 'rev'
let pnlSizeMode = 'usdt';  // 'usdt' | 'qty'
let avgSizeMode = 'usdt';  // 'usdt' | 'qty'

function showCtxMenu(e, posData) {
  e.preventDefault();
  ctxPosition = posData;
  const menu = document.getElementById('ctxMenu');
  menu.classList.add('open');
  const x = Math.min(e.clientX, window.innerWidth - menu.offsetWidth - 8);
  const y = Math.min(e.clientY, window.innerHeight - menu.offsetHeight - 8);
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}

function hideCtxMenu() {
  document.getElementById('ctxMenu').classList.remove('open');
}


function switchCalcTab(tab) {
  activeCalcTab = tab;
  ['pnl','avg','liq'].forEach(t => {
    document.getElementById(`tab-${t}`).classList.toggle('active', t === tab);
    document.getElementById(`calcBody-${t}`).style.display = t === tab ? '' : 'none';
  });
  const titles = { pnl: 'P&L Calculator', avg: 'Average Down / Up', liq: 'Liquidation Price' };
  document.getElementById('calcTitle').textContent = titles[tab];
  if (tab === 'pnl') calcPnl();
  if (tab === 'avg') calcAvg();
  if (tab === 'liq') calcLiq();
}

function openCalc(type) {
  hideCtxMenu();
  const p = ctxPosition;
  const lev = p ? (parseFloat((p.leverage || '1').replace('×','').replace('x','')) || 1) : null;

  // Pre-fill P&L tab
  if (p) {
    document.getElementById('pnlSide').value    = p.side === 'Short' ? 'Short' : 'Long';
    document.getElementById('pnlEntry').value   = p.entry || '';
    document.getElementById('pnlCurrent').value = p.mark  || '';
    document.getElementById('pnlLev').value     = lev || '';
    // size mode: invested = notional / lev
    if (pnlSizeMode === 'usdt') {
      document.getElementById('pnlInvested').value = p.sizeUsd ? fmt(p.sizeUsd / lev, 2) : '';
    } else {
      const qty = p.sizeUsd && p.entry ? fmt(p.sizeUsd / p.entry, 6) : '';
      document.getElementById('pnlInvested').value = qty;
    }
  } else {
    ['pnlEntry','pnlInvested','pnlCurrent','pnlLev','pnlTargetRoi'].forEach(id => document.getElementById(id).value = '');
  }
  document.getElementById('pnlResult').classList.remove('show');

  // Pre-fill Avg tab
  if (p) {
    document.getElementById('avgEntry').value   = p.entry || '';
    document.getElementById('avgNewEntry').value = p.mark || '';
    document.getElementById('avgLev').value     = lev || '';
    if (avgSizeMode === 'usdt') {
      document.getElementById('avgInvested').value = p.sizeUsd ? fmt(p.sizeUsd / lev, 2) : '';
    } else {
      document.getElementById('avgInvested').value = p.sizeUsd && p.entry ? fmt(p.sizeUsd / p.entry, 6) : '';
    }
  } else {
    ['avgEntry','avgInvested','avgNewEntry','avgTarget','avgLev'].forEach(id => document.getElementById(id).value = '');
  }
  document.getElementById('avgResult').classList.remove('show');

  // Pre-fill Liq tab
  if (p) {
    document.getElementById('liqSide').value  = p.side === 'Short' ? 'Short' : 'Long';
    document.getElementById('liqEntry').value = p.entry || '';
    document.getElementById('liqLev').value   = lev || '';
  } else {
    ['liqEntry','liqLev'].forEach(id => document.getElementById(id).value = '');
  }
  document.getElementById('liqResult').classList.remove('show');

  // Set subtitle
  document.getElementById('calcSub').textContent = p ? `${p.pair} · ${p.side}` : '';

  // Open the right tab
  switchCalcTab(type);
  document.getElementById('calcOverlay').classList.add('open');
}

function openCalcFromSidebar(tab) {
  ctxPosition = null;
  openCalc(tab);
}

function closeCalc(id) { document.getElementById(id).classList.remove('open'); }
function closeCalcOnBg(e, id) { if (e.target === document.getElementById(id)) closeCalc(id); }

// ── P&L mode helpers ──────────────────────────────────────────────────────
function setPnlMode(mode) {
  pnlMode = mode;
  document.getElementById('pnlMode-std').classList.toggle('active', mode === 'std');
  document.getElementById('pnlMode-rev').classList.toggle('active', mode === 'rev');
  document.getElementById('pnlExitWrap').style.display   = mode === 'std' ? '' : 'none';
  document.getElementById('pnlTargetWrap').style.display = mode === 'rev' ? '' : 'none';
  document.getElementById('pnlPnlRow').style.display    = mode === 'std' ? '' : 'none';
  document.getElementById('pnlRoiRow').style.display    = mode === 'std' ? '' : 'none';
  document.getElementById('pnlExitRow').style.display   = mode === 'rev' ? '' : 'none';
  document.getElementById('pnlResult').classList.remove('show');
  calcPnl();
}

function togglePnlSizeMode() {
  const entry = parseFloat(document.getElementById('pnlEntry').value);
  const cur   = parseFloat(document.getElementById('pnlInvested').value);
  if (pnlSizeMode === 'usdt') {
    pnlSizeMode = 'qty';
    document.getElementById('pnlSizeLbl').textContent = 'Position size (units)';
    document.querySelector('[onclick="togglePnlSizeMode()"]').textContent = 'Switch to USD';
    // convert USDT → qty using entry price
    if (cur && entry) document.getElementById('pnlInvested').value = fmt(cur / entry, 6);
  } else {
    pnlSizeMode = 'usdt';
    document.getElementById('pnlSizeLbl').textContent = 'Amount invested (USD)';
    document.querySelector('[onclick="togglePnlSizeMode()"]').textContent = 'Switch to qty';
    // convert qty → USDT using entry price
    if (cur && entry) document.getElementById('pnlInvested').value = fmt(cur * entry, 2);
  }
  calcPnl();
}

function toggleAvgSizeMode() {
  const entry = parseFloat(document.getElementById('avgEntry').value);
  const cur   = parseFloat(document.getElementById('avgInvested').value);
  if (avgSizeMode === 'usdt') {
    avgSizeMode = 'qty';
    document.getElementById('avgSizeLbl').textContent = 'Position size (units)';
    document.querySelector('[onclick="toggleAvgSizeMode()"]').textContent = 'Switch to USD';
    if (cur && entry) document.getElementById('avgInvested').value = fmt(cur / entry, 6);
  } else {
    avgSizeMode = 'usdt';
    document.getElementById('avgSizeLbl').textContent = 'Amount invested (USD)';
    document.querySelector('[onclick="toggleAvgSizeMode()"]').textContent = 'Switch to qty';
    if (cur && entry) document.getElementById('avgInvested').value = fmt(cur * entry, 2);
  }
  calcAvg();
}

// ── Calculator logic ───────────────────────────────────────────────────────
function calcPnl() {
  const entry   = parseFloat(document.getElementById('pnlEntry').value);
  const rawSize = parseFloat(document.getElementById('pnlInvested').value);
  const side    = document.getElementById('pnlSide').value;
  const lev     = parseFloat(document.getElementById('pnlLev').value) || 1;
  const res     = document.getElementById('pnlResult');

  if (!entry || !rawSize) { res.classList.remove('show'); return; }

  // Resolve qty and margin
  let qty, margin;
  if (pnlSizeMode === 'qty') {
    qty    = rawSize;
    margin = (qty * entry) / lev;
  } else {
    // rawSize = margin (USDT invested)
    margin = rawSize;
    qty    = (margin * lev) / entry;
  }
  const notional = qty * entry;

  document.getElementById('pnlSize').textContent   = fmt(qty, 6) + ' units';
  document.getElementById('pnlMargin').textContent = '$' + fmt(margin);

  if (pnlMode === 'std') {
    const current = parseFloat(document.getElementById('pnlCurrent').value);
    if (!current) { res.classList.remove('show'); return; }
    const pnl    = side === 'Long' ? (current - entry) * qty : (entry - current) * qty;
    const roi    = (pnl / margin) * 100;
    const pnlCol = pnl >= 0 ? 'var(--success)' : 'var(--danger)';
    const sign   = pnl >= 0 ? '+' : '';
    document.getElementById('pnlPnl').innerHTML = `<span style="color:${pnlCol}">${sign}$${fmt(Math.abs(pnl))}</span>`;
    document.getElementById('pnlRoi').innerHTML = `<span style="color:${pnlCol}">${sign}${fmt(roi, 2)}%</span>`;
  } else {
    // Reverse: solve for exit price given target ROI %
    const targetRoi = parseFloat(document.getElementById('pnlTargetRoi').value);
    if (isNaN(targetRoi)) { res.classList.remove('show'); return; }
    const targetPnl  = margin * targetRoi / 100;
    // pnl = (exit - entry) * qty   (Long)   →  exit = entry + pnl/qty
    // pnl = (entry - exit) * qty   (Short)  →  exit = entry - pnl/qty
    const exitPrice = side === 'Long' ? entry + targetPnl / qty : entry - targetPnl / qty;
    const col = targetRoi >= 0 ? 'var(--success)' : 'var(--danger)';
    document.getElementById('pnlExitPrice').innerHTML = `<span style="color:${col}">$${fmt(exitPrice)}</span>`;
  }

  res.classList.add('show');
}

function calcAvg() {
  const entry    = parseFloat(document.getElementById('avgEntry').value);
  const rawSize  = parseFloat(document.getElementById('avgInvested').value);
  const newEntry = parseFloat(document.getElementById('avgNewEntry').value);
  const target   = parseFloat(document.getElementById('avgTarget').value);
  const lev      = parseFloat(document.getElementById('avgLev').value) || 1;
  const res      = document.getElementById('avgResult');
  const warnEl   = document.getElementById('avgWarnWrap');
  warnEl.innerHTML = '';

  if (!entry || !rawSize || !newEntry || !target) { res.classList.remove('show'); return; }

  // Resolve current qty (notional units)
  let qtyOld, marginOld;
  if (avgSizeMode === 'qty') {
    qtyOld    = rawSize;
    marginOld = (qtyOld * entry) / lev;
  } else {
    // rawSize = margin (USDT)
    marginOld = rawSize;
    qtyOld    = (marginOld * lev) / entry;
  }
  const notionalOld = qtyOld * entry;   // total position notional

  // Solve: (notionalOld + X_notional) / (qtyOld + X_notional/newEntry) = target
  // where X_notional is additional notional to add
  // Rearranges to: X_notional = (target * qtyOld - notionalOld) / (1 - target/newEntry)
  const numerator   = target * qtyOld - notionalOld;
  const denominator = 1 - target / newEntry;

  if (Math.abs(denominator) < 1e-10) { res.classList.remove('show'); return; }
  const addNotional = numerator / denominator;
  const addMargin   = addNotional / lev;
  const isAvgUp     = newEntry > entry;

  if (addNotional < 0) {
    // Target is not reachable by adding at this price — inform user
    res.classList.remove('show');
    const warn = document.createElement('p');
    warn.className = 'calc-result-warn';
    warn.style.cssText = 'display:block;margin-top:10px;padding:8px 10px;background:var(--amber-bg);color:var(--amber);border-radius:var(--radius);font-size:11px';
    warn.textContent = `Target average $${fmt(target)} is not reachable by adding at $${fmt(newEntry)}. Try a different new entry or target.`;
    warnEl.appendChild(warn);
    return;
  }

  const addQty      = addNotional / newEntry;
  const newQty      = qtyOld + addQty;
  const totalNotional = notionalOld + addNotional;
  const achieved    = totalNotional / newQty;

  document.getElementById('avgAdd').textContent      = '$' + fmt(addNotional);
  document.getElementById('avgAddMargin').textContent = '$' + fmt(addMargin) + ` (${lev}× lev)`;
  document.getElementById('avgNewSize').textContent  = fmt(newQty, 6) + ' units';
  document.getElementById('avgAchieved').textContent = '$' + fmt(achieved);
  document.getElementById('avgTotal').textContent    = '$' + fmt(totalNotional);

  if (isAvgUp) {
    warnEl.innerHTML = '<p style="margin-top:6px;padding:6px 8px;background:var(--amber-bg);color:var(--amber);border-radius:var(--radius);font-size:11px">Averaging up — adding at a higher price than current entry.</p>';
  }

  res.classList.add('show');
}

function calcLiq() {
  const entry = parseFloat(document.getElementById('liqEntry').value);
  const lev   = parseFloat(document.getElementById('liqLev').value);
  const side  = document.getElementById('liqSide').value;
  const mmrRaw = parseFloat(document.getElementById('liqMmr').value);
  const mmr   = isNaN(mmrRaw) ? 0.5 : mmrRaw;   // default 0.5%
  const res   = document.getElementById('liqResult');
  if (!entry || !lev) { res.classList.remove('show'); return; }

  // Cross-margin liq price estimate (simplified, linear):
  // For Long:  liqPrice = entry * (1 - 1/lev + mmr/100)
  // For Short: liqPrice = entry * (1 + 1/lev - mmr/100)
  // This matches most perp exchange formulas for cross-margin without funding.
  const mmrFrac = mmr / 100;
  let liqPrice;
  if (side === 'Long') {
    liqPrice = entry * (1 - 1 / lev + mmrFrac);
  } else {
    liqPrice = entry * (1 + 1 / lev - mmrFrac);
  }
  liqPrice = Math.max(0, liqPrice);

  const dist = Math.abs(entry - liqPrice) / entry * 100;
  const move = Math.abs(entry - liqPrice);
  const col  = dist < 10 ? 'var(--danger)' : dist < 30 ? 'var(--warning)' : 'var(--success)';

  document.getElementById('liqPrice').innerHTML = `<span style="color:${col}">$${fmt(liqPrice)}</span>`;
  document.getElementById('liqDist').innerHTML  = `<span style="color:${col}">${fmt(dist, 2)}%</span>`;
  document.getElementById('liqMove').textContent = '$' + fmt(move) + ' per unit';

  res.classList.add('show');
}
