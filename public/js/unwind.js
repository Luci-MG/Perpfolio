// unwind.js — the liquidation-after-close and unwind-simulator drawers, and the Unwind tab.

// ── Liquidation after close (sidebar drawer) ──────────────────────────────────
// Answers one question: close these positions, and where does the exchange then put the
// liquidation price of everything left?
//
// It uses `liquidationPriceAnalytic`, which reproduces Binance's published figure rather
// than what its live engine will do — the exchange freezes each margin tier at the current
// notional and solves linearly, so that is the convention to match. The panel shows the
// live agreement against the reported prices on every open, so the claim is checkable
// rather than asserted.
let liqSel = {};   // position key → % of the leg to close

async function openLiqDrawer() {
  document.getElementById('liqOverlay').classList.add('open');
  document.getElementById('liqDrawer').classList.add('open');
  document.getElementById('liqDrawerBody').innerHTML =
    `<p style="font-size:12px;color:var(--text3)">Loading the book…</p>`;
  if (!riskEngine || !riskBook?.pools) await fetchRiskBook();
  renderLiqBody();
}
function closeLiqDrawer(e) {
  if (e && e.target !== document.getElementById('liqOverlay')) return;
  closeLiqDrawerForce();
}
function closeLiqDrawerForce() {
  document.getElementById('liqOverlay').classList.remove('open');
  document.getElementById('liqDrawer').classList.remove('open');
}

function toggleLiqClose(key) {
  if (liqSel[key] != null) delete liqSel[key];
  else liqSel[key] = 100;
  renderLiqBody();
}
function setLiqPct(key, v, settled = false) {
  liqSel[key] = Math.max(0, Math.min(100, parseFloat(v) || 0));
  if (settled) renderLiqBody();
  else updateLiqOutcome(key);
}
function liqPreset(name) {
  const P = simPool();
  liqSel = {};
  if (P) for (const p of P.pool.positions) {
    if (name === 'longs'  && p.q > 0) liqSel[p.key] = 100;
    if (name === 'shorts' && p.q < 0) liqSel[p.key] = 100;
  }
  renderLiqBody();
}

function liqCloses() {
  const P = simPool();
  if (!P) return [];
  return P.pool.positions
    .filter(p => liqSel[p.key] > 0)
    .map(p => ({ key: p.key, qty: Math.abs(p.q) * liqSel[p.key] / 100 }));
}

// Binance publishes one liquidation price per symbol (both hedge legs share it).
function reportedLiqBySymbol(P) {
  const out = {};
  for (const x of P.liqCheck || []) {
    const symbol = x.key.split(':')[0];
    if (out[symbol] == null && x.reportedLiqPrice) out[symbol] = x.reportedLiqPrice;
  }
  return out;
}

function renderLiqBody() {
  const body = document.getElementById('liqDrawerBody');
  if (!body) return;
  const P = simPool();
  if (!P || !riskEngine) {
    body.innerHTML = loadErrors.risk && !riskBook ? loadErrorHtml('risk', 'fetchRiskBook(true).then(renderLiqBody)', false)
      : `<p style="font-size:12px;color:var(--text3)">No open Binance cross positions.</p>`;
    return;
  }

  const opts = { ...P.opts, feeRate: drawerFeeRate(P) };
  const reported = reportedLiqBySymbol(P);
  const state = riskEngine.evalPool(P.pool, P.marks, opts);

  // Live agreement against the exchange's own numbers. A solve sitting many multiples away
  // from the mark is an extrapolation whose precision is not meaningful — judging the model
  // on those would be judging it on arithmetic noise, so they are reported apart.
  const checks = [];
  for (const asset of Object.keys(P.marks)) {
    const symbol = P.pool.positions.find(p => p.asset === asset)?.symbol;
    const d = riskEngine.liquidationDetail(P.pool, asset, P.marks, opts);
    const rep = reported[symbol];
    if (d.price == null || !rep) continue;
    checks.push({ asset, ...d, rep, errPct: Math.abs(d.price - rep) / rep * 100 });
  }
  const solid = checks.filter(c => !c.illConditioned);
  const loose = checks.filter(c => c.illConditioned);
  const worst = solid.length ? Math.max(...solid.map(c => c.errPct)) : null;

  const looseNote = loose.length
    ? `<div class="liq-sync warn" style="background:var(--amber-bg);color:var(--amber)">
         <b>Far from the mark</b>
         <code>${loose.map(c => `${esc(c.asset)} at ${fmt(c.multipleOfMark, 1)}× mark — moves ${fmtUsd(c.movePerOnePctEquity)} per 1% of equity, ${fmt(c.errPct, 2)}% from Binance`).join(' · ')}
         — an extrapolation, directionally right but not precise to the dollar</code></div>`
    : '';

  const sync = (worst == null
    ? (loose.length ? '' : `<div class="liq-sync">No published liquidation price to compare against —
         the exchange reports none while the book is this tightly hedged.</div>`)
    : `<div class="liq-sync ${worst < 0.01 ? 'ok' : 'bad'}">
         <b>${worst < 0.01 ? 'In sync with Binance' : 'Does not match Binance'}</b>
         <code>${solid.map(c => `${esc(c.asset)} ${fmt(c.price, priceDecimals(c.price))} vs ${fmt(c.rep, priceDecimals(c.rep))}`).join(' · ')}
         — worst difference ${worst < 1e-6 ? worst.toExponential(1) : fmt(worst, 6)}%</code></div>`) + looseNote;

  const posRow = p => {
    const on = liqSel[p.key] != null;
    const dec = priceDecimals(P.marks[p.asset]);
    const det = state.positions.find(x => x.key === p.key);
    return `<div class="liq-pos${on ? ' on' : ''}" onclick="toggleLiqClose(${jsArg(p.key)})">
        <span class="liq-box">${on ? '✕' : ''}</span>
        <span class="liq-pos-main">
          <span class="liq-pos-name">${esc(p.asset)}
            ${sideBadge(p.q > 0 ? 'Long' : 'Short')}
            <span style="font-weight:400;color:var(--text3)">${esc(p.leverage)}×</span></span>
          <span class="liq-pos-sub">${fmt(Math.abs(p.q), 4)} @ ${fmt(p.entry, dec)} ·
            ${fmtUsd(det?.notional || 0)} · uPnL ${fmtSignedUsd(det?.upnl || 0)}</span>
        </span>
      </div>
      ${on ? `<div class="sim-pct" style="margin:-2px 0 8px 22px">
        <input type="range" min="5" max="100" step="5" value="${liqSel[p.key]}"
          oninput="setLiqPct(${jsArg(p.key)}, this.value)" onchange="setLiqPct(${jsArg(p.key)}, this.value, true)" onclick="event.stopPropagation()" />
        <span id="liq-pct-${p.key}">${fmt(liqSel[p.key], 0)}%</span></div>` : ''}`;
  };

  body.innerHTML = `
    <div>
      ${bookAgeHtml('renderLiqBody')}
      ${drawerPoolSwitch((riskBook?.pools || []).map(x => x.marginAsset), P.marginAsset, 'renderLiqBody')}
      ${sync}
      <div class="sim-presets">
        <button class="st-btn" onclick="liqPreset('longs')">Close all longs</button>
        <button class="st-btn" onclick="liqPreset('shorts')">Close all shorts</button>
        <button class="st-btn" onclick="liqPreset('none')">Clear</button>
      </div>
      <div class="sim-sec">Close which positions</div>
      ${P.pool.positions.map(posRow).join('')}
    </div>
    <div class="sim-out" id="liqOut">${liqOutcomeHtml(P, opts)}</div>`;
}

function liqOutcomeHtml(P, opts) {
  const r = riskEngine.liquidationAfterCloses(P.pool, P.marks, liqCloses(), opts);
  const rows = r.rows.map(row => {
    const dec = priceDecimals(row.mark);
    const show = (px, pct) => px == null
      ? `<span style="color:var(--text3)">none</span>`
      : `${fmt(px, dec)}<span class="liq-dist">${fmtSignedPct(pct, 1)} away</span>`;

    let chip = '';
    if (row.closed) chip = `<span class="liq-arrow" style="background:var(--surface2);color:var(--text3)">closed</span>`;
    else if (row.roomGained != null) {
      const better = row.roomGained >= 0;
      chip = `<span class="liq-arrow" style="background:${better ? 'var(--green-bg)' : 'var(--red-bg)'};color:${better ? 'var(--green)' : 'var(--red)'}">
        ${fmtSignedPct(row.roomGained, 1).replace('%', 'pp')}</span>`;
    } else if (row.liqBefore == null && row.liqAfter != null) {
      chip = `<span class="liq-arrow" style="background:var(--red-bg);color:var(--red)">now liquidatable</span>`;
    } else if (row.liqBefore != null && row.liqAfter == null) {
      chip = `<span class="liq-arrow" style="background:var(--green-bg);color:var(--green)">unreachable</span>`;
    }

    return `<tr>
      <td>${esc(row.asset)}<span class="liq-dist">mark ${fmt(row.mark, dec)}</span></td>
      <td>${show(row.liqBefore, row.pctBefore)}</td>
      <td>${row.closed ? '<span style="color:var(--text3)">—</span>' : show(row.liqAfter, row.pctAfter)}</td>
      <td>${chip}</td>
    </tr>`;
  }).join('');

  const anyClose = liqCloses().length > 0;
  const danger = r.rows.filter(x => !x.closed && x.roomGained != null && x.roomGained < -1);

  return `
      <div class="sim-sec">Liquidation price for what is left</div>
      <table class="liq-tbl">
        <tr><th>asset</th><th>now</th><th>after</th><th></th></tr>
        ${rows}
      </table>
      ${danger.length ? `<div class="st-banner bad" style="margin-top:10px">
        <b>Closer to liquidation.</b> <code>${danger.map(x => `${esc(x.asset)} ${fmtSignedPct(x.pctBefore, 1)} → ${fmtSignedPct(x.pctAfter, 1)}`).join('; ')}</code>
        — closing one leg of a hedge leaves the other exposed, so its liquidation price moves toward the mark.</div>` : ''}
      ${anyClose ? `
      <div class="sim-line" style="margin-top:10px"><span class="k">realises</span>
        <span class="${r.realized >= 0 ? 'up' : 'dn'}"><b>${fmtSignedUsd(r.realized)}</b></span></div>
      <div class="sim-line"><span class="k">free margin</span>
        <span>${fmtUsd(r.before.freeUsable)} → <b>${fmtUsd(r.after.freeUsable)}</b></span></div>
      <div class="sim-line"><span class="k">maintenance margin</span>
        <span>${fmtUsd(r.before.mm)} → ${fmtUsd(r.after.mm)}</span></div>
      <div class="sim-line"><span class="k">notional closed</span><span>${fmtUsd(r.notionalClosed)}</span></div>
      ${closeCostHtml(closeCost(P, liqCloses()))}`
      : `<p style="font-size:11px;color:var(--text3);padding:6px 0">Tick a position above to see where
         the exchange would move everything else.</p>`}
      <p style="font-size:10px;color:var(--text3);line-height:1.5;margin-top:10px">
        Matches Binance's published figure: the margin tier is frozen at the current notional and
        the solve is linear, which is the exchange's own convention. Its live engine re-tiers as
        notional moves — the Stress tab shows that reading. Closing a position releases its
        maintenance margin, which pushes every <i>other</i> asset's liquidation further away;
        only the symbol that loses a hedge leg moves closer. Prices assume fills at the current mark.</p>
`;
}

function updateLiqOutcome(key) {
  const P = simPool();
  const out = document.getElementById('liqOut');
  if (!P || !out || !riskEngine) return;
  const label = document.getElementById(`liq-pct-${key}`);
  if (label) label.textContent = `${fmt(liqSel[key], 0)}%`;
  out.innerHTML = liqOutcomeHtml(P, { ...P.opts, feeRate: drawerFeeRate(P) });
}

// ── Unwind simulator (sidebar drawer) ─────────────────────────────────────────
// Free-form counterpart to the Unwind tab: the tab computes an optimal plan, this lets
// you construct one by hand — close a leg, keep its hedge, and see what the remaining
// book does if the market then moves your way or against you.
let simSel  = {};     // symbol → { side: 'long'|'short'|'both'|null, pct }
let simMove = 0;      // the "then what" move applied to every mark, %

async function openSimDrawer() {
  document.getElementById('simOverlay').classList.add('open');
  document.getElementById('simDrawer').classList.add('open');
  document.getElementById('simDrawerBody').innerHTML =
    `<p style="font-size:12px;color:var(--text3)">Loading the book…</p>`;
  if (!riskEngine || !riskBook?.pools) await fetchRiskBook();
  renderSimBody();
}
function closeSimDrawer(e) {
  if (e && e.target !== document.getElementById('simOverlay')) return;
  closeSimDrawerForce();
}
function closeSimDrawerForce() {
  document.getElementById('simOverlay').classList.remove('open');
  document.getElementById('simDrawer').classList.remove('open');
}

let drawerPoolAsset = null;

const nearestKillPct = P => Math.min(Infinity, ...(P.baseline || []).flatMap(b =>
  [b.killUpPct, b.killDownPct].filter(v => v != null).map(Math.abs)));

function simPool() {
  const pools = riskBook?.pools || [];
  return pools.find(P => P.marginAsset === drawerPoolAsset)
    || [...pools].sort((a, b) => nearestKillPct(a) - nearestKillPct(b))[0] || null;
}

function setDrawerPool(asset, rerender) {
  drawerPoolAsset = asset;
  liqSel = {};
  simSel = {};
  rerender();
}

function drawerPoolSwitch(pools, current, rerender) {
  if (pools.length < 2) return '';
  return `<div class="sim-presets" role="group" aria-label="Margin pool">${pools.map(asset =>
    `<button class="st-btn${asset === current ? ' on' : ''}" onclick="setDrawerPool(${jsArg(asset)}, ${rerender})">${esc(asset)} pool</button>`).join('')}</div>`;
}

function bookAgeHtml(rerender) {
  const at = riskBook?.lastUpdated ? new Date(riskBook.lastUpdated) : null;
  if (!at) return '';
  const minutes = Math.floor((Date.now() - at) / 60_000);
  const age = minutes < 1 ? 'just now' : `${minutes}m ago`;
  return `<p class="st-note" style="margin:0 0 8px">Book from ${age} ·
    <button class="gl-link" onclick="fetchRiskBook(true).then(${rerender})">Refresh</button></p>`;
}

// Walks the live order book for a set of closes and totals what they would really cost:
// slippage against the mark plus commission. Depth is a snapshot of what the book holds
// now, not what it will hold during a move.
function closeCost(P, closes) {
  if (!P?.books) return null;
  let slip = 0, fee = 0, notional = 0, exhausted = [];
  for (const c of closes) {
    const pos = P.pool.positions.find(p => p.key === c.key);
    if (!pos) continue;
    const book = P.books[pos.asset];
    if (!book) continue;
    const levels = pos.q > 0 ? book.bids : book.asks;
    const qty = Math.min(Math.abs(c.qty ?? Math.abs(pos.q)), Math.abs(pos.q));
    const rate = uwFee != null ? uwFee / 100 : P.fees?.[pos.asset]?.taker ?? drawerFeeRate(P);
    const r = riskEngine.exitCost(levels, qty, P.marks[pos.asset], rate, pos.q > 0 ? 'sell' : 'buy');
    if (r.vwap == null) continue;
    slip += r.slipUsd; fee += r.feeUsd; notional += r.filled * r.vwap;
    if (r.exhausted) exhausted.push(`${esc(pos.asset)} ${r.remaining.toFixed(4)} unfilled`);
  }
  return { slip: +slip.toFixed(2), fee: +fee.toFixed(2), total: +(slip + fee).toFixed(2),
           notional: +notional.toFixed(2), exhausted };
}

function closeCostHtml(c) {
  if (!c) return '';
  const slip = c.slip < 0 ? `slippage ${fmtSignedUsd(c.slip)}, better than mark` : `${fmtUsd(c.slip)} slippage`;
  const thin = c.exhausted.length ? `<div class="sim-line"><span class="k" style="color:var(--warning)">book too thin</span>
    <span style="color:var(--warning)">${c.exhausted.join(', ')}</span></div>` : '';
  return `<div class="sim-line"><span class="k">cost to close, at the live book</span>
    <span class="${c.total > 0 ? 'dn' : 'up'}">${fmtSignedUsd(c.total)} <span class="k">(${slip} + ${fmtUsd(c.fee)} fees)</span></span></div>${thin}`;
}

function simGroups() {
  const P = simPool();
  if (!P) return { hedged: [], singles: [] };
  const bySymbol = {};
  for (const p of P.pool.positions) (bySymbol[p.symbol] = bySymbol[p.symbol] || []).push(p);
  const hedged = [], singles = [];
  for (const [symbol, legs] of Object.entries(bySymbol)) {
    const long = legs.find(p => p.q > 0), short = legs.find(p => p.q < 0);
    (long && short ? hedged : singles).push({ symbol, legs, long, short });
  }
  return { hedged, singles };
}

function setSimSide(symbol, side) {
  const cur = simSel[symbol] || { side: null, pct: 100 };
  simSel[symbol] = { ...cur, side: cur.side === side ? null : side };
  renderSimBody();
}
function setSimPct(symbol, v, settled = false) {
  const cur = simSel[symbol] || { side: null, pct: 100 };
  simSel[symbol] = { ...cur, pct: Math.max(0, Math.min(100, parseFloat(v) || 0)) };
  if (settled) return renderSimBody();
  const label = document.getElementById(`sim-pct-${symbol}`);
  if (label) label.textContent = `${fmt(simSel[symbol].pct, 0)}%`;
  updateSimOutcome();
}
function setSimMove(v) {
  simMove = parseFloat(v) || 0;
  updateSimOutcome();
}
function simPreset(name) {
  const { hedged, singles } = simGroups();
  simSel = {};
  if (name === 'tp-longs')  hedged.forEach(g => { simSel[g.symbol] = { side: 'long',  pct: 100 }; });
  if (name === 'tp-shorts') hedged.forEach(g => { simSel[g.symbol] = { side: 'short', pct: 100 }; });
  if (name === 'matched')   hedged.forEach(g => { simSel[g.symbol] = { side: 'both',  pct: 100 }; });
  if (name === 'all') {
    hedged.forEach(g => { simSel[g.symbol] = { side: 'both', pct: 100 }; });
    singles.forEach(g => { simSel[g.symbol] = { side: g.long ? 'long' : 'short', pct: 100 }; });
  }
  renderSimBody();
}

// The set of closes the current selection implies. 'both' closes the matched portion, so
// the legs stay hedged against each other down to whatever is left.
function simCloses() {
  const { hedged, singles } = simGroups();
  const closes = [];
  for (const g of [...hedged, ...singles]) {
    const sel = simSel[g.symbol];
    if (!sel?.side || !sel.pct) continue;
    const f = sel.pct / 100;
    if (sel.side === 'both') {
      const matched = Math.min(Math.abs(g.long.q), Math.abs(g.short.q)) * f;
      closes.push({ key: g.long.key, qty: matched }, { key: g.short.key, qty: matched });
    } else {
      const leg = sel.side === 'long' ? g.long : g.short;
      if (leg) closes.push({ key: leg.key, qty: Math.abs(leg.q) * f });
    }
  }
  return closes;
}

function simState() {
  const P = simPool();
  const opts = { ...P.opts, feeRate: drawerFeeRate(P) };
  const before = riskEngine.evalPool(P.pool, P.marks, opts);
  const r = riskEngine.closePositions(P.pool, P.marks, simCloses(), opts.feeRate);
  const after = riskEngine.evalPool(r.pool, P.marks, opts);
  return { P, opts, before, after, ...r };
}

function renderSimBody() {
  const P = simPool();
  const body = document.getElementById('simDrawerBody');
  if (!body) return;
  if (!P || !riskEngine) {
    body.innerHTML = loadErrors.risk && !riskBook ? loadErrorHtml('risk', 'fetchRiskBook(true).then(renderSimBody)', false)
      : `<p style="font-size:12px;color:var(--text3)">No open Binance cross positions.</p>`;
    return;
  }

  const { hedged, singles } = simGroups();
  const btn = (label, name) => `<button class="st-btn" onclick="simPreset(${jsArg(name)})">${label}</button>`;

  const row = g => {
    const sel = simSel[g.symbol] || { side: null, pct: 100 };
    const opt = (side, label, cls) =>
      `<button class="sim-opt${sel.side === side ? ' on ' + (cls || '') : ''}"
        onclick="setSimSide(${jsArg(g.symbol)},${jsArg(side)})">${label}</button>`;
    const dec = priceDecimals(P.marks[g.legs[0].asset]);
    const legTxt = g.long && g.short
      ? `long ${fmt(Math.abs(g.long.q), 4)} / short ${fmt(Math.abs(g.short.q), 4)}`
      : `${g.long ? 'long' : 'short'} ${fmt(Math.abs((g.long || g.short).q), 4)}`;

    return `<div class="sim-row">
      <div class="sim-row-head"><span>${g.legs[0].asset}</span>
        <span class="sim-row-legs">${legTxt} @ ${fmt(P.marks[g.legs[0].asset], dec)}</span></div>
      <div class="sim-opts">
        ${g.long  ? opt('long',  'close long',  'long')  : ''}
        ${g.short ? opt('short', 'close short', 'short') : ''}
        ${g.long && g.short ? opt('both', 'matched') : ''}
      </div>
      ${sel.side ? `<div class="sim-pct">
        <input type="range" min="0" max="100" step="5" value="${sel.pct}"
          oninput="setSimPct(${jsArg(g.symbol)}, this.value)" onchange="setSimPct(${jsArg(g.symbol)}, this.value, true)" />
        <span id="sim-pct-${esc(g.symbol)}">${fmt(sel.pct, 0)}%</span></div>` : ''}
    </div>`;
  };

  body.innerHTML = `
    <div>
      ${bookAgeHtml('renderSimBody')}
      ${drawerPoolSwitch((riskBook?.pools || []).map(x => x.marginAsset), P.marginAsset, 'renderSimBody')}
      <div class="sim-presets">
        ${btn('TP the hedge longs', 'tp-longs')}
        ${btn('TP the hedge shorts', 'tp-shorts')}
        ${btn('Close matched', 'matched')}
        ${btn('Close everything', 'all')}
        ${btn('Reset', 'none')}
      </div>
      ${hedged.length ? `<div class="sim-sec">Hedged symbols — margin is charged on both legs</div>${hedged.map(row).join('')}` : ''}
      ${singles.length ? `<div class="sim-sec">Single legs</div>${singles.map(row).join('')}` : ''}
    </div>
    <div class="sim-out" id="simOut"></div>`;

  updateSimOutcome();
}

// Patched on its own so the "then what" slider stays smooth.
function updateSimOutcome() {
  const out = document.getElementById('simOut');
  if (!out || !simPool() || !riskEngine) return;

  const { P, opts, before, after, realized, fees, notionalClosed, pool: leftPool } = simState();
  const closes = simCloses();

  const netBefore = riskEngine.netDeltas(P.pool, P.marks);
  const netAfter  = riskEngine.netDeltas(leftPool, P.marks);
  const deltaRows = Object.keys(P.marks).map(a => {
    const b = netBefore[a] || 0, n = netAfter[a] || 0;
    if (Math.abs(b) < 1 && Math.abs(n) < 1) return '';
    return `<div class="sim-line"><span class="k">${a}</span>
      <span>${fmtPlusUsd(b)} → <b class="${n >= 0 ? 'up' : 'dn'}">${fmtPlusUsd(n)}</b></span></div>`;
  }).join('');

  // then what: every mark moves together, applied to whatever is still open
  const moved = Object.fromEntries(Object.entries(P.marks).map(([a, p]) => [a, p * (1 + simMove / 100)]));
  const atMove = riskEngine.evalPool(leftPool, moved, opts);
  const openPnl = atMove.equity - after.equity;
  const thresholds = Object.keys(P.marks).map(a => {
    const k = riskEngine.killPricesBoth(leftPool, a, P.marks, opts).buffer;
    const bits = [k.up != null ? fmtSignedPct(k.upPct, 0) : null, k.down != null ? fmtSignedPct(k.downPct, 0) : null]
      .filter(Boolean).join(' / ');
    return bits ? `${a} ${bits}` : null;
  }).filter(Boolean).join(' · ');

  const statusChip = atMove.liquidated
    ? `<span class="sim-chip" style="background:var(--red-bg);color:var(--red)">liquidated</span>`
    : atMove.usedPct > 50
      ? `<span class="sim-chip" style="background:var(--amber-bg);color:var(--amber)">${fmt(atMove.usedPct, 0)}% used</span>`
      : `<span class="sim-chip" style="background:var(--green-bg);color:var(--green)">${fmt(atMove.usedPct, 0)}% used</span>`;

  out.innerHTML = `
    <div class="sim-sec">If you close that</div>
    <div class="sim-line"><span class="k">free margin</span>
      <span>${fmtUsd(before.freeUsable)} → <b class="sim-big">${fmtUsd(after.freeUsable)}</b></span></div>
    <div class="sim-line"><span class="k">liquidation buffer</span>
      <span>${fmtSignedUsd(before.buffer)} → <b>${fmtSignedUsd(after.buffer)}</b></span></div>
    <div class="sim-line"><span class="k">realises</span>
      <span class="${realized >= 0 ? 'up' : 'dn'}"><b>${fmtPlusUsd(realized)}</b></span></div>
    <div class="sim-line"><span class="k">notional closed</span><span>${fmtUsd(notionalClosed)}</span></div>
    ${closes.length ? closeCostHtml(closeCost(P, closes)) : ''}
    <div class="sim-line"><span class="k">equity</span>
      <span>${fmtUsd(before.equity)} → ${fmtUsd(after.equity)} <span class="k">(fees only)</span></span></div>

    ${closes.length ? `<div class="sim-sec" style="margin-top:14px">Net delta left per coin</div>${deltaRows}
    <div class="sim-line"><span class="k">gross exposure</span>
      <span>${fmtUsd(riskEngine.grossNetDelta(P.pool, P.marks))} → <b>${fmtUsd(riskEngine.grossNetDelta(leftPool, P.marks))}</b></span></div>`
    : `<p style="font-size:11px;color:var(--text3);padding:6px 0">Nothing selected — pick a leg above.</p>`}

    <div class="sim-sec" style="margin-top:16px">Then the market moves</div>
    <div class="sim-pct">
      <input type="range" min="-50" max="50" step="0.5" value="${simMove}" oninput="setSimMove(this.value)" />
      <span>${fmtSignedPct(simMove, 1)}</span>
    </div>
    <div class="sim-line"><span class="k">uPnL on what's left</span>
      <span class="${openPnl >= 0 ? 'up' : 'dn'}"><b class="sim-big">${fmtPlusUsd(openPnl)}</b></span></div>
    <div class="sim-line"><span class="k">equity there</span><span>${fmtUsd(atMove.equity)}</span></div>
    <div class="sim-line"><span class="k">buffer there</span>
      <span class="${atMove.buffer < 0 ? 'dn' : ''}">${fmtSignedUsd(atMove.buffer)} ${statusChip}</span></div>
    <div class="sim-line"><span class="k">free there</span><span>${fmtUsd(atMove.freeUsable)}</span></div>
    <p style="font-size:10px;color:var(--text3);line-height:1.5;margin-top:8px">
      Every mark moves together by that percentage — use the Stress tab for beta-linked moves.
      Liquidation on what's left: ${thresholds || 'none within range'}.
      Closes are priced at the current mark; slippage is not modelled.</p>`;
}

// ── Unwind planner ────────────────────────────────────────────────────────────
// Closing a position leaves equity untouched — realised PnL replaces unrealised one for
// one — so what a close buys is margin: initial margin becomes free margin, maintenance
// margin becomes liquidation buffer. Free margin is bounded by equity however much is
// closed, which is why the ceiling leads the panel.
let unwindData    = null;
let unwindLoading = false;
let uwObjective   = 'free';
let uwTarget      = '';
let uwMaxLoss     = '';
let uwFee         = null;
let uwBreakHedges = false;

let unwindQuery = null;
let unwindSeq = 0;

const accountFeePct = () => {
  const rate = unwindData?.plans?.[0]?.fee?.rate;
  return rate == null ? null : +(rate * 100).toFixed(4);
};

function drawerFeeRate(P) {
  if (uwFee != null) return uwFee / 100;
  return Math.max(0, ...Object.values(P.fees || {}).map(f => f?.taker ?? 0));
}

async function fetchUnwind() {
  let query = null;
  const seq = ++unwindSeq;
  unwindLoading = true;
  if (posView === 'unwind') rerenderStress();
  try {
    const q = [
      `objective=${uwObjective}`,
      uwFee != null ? `fee=${uwFee / 100}` : '',
      `breakHedges=${uwBreakHedges}`,
      uwTarget  !== '' ? `target=${encodeURIComponent(uwTarget)}`   : '',
      uwMaxLoss !== '' ? `maxLoss=${encodeURIComponent(uwMaxLoss)}` : ''
    ].filter(Boolean).join('&');
    query = q;
    const res  = await fetch(`/api/deleverage?${q}`);
    const data = await res.json();
    if (seq !== unwindSeq) return;
    if (!data.ok) throw new Error(data.error || 'deleverage failed');
    unwindData = data;
    unwindQuery = q;
    clearLoadError('unwind');
  } catch (err) {
    if (seq !== unwindSeq) return;
    noteLoadError('unwind', err);
    if (query !== unwindQuery) unwindData = null;
  } finally {
    if (seq === unwindSeq) {
      unwindLoading = false;
      if (posView === 'unwind') rerenderStress();
    }
  }
}

function setUw(field, value) {
  if (field === 'objective')   uwObjective   = value;
  if (field === 'target')      uwTarget      = value;
  if (field === 'maxLoss')     uwMaxLoss     = value;
  if (field === 'fee') {
    const pct = parseFloat(value);
    uwFee = Number.isFinite(pct) ? Math.max(0, Math.min(1, pct)) : null;
  }
  if (field === 'breakHedges') uwBreakHedges = !uwBreakHedges;
  fetchUnwind();
}

function renderUnwindControls() {
  const btn = (label, on, onclick, title) =>
    `<button class="st-btn${on ? ' on' : ''}" onclick="${onclick}" title="${title}">${label}</button>`;
  return `<div class="st-controls" id="uw-mounted">
    ${btn('Free margin', uwObjective === 'free', "setUw('objective','free')",
          'Rank closes by the initial margin they release')}
    ${btn('Liquidation buffer', uwObjective === 'buffer', "setUw('objective','buffer')",
          'Rank closes by the maintenance margin they release')}
    <span class="st-sep"></span>
    <label>Target $
      <input type="number" step="100" value="${uwTarget}" placeholder="max"
        onchange="setUw('target', this.value)" style="width:76px" /></label>
    <label>Max loss $
      <input type="number" step="1000" value="${uwMaxLoss}" placeholder="none"
        onchange="setUw('maxLoss', this.value)" style="width:76px" /></label>
    <label title="Empty uses your account's taker rate">Fee %
      <input type="number" step="0.005" value="${uwFee ?? ''}" placeholder="${accountFeePct() ?? 'yours'}"
        onchange="setUw('fee', this.value)" style="width:60px" /></label>
    <span class="st-sep"></span>
    ${btn('Allow breaking hedges', uwBreakHedges, "setUw('breakHedges')",
          'Off by default: a step that leaves the other leg naked is refused, however much margin it would free')}
  </div>`;
}

function renderUnwindPlan(p) {
  const c = p.ceiling;
  const gainKey = p.objective === 'buffer' ? 'bufferGain' : 'freeGain';
  const gainLbl = p.objective === 'buffer' ? 'buffer' : 'free';

  const ceilingStrip = `<div class="uw-ceiling">
    <span><span class="k">equity</span><b>${fmtUsd(c.equity)}</b></span>
    <span><span class="k">free now</span><b>${fmtUsd(c.currentFree)}</b></span>
    <span><span class="k">releasable margin</span><b>${fmtUsd(c.releasableIm)}</b></span>
    <span><span class="k">ceiling on free margin</span><b>${fmtUsd(c.maxFree)}</b></span>
    <span style="color:var(--text3)">equity − reserved ${fmtUsd(c.reserved)} − fees ${fmtUsd(c.closeAllFees)};
      closing a position never changes equity</span>
  </div>`;

  const aboveCeiling = p.targetAboveCeiling ? `<div class="st-banner warn">
    <b>Target is above the ceiling.</b> <code>${fmtUsd(p.target)} asked, ${fmtUsd(c.maxFree)} is the most
    any combination of closes can free</code> — free margin is capped by equity, so the gap
    (${fmtUsd(p.shortfall)}) needs equity growth, fresh collateral, or cancelled orders instead.</div>` : '';

  const blocked = p.blocked ? `<div class="st-banner ${p.blocked.unsafeGainAvailable > 0 ? 'bad' : 'warn'}">
    <b>Stopped early.</b> <code>${p.blocked.reason}</code>
    ${p.blocked.capNeededForNextSafeStep != null
      ? `Raise the max loss to ${fmtUsd(p.blocked.capNeededForNextSafeStep)} to take the cheapest close that leaves no leg naked.` : ''}
    ${p.blocked.unsafeGainAvailable > 0
      ? `A step worth ${fmtUsd(p.blocked.unsafeGainAvailable)} was refused because it would have increased naked exposure.` : ''}</div>` : '';

  const rows = p.steps.map((s, i) => {
    const neutral = s.deltaShift <= 1;
    const col = neutral ? 'var(--success)' : 'var(--danger)';
    return `<tr>
      <td>${i + 1}</td>
      <td><b>${s.type === 'matched-hedge' ? 'close matched hedge' : 'close leg'}</b>
        <div class="uw-legs">${s.legs.map(l => `${esc(l.asset)} ${l.positionSide.toLowerCase()} ${fmt(l.qty, 4)}${l.qty < l.ofQty ? ` of ${fmt(l.ofQty, 4)}` : ''}`).join(' + ')}</div></td>
      <td class="num" style="color:var(--success)">${fmtPlusUsd(s[gainKey])}</td>
      <td class="num"><span class="uw-badge" style="background:${col}22;color:${col}">${fmtPlusUsd(s.deltaShift)}</span></td>
      <td class="num ${s.realized >= 0 ? 'up' : 'dn'}">${fmtPlusUsd(s.realized)}</td>
      <td class="num" style="color:var(--text3)">${fmtUsd(s.notionalClosed)}</td>
      <td class="num">${fmtUsd(p.objective === 'buffer' ? s.cumulativeBuffer : s.cumulativeFree)}</td>
    </tr>`;
  }).join('');

  const after = p.thresholdsAfter.map(t =>
    `${esc(t.asset)} ${t.upPct == null && t.downPct == null ? 'none'
      : [t.upPct != null ? `+${fmt(t.upPct, 0)}%` : null, t.downPct != null ? `${fmt(t.downPct, 0)}%` : null].filter(Boolean).join(' / ')}`
  ).join(' · ');

  return `${ceilingStrip}${aboveCeiling}${blocked}
    ${p.steps.length ? `<table class="uw-steps">
      <tr><th></th><th>action</th><th style="text-align:right">${gainLbl}</th>
          <th style="text-align:right">Δ exposure</th><th style="text-align:right">realises</th>
          <th style="text-align:right">notional</th><th style="text-align:right">${gainLbl} after</th></tr>
      ${rows}</table>`
      : `<p style="font-size:12px;color:var(--text3);padding:10px 0">No close improves ${gainLbl} under these constraints.</p>`}
    <div class="hedge-naked">
      <span><span class="k">${gainLbl}</span> ${fmtSignedUsd(p.before[p.objective === 'buffer' ? 'buffer' : 'free'])} → <b>${fmtSignedUsd(p.after[p.objective === 'buffer' ? 'buffer' : 'free'])}</b></span>
      <span><span class="k">gross exposure</span> ${fmtUsd(p.before.gross)} → ${fmtUsd(p.after.gross)}</span>
      <span><span class="k">realised in total</span> <span class="${p.realized >= 0 ? 'up' : 'dn'}">${fmtPlusUsd(p.realized)}</span></span>
      <span><span class="k">fees</span> ${fmtUsd(p.fees)}</span>
      <span><span class="k">equity</span> ${fmtUsd(p.before.equity)} → ${fmtUsd(p.after.equity)}</span>
    </div>
    <div class="st-note">Equity moves only by the fees — realising a loss converts unrealised into realised
      and the margin balance is identical. <b>Δ exposure</b> is the change in gross directional exposure:
      negative means the close reduced it, positive means a leg was left naked.
      Liquidation after the plan: ${after || '—'}.
      ${p.remaining.length ? `Left standing: ${p.remaining.map(r => `${esc(r.asset)} ${r.positionSide.toLowerCase()} ${fmtUsd(r.notional)}`).join(', ')}.` : 'Nothing left standing.'}
      Ordering assumes each close fills at the current mark; slippage is not modelled.</div>`;
}

function renderUnwind() {
  if (!venueOn('binance')) return venueOffHtml('binance');
  if (unwindLoading && !unwindData) {
    return `<p style="font-size:12px;color:var(--text3);padding:14px 0">Planning…</p>`;
  }
  if (!unwindData) {
    return loadErrors.unwind ? `${renderUnwindControls()}${loadErrorHtml('unwind', 'fetchUnwind()', false)}`
      : `<p style="font-size:12px;color:var(--text3);padding:14px 0">No plan yet.</p>`;
  }
  const stale = loadErrorHtml('unwind', 'fetchUnwind()', true);
  if (!unwindData.plans?.length) {
    return `${renderUnwindControls()}${stale}<p style="font-size:12px;color:var(--text3);padding:14px 0">No open Binance cross positions.</p>`;
  }
  return renderUnwindControls() + stale + unwindData.plans.map(p => `<div style="margin-bottom:22px">
    ${unwindData.plans.length > 1 ? `<p class="section-label" style="margin:0 0 8px">${esc(p.marginAsset)} pool</p>` : ''}
    ${renderUnwindPlan(p)}</div>`).join('');
}
