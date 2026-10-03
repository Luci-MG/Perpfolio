// unwind.js — the Unwind tool: a plan the engine proposes, a build you adjust by hand, and one
// readout for either, all computed from the risk book with the engine the server uses.

let uwMode        = 'plan';
let uwObjective   = 'free';
let uwTarget      = '';
let uwMaxLoss     = '';
let uwFee         = null;
let uwBreakHedges = false;
let uwSel         = {};
let uwFromPlan    = false;
let uwMove        = 0;
let uwMoveBeta    = false;
let uwLastPlan    = null;

function uwOpts(P) {
  const given = uwFee != null ? uwFee / 100 : null;
  const assets = Object.keys(P.marks);
  const fees = Object.fromEntries(assets.map(a => [a, given ?? P.fees?.[a]?.taker ?? 0]));
  const betas = Object.fromEntries(assets.map(a => [a, P.stats?.[a]?.beta ?? 1]));
  return { ...P.opts, books: P.books || {}, fees, feeRate: Math.max(0, ...Object.values(fees)), betas };
}

const poolFeePct = P => +(Math.max(0, ...Object.values(P.fees || {}).map(f => f?.taker ?? 0)) * 100).toFixed(4);

function uwPlan(P, opts) {
  const target = parseFloat(uwTarget);
  const maxLoss = Math.abs(parseFloat(uwMaxLoss));
  return riskEngine.deleveragePlan(P.pool, P.marks, {
    ...opts, objective: uwObjective,
    target: Number.isFinite(target) ? target : Infinity,
    maxRealizedLoss: Number.isFinite(maxLoss) ? maxLoss : Infinity,
    allowBreakingHedges: uwBreakHedges
  });
}

function uwCloses(P) {
  return P.pool.positions
    .filter(p => uwSel[p.key] > 0)
    .map(p => ({ key: p.key, qty: Math.abs(p.q) * uwSel[p.key] / 100 }));
}

function pruneUwSel(P) {
  const live = new Set(P.pool.positions.map(p => p.key));
  Object.keys(uwSel).forEach(k => { if (!live.has(k)) delete uwSel[k]; });
}

function uwGroups(P) {
  const bySymbol = {};
  for (const p of P.pool.positions) (bySymbol[p.symbol] = bySymbol[p.symbol] || []).push(p);
  return Object.entries(bySymbol)
    .map(([symbol, legs]) => ({ symbol, legs, long: legs.find(p => p.q > 0), short: legs.find(p => p.q < 0) }))
    .sort((a, b) => (b.long && b.short ? 1 : 0) - (a.long && a.short ? 1 : 0));
}

function setUwMode(mode) { uwMode = mode; rerenderStress(); }

function setUw(field, value) {
  if (field === 'objective')   { uwObjective = value; uwTarget = ''; }
  if (field === 'target')      uwTarget  = value;
  if (field === 'maxLoss')     uwMaxLoss = value;
  if (field === 'fee') {
    const pct = parseFloat(value);
    uwFee = Number.isFinite(pct) ? Math.max(0, Math.min(1, pct)) : null;
  }
  if (field === 'breakHedges') uwBreakHedges = !uwBreakHedges;
  rerenderStress();
}

function uwPoolChanged() {
  uwSel = {};
  uwFromPlan = false;
  rerenderStress();
}

function uwToggle(key) {
  if (uwSel[key] != null) delete uwSel[key];
  else uwSel[key] = 100;
  uwFromPlan = false;
  rerenderStress();
}

function uwSetPct(key, v, settled = false) {
  uwSel[key] = Math.max(0, Math.min(100, parseFloat(v) || 0));
  uwFromPlan = false;
  if (settled) return rerenderStress();
  const label = document.getElementById(`uw-pct-${key}`);
  if (label) label.textContent = `${fmt(uwSel[key], 0)}%`;
  updateUwOut();
}

function uwMatched(symbol) {
  const g = uwGroups(drawerPool()).find(x => x.symbol === symbol);
  if (!g?.long || !g.short) return;
  const matched = Math.min(Math.abs(g.long.q), Math.abs(g.short.q));
  uwSel[g.long.key]  = matched / Math.abs(g.long.q) * 100;
  uwSel[g.short.key] = matched / Math.abs(g.short.q) * 100;
  uwFromPlan = false;
  rerenderStress();
}

function uwPreset(name) {
  uwSel = {};
  uwFromPlan = false;
  for (const g of uwGroups(drawerPool())) {
    const hedged = g.long && g.short;
    const matched = hedged ? Math.min(Math.abs(g.long.q), Math.abs(g.short.q)) : 0;
    if (name === 'hedge-longs'  && hedged) uwSel[g.long.key]  = 100;
    if (name === 'hedge-shorts' && hedged) uwSel[g.short.key] = 100;
    if (name === 'matched' && hedged) {
      uwSel[g.long.key]  = matched / Math.abs(g.long.q) * 100;
      uwSel[g.short.key] = matched / Math.abs(g.short.q) * 100;
    }
    if (name === 'all') g.legs.forEach(p => { uwSel[p.key] = 100; });
  }
  rerenderStress();
}

function uwEditPlan() {
  const P = drawerPool();
  uwSel = {};
  for (const c of uwLastPlan?.closes || []) {
    const pos = P.pool.positions.find(p => p.key === c.key);
    if (pos) uwSel[c.key] = Math.min(100, c.qty / Math.abs(pos.q) * 100);
  }
  uwMode = 'build';
  uwFromPlan = true;
  rerenderStress();
}

function setUwMove(v) {
  uwMove = parseFloat(v) || 0;
  const label = document.getElementById('uw-move-pct');
  if (label) label.textContent = fmtSignedPct(uwMove, 1);
  updateUwMoveOut();
}

function toggleUwMoveBeta() {
  uwMoveBeta = !uwMoveBeta;
  updateUwOut();
}

function uwState() {
  const P = drawerPool();
  if (!P || !riskEngine) return null;
  const opts = uwOpts(P);
  const closes = uwMode === 'plan' ? (uwLastPlan?.closes || []) : uwCloses(P);
  return { P, opts, closes };
}

function updateUwOut() {
  const s = uwState(), out = document.getElementById('uwOut');
  if (s && out) out.innerHTML = uwOutHtml(s.P, s.opts, s.closes);
}

function updateUwMoveOut() {
  const s = uwState(), out = document.getElementById('uwMoveOut');
  if (s && out) out.innerHTML = uwMoveOutHtml(s.P, s.opts, riskEngine.unwindOutcome(s.P.pool, s.P.marks, s.closes, s.opts).pool);
}

function reportedLiqBySymbol(P) {
  const out = {};
  for (const x of P.liqCheck || []) {
    const symbol = x.key.split(':')[0];
    if (out[symbol] == null && x.reportedLiqPrice) out[symbol] = x.reportedLiqPrice;
  }
  return out;
}

function uwAgreementHtml(P, opts) {
  const reported = reportedLiqBySymbol(P);
  const checks = Object.keys(P.marks).map(asset => {
    const symbol = P.pool.positions.find(p => p.asset === asset)?.symbol;
    const d = riskEngine.liquidationDetail(P.pool, asset, P.marks, opts);
    const rep = reported[symbol];
    return d.price == null || !rep ? null : { asset, ...d, rep, errPct: Math.abs(d.price - rep) / rep * 100 };
  }).filter(Boolean);
  const solid = checks.filter(c => !c.illConditioned);
  const loose = checks.filter(c => c.illConditioned);
  const worst = solid.length ? Math.max(...solid.map(c => c.errPct)) : null;
  const looseNote = loose.length
    ? ` · ${loose.map(c => `${esc(c.asset)} at ${fmt(c.multipleOfMark, 1)}× mark`).join(', ')} is an extrapolation, not precise to the dollar`
    : '';
  if (worst == null) {
    return `<div class="liq-sync">No published liquidation price to compare against${looseNote}</div>`;
  }
  return `<div class="liq-sync ${worst < 0.01 ? 'ok' : 'bad'}"><b>${worst < 0.01 ? 'In sync with Binance' : 'Does not match Binance'}</b>
    <code>worst difference ${worst < 1e-6 ? worst.toExponential(1) : fmt(worst, 6)}%${looseNote}</code></div>`;
}

function uwLiqTableHtml(r) {
  const chip = (bg, fg, text) => `<span class="liq-arrow" style="background:var(${bg});color:var(${fg})">${text}</span>`;
  const rows = r.rows.map(row => {
    const dec = priceDecimals(row.mark);
    const show = (px, pct) => px == null
      ? `<span style="color:var(--text3)">none</span>`
      : `${fmt(px, dec)}<span class="liq-dist">${fmtSignedPct(pct, 1)} away</span>`;
    const room = row.roomGained != null && fmtSignedPct(row.roomGained, 1).replace('%', 'pp');
    const tag = row.closed ? chip('--surface2', '--text3', 'closed')
      : row.roomGained != null ? (row.roomGained >= 0 ? chip('--green-bg', '--green', room) : chip('--red-bg', '--red', room))
      : row.liqBefore == null && row.liqAfter != null ? chip('--red-bg', '--red', 'now liquidatable')
      : row.liqBefore != null && row.liqAfter == null ? chip('--green-bg', '--green', 'unreachable') : '';
    return `<tr>
      <td>${esc(row.asset)}<span class="liq-dist">mark ${fmt(row.mark, dec)}</span></td>
      <td>${show(row.liqBefore, row.pctBefore)}</td>
      <td>${row.closed ? '<span style="color:var(--text3)">—</span>' : show(row.liqAfter, row.pctAfter)}</td>
      <td>${tag}</td>
    </tr>`;
  }).join('');
  const closer = r.rows.filter(x => !x.closed && x.roomGained != null && x.roomGained < -1);
  return `<table class="liq-tbl"><tr><th>asset</th><th>now</th><th>after</th><th></th></tr>${rows}</table>
    ${closer.length ? `<div class="st-banner bad" style="margin-top:10px">
      <b>Closer to liquidation.</b> <code>${closer.map(x => `${esc(x.asset)} ${fmtSignedPct(x.pctBefore, 1)} → ${fmtSignedPct(x.pctAfter, 1)}`).join('; ')}</code>
      — closing one leg of a hedge leaves the other exposed.</div>` : ''}`;
}

function uwCostHtml(cost) {
  const slip = cost.slip < 0 ? `slippage ${fmtSignedUsd(cost.slip)}, better than mark` : `${fmtUsd(cost.slip)} slippage`;
  const thin = cost.thin.length ? `<div class="sim-line"><span class="k" style="color:var(--warning)">book too thin</span>
    <span style="color:var(--warning)">${cost.thin.map(t => `${esc(t.asset)} ${fmt(t.unfilled, 4)} unfilled`).join(', ')}</span></div>` : '';
  return `<div class="sim-line"><span class="k">cost to close, at the live book</span>
    <span class="${cost.total > 0 ? 'dn' : 'up'}">${fmtSignedUsd(cost.total)} <span class="k">(${slip} + ${fmtUsd(cost.fee)} fees)</span></span></div>${thin}`;
}

function uwMovedMarks(P, opts) {
  return Object.fromEntries(Object.entries(P.marks).map(([a, p]) =>
    [a, Math.max(p * 0.001, p * (1 + uwMove * (uwMoveBeta ? opts.betas[a] ?? 1 : 1) / 100))]));
}

function uwMoveOutHtml(P, opts, left) {
  const after = riskEngine.evalPool(left, P.marks, opts);
  const atMove = riskEngine.evalPool(left, uwMovedMarks(P, opts), opts);
  const tone = atMove.usedPct > 50 ? 'amber' : 'green';
  const chip = atMove.liquidated
    ? `<span class="sim-chip" style="background:var(--red-bg);color:var(--red)">liquidated</span>`
    : `<span class="sim-chip" style="background:var(--${tone}-bg);color:var(--${tone})">${fmt(atMove.usedPct, 0)}% used</span>`;
  const pnl = atMove.equity - after.equity;
  return `<div class="sim-line"><span class="k">uPnL on what's left</span>
      <span class="${pnl >= 0 ? 'up' : 'dn'}"><b class="sim-big">${fmtPlusUsd(pnl)}</b></span></div>
    <div class="sim-line"><span class="k">equity there</span><span>${fmtUsd(atMove.equity)}</span></div>
    <div class="sim-line"><span class="k">buffer there</span>
      <span class="${atMove.buffer < 0 ? 'dn' : ''}">${fmtSignedUsd(atMove.buffer)} ${chip}</span></div>
    <div class="sim-line"><span class="k">free there</span><span>${fmtUsd(atMove.freeUsable)}</span></div>`;
}

function uwOutHtml(P, opts, closes) {
  const r = riskEngine.unwindOutcome(P.pool, P.marks, closes, opts);
  const any = closes.length > 0;
  const exposure = Object.keys(P.marks).map(a => {
    const b = r.netBefore[a] || 0, n = r.netAfter[a] || 0;
    if (Math.abs(b) < 1 && Math.abs(n) < 1) return '';
    return `<div class="sim-line"><span class="k">${esc(a)}</span>
      <span>${fmtPlusUsd(b)} → <b class="${n >= 0 ? 'up' : 'dn'}">${fmtPlusUsd(n)}</b></span></div>`;
  }).join('');
  const assumed = uwFee == null && Object.values(P.fees || {}).some(f => f?.assumed)
    ? `<p class="st-note" style="margin:4px 0 0">Fees assumed at ${fmt(poolFeePct(P), 3)}% — your rate could not be read.</p>` : '';
  const empty = uwMode === 'plan' ? 'The plan takes no step.' : 'Nothing selected — pick a position.';

  return `
    <div class="sim-sec">${uwMode === 'plan' ? 'After the plan' : 'If you close that'}</div>
    ${any ? '' : `<p style="font-size:11px;color:var(--text3);padding:2px 0 6px">${empty}</p>`}
    <div class="sim-line"><span class="k">free margin</span>
      <span>${fmtUsd(r.before.freeUsable)} → <b class="sim-big">${fmtUsd(r.after.freeUsable)}</b></span></div>
    <div class="sim-line"><span class="k">liquidation buffer</span>
      <span>${fmtSignedUsd(r.before.buffer)} → <b>${fmtSignedUsd(r.after.buffer)}</b></span></div>
    ${any ? `<div class="sim-line"><span class="k">realises</span>
      <span class="${r.realized >= 0 ? 'up' : 'dn'}"><b>${fmtPlusUsd(r.realized)}</b></span></div>
    <div class="sim-line"><span class="k">notional closed</span><span>${fmtUsd(r.notionalClosed)}</span></div>
    ${uwCostHtml(r.cost)}${assumed}
    <div class="sim-line"><span class="k">equity</span>
      <span>${fmtUsd(r.before.equity)} → ${fmtUsd(r.after.equity)} <span class="k">(exit cost only)</span></span></div>` : ''}

    <div class="sim-sec" style="margin-top:14px">Net exposure</div>
    ${exposure}
    <div class="sim-line"><span class="k">gross, per coin</span>
      <span>${fmtUsd(r.grossBefore)} → <b>${fmtUsd(r.grossAfter)}</b></span></div>
    <div class="sim-line"><span class="k">in BTC terms, by beta</span>
      <span>${fmtPlusUsd(r.betaBefore)} → <b>${fmtPlusUsd(r.betaAfter)}</b></span></div>

    <div class="sim-sec" style="margin-top:14px">Liquidation price</div>
    ${uwAgreementHtml(P, opts)}
    ${uwLiqTableHtml(r)}

    <div class="sim-sec" style="margin-top:16px">Then the market moves</div>
    <div class="sim-presets" style="margin-bottom:4px" role="group" aria-label="How the market moves">
      <button class="st-btn${uwMoveBeta ? '' : ' on'}" onclick="${uwMoveBeta ? 'toggleUwMoveBeta()' : ''}">every coin alike</button>
      <button class="st-btn${uwMoveBeta ? ' on' : ''}" onclick="${uwMoveBeta ? '' : 'toggleUwMoveBeta()'}">by beta to BTC</button>
    </div>
    <div class="sim-pct">
      <input type="range" min="-50" max="50" step="0.5" value="${uwMove}" oninput="setUwMove(this.value)" />
      <span id="uw-move-pct">${fmtSignedPct(uwMove, 1)}</span>
    </div>
    <div id="uwMoveOut">${uwMoveOutHtml(P, opts, r.pool)}</div>
    <p style="font-size:10px;color:var(--text3);line-height:1.5;margin-top:10px">
      Liquidation prices match Binance's published figure: the tier frozen at today's notional, solved
      linearly. The Stress tab shows the live engine's reading as tiers change. Exit cost walks the order
      book as it stands now, not during a move.</p>`;
}

function uwTabsHtml() {
  const tab = (mode, label) => `<button class="st-btn${uwMode === mode ? ' on' : ''}" onclick="setUwMode(${jsArg(mode)})">${label}</button>`;
  const at = riskBook?.lastUpdated ? new Date(riskBook.lastUpdated) : null;
  const minutes = at ? Math.floor((Date.now() - at) / 60_000) : null;
  const age = minutes == null ? '' : `<span class="st-sep"></span>
      <span class="st-note" style="margin:0">Book from ${minutes < 1 ? 'just now' : `${minutes}m ago`} ·
        <button class="gl-link" onclick="fetchRiskBook(true)">Refresh</button></span>`;
  return `<div class="st-controls">${tab('plan', 'Plan')}${tab('build', 'Build')}${age}</div>`;
}

function uwPlanControlsHtml(P) {
  const btn = (label, on, onclick, title) =>
    `<button class="st-btn${on ? ' on' : ''}" onclick="${onclick}" title="${title}">${label}</button>`;
  return `<div class="st-controls">
    ${btn('Free margin', uwObjective === 'free', "setUw('objective','free')", 'Release initial margin')}
    ${btn('Liquidation buffer', uwObjective === 'buffer', "setUw('objective','buffer')", 'Release maintenance margin')}
    ${btn('Liquidation distance', uwObjective === 'liq', "setUw('objective','liq')", 'Move every liquidation price at least this far from the mark')}
    <span class="st-sep"></span>
    <label>${uwObjective === 'liq' ? 'Target %' : 'Target $'}
      <input type="number" step="${uwObjective === 'liq' ? 1 : 100}" value="${esc(uwTarget)}" placeholder="max"
        onchange="setUw('target', this.value)" style="width:76px" /></label>
    <label>Max loss $
      <input type="number" step="1000" value="${esc(uwMaxLoss)}" placeholder="none"
        onchange="setUw('maxLoss', this.value)" style="width:76px" /></label>
    <label title="Empty uses each symbol's own taker rate">Fee %
      <input type="number" step="0.005" value="${uwFee ?? ''}" placeholder="${poolFeePct(P)}"
        onchange="setUw('fee', this.value)" style="width:60px" /></label>
    <span class="st-sep"></span>
    ${btn('Allow breaking hedges', uwBreakHedges, "setUw('breakHedges')",
          'Off by default: a step that leaves a leg naked, per coin or in BTC terms, is refused')}
  </div>`;
}

function uwGainText(p, s) {
  if (p.objective === 'liq') return s.liqGain === Infinity ? 'none left' : `+${fmt(s.liqGain, 1)}pp`;
  return fmtPlusUsd(p.objective === 'buffer' ? s.bufferGain : s.freeGain);
}

function uwAfterText(p, s) {
  if (p.objective === 'liq') return s.cumulativeLiqPct === Infinity ? 'none' : `${fmt(s.cumulativeLiqPct, 1)}%`;
  return fmtUsd(p.objective === 'buffer' ? s.cumulativeBuffer : s.cumulativeFree);
}

function uwPlanHtml(P, p) {
  const c = p.ceiling;
  const gainLbl = { free: 'free', buffer: 'buffer', liq: 'nearest liq.' }[p.objective];
  const keyed = Object.fromEntries(P.pool.positions.map(x => [x.key, x]));
  const shiftBadge = (v, label) => {
    const col = v <= p.deltaTolerance ? 'var(--success)' : 'var(--danger)';
    return `<span class="uw-badge" style="background:${col}22;color:${col}" title="${label}">${fmtPlusUsd(v)}</span>`;
  };
  const legsText = s => s.closes.map(cl => {
    const x = keyed[cl.key];
    return x ? `${esc(x.asset)} ${x.positionSide.toLowerCase()} ${fmt(cl.qty, 4)}${cl.qty < Math.abs(x.q) - 1e-9 ? ` of ${fmt(Math.abs(x.q), 4)}` : ''}` : '';
  }).join(' + ');

  const ceilingStrip = `<div class="uw-ceiling">
    <span><span class="k">equity</span><b>${fmtUsd(c.equity)}</b></span>
    <span><span class="k">free now</span><b>${fmtUsd(c.currentFree)}</b></span>
    <span><span class="k">releasable margin</span><b>${fmtUsd(c.releasableIm)}</b></span>
    <span><span class="k">ceiling on free margin</span><b>${fmtUsd(c.maxFree)}</b></span>
    <span style="color:var(--text3)">equity − reserved ${fmtUsd(c.reserved)} − exit cost of everything ${fmtUsd(c.closeAllCost)}</span>
  </div>`;

  const aboveCeiling = p.targetAboveCeiling ? `<div class="st-banner warn">
    <b>Target is above the ceiling.</b> <code>${fmtUsd(p.target)} asked, ${fmtUsd(c.maxFree)} is the most
    any combination of closes can free</code> — free margin is capped by equity, so the gap
    needs equity growth, fresh collateral, or cancelled orders instead.</div>` : '';

  const refused = p.blocked?.unsafeGainAvailable > 0
    ? (p.objective === 'liq' ? `${fmt(p.blocked.unsafeGainAvailable, 1)}pp` : fmtUsd(p.blocked.unsafeGainAvailable)) : null;
  const blocked = p.blocked ? `<div class="st-banner ${refused ? 'bad' : 'warn'}">
    <b>Stopped early.</b> <code>${esc(p.blocked.reason)}</code>
    ${p.blocked.capNeededForNextSafeStep != null
      ? `Raise the max loss to ${fmtUsd(p.blocked.capNeededForNextSafeStep)} to take the cheapest close that leaves no leg naked.` : ''}
    ${refused ? `A step worth ${refused} was refused because it would have left a leg naked.` : ''}</div>` : '';

  const rows = p.steps.map((s, i) => `<tr>
      <td>${i + 1}</td>
      <td><b>${s.type === 'matched-hedge' ? 'close matched hedge' : 'close leg'}</b>${s.partial ? ' <span class="k">part</span>' : ''}${s.thin ? ' <span style="color:var(--warning)">thin book</span>' : ''}
        <div class="uw-legs">${legsText(s)}</div></td>
      <td class="num" style="color:var(--success)">${uwGainText(p, s)}</td>
      <td class="num">${fmtSignedUsd(s.cost)}</td>
      <td class="num">${shiftBadge(s.deltaShift, 'per coin')} ${shiftBadge(s.betaShift, 'in BTC terms')}</td>
      <td class="num ${s.realized >= 0 ? 'up' : 'dn'}">${fmtPlusUsd(s.realized)}</td>
      <td class="num">${uwAfterText(p, s)}</td>
    </tr>`).join('');

  return `${uwPlanControlsHtml(P)}${ceilingStrip}${aboveCeiling}${blocked}
    ${p.steps.length ? `<table class="uw-steps">
      <tr><th></th><th>action</th><th style="text-align:right">${gainLbl}</th>
          <th style="text-align:right">exit cost</th><th style="text-align:right">Δ exposure, coin · BTC</th>
          <th style="text-align:right">realises</th><th style="text-align:right">${gainLbl} after</th></tr>
      ${rows}</table>
      <div class="sim-presets" style="margin-top:10px"><button class="st-btn" onclick="uwEditPlan()">Edit this plan</button></div>`
      : `<p style="font-size:12px;color:var(--text3);padding:10px 0">No close improves ${gainLbl} under these constraints.</p>`}
    <div class="st-note">Steps are ranked by what they gain per dollar of exit cost at the live book, and the
      last one is cut to the size that lands on the target. <b>Δ exposure</b> is the change in net exposure,
      per coin and in BTC terms by beta; a green badge stays within ${fmtUsd(p.deltaTolerance)}, half a percent of
      gross notional. A close the book cannot fill is used only when nothing else qualifies.</div>`;
}

function uwBuildHtml(P) {
  const state = riskEngine.evalPool(P.pool, P.marks, P.opts);
  const btn = (label, name) => `<button class="st-btn" onclick="uwPreset(${jsArg(name)})">${label}</button>`;
  const legRow = p => {
    const on = uwSel[p.key] != null;
    const det = state.positions.find(x => x.key === p.key);
    const dec = priceDecimals(P.marks[p.asset]);
    return `<div class="liq-pos${on ? ' on' : ''}" onclick="uwToggle(${jsArg(p.key)})">
        <span class="liq-box">${on ? '✕' : ''}</span>
        <span class="liq-pos-main">
          <span class="liq-pos-name">${sideBadge(p.q > 0 ? 'Long' : 'Short')}
            <span style="font-weight:400;color:var(--text3)">${esc(p.leverage)}×</span></span>
          <span class="liq-pos-sub">${fmt(Math.abs(p.q), 4)} @ ${fmt(p.entry, dec)} ·
            ${fmtUsd(det?.notional || 0)} · uPnL ${fmtSignedUsd(det?.upnl || 0)}</span>
        </span>
      </div>
      ${on ? `<div class="sim-pct" style="margin:-2px 0 8px 22px">
        <input type="range" min="0" max="100" step="1" value="${uwSel[p.key]}"
          oninput="uwSetPct(${jsArg(p.key)}, this.value)" onchange="uwSetPct(${jsArg(p.key)}, this.value, true)" />
        <span id="uw-pct-${esc(p.key)}">${fmt(uwSel[p.key], 0)}%</span></div>` : ''}`;
  };
  const group = g => {
    const asset = g.legs[0].asset;
    const matched = g.long && g.short
      ? `<button class="sim-opt" style="flex:none;padding:2px 8px;margin-left:6px" onclick="uwMatched(${jsArg(g.symbol)})">matched</button>` : '';
    return `<div class="sim-row">
      <div class="sim-row-head"><span>${esc(asset)}</span>
        <span class="sim-row-legs">mark ${fmt(P.marks[asset], priceDecimals(P.marks[asset]))}${matched}</span></div>
      ${g.legs.map(legRow).join('')}
    </div>`;
  };
  return `<div class="sim-presets">
      ${btn('Close hedge longs', 'hedge-longs')}
      ${btn('Close hedge shorts', 'hedge-shorts')}
      ${btn('Close matched', 'matched')}
      ${btn('Close everything', 'all')}
      ${btn('Clear', 'none')}
    </div>
    ${uwFromPlan ? `<p class="st-note" style="margin:0 0 8px">Loaded from the plan — adjust any leg.</p>` : ''}
    ${uwGroups(P).map(group).join('')}`;
}

function renderUnwind() {
  if (!venueOn('binance')) return venueOffHtml('binance');
  if (riskLoading && !riskBook) return `<p style="font-size:12px;color:var(--text3);padding:14px 0">Loading the book…</p>`;
  if (!riskBook || !riskEngine) {
    return loadErrors.risk ? `${uwTabsHtml()}${loadErrorHtml('risk', 'fetchRiskBook(true)', false)}`
      : `<p style="font-size:12px;color:var(--text3);padding:14px 0">No pool data yet.</p>`;
  }
  const stale = loadErrorHtml('risk', 'fetchRiskBook(true)', true);
  const P = drawerPool();
  if (!P) return `${stale}<p style="font-size:12px;color:var(--text3);padding:14px 0">No open Binance cross positions.</p>`;

  pruneUwSel(P);
  const opts = uwOpts(P);
  uwLastPlan = uwMode === 'plan' ? uwPlan(P, opts) : null;
  const closes = uwMode === 'plan' ? uwLastPlan.closes : uwCloses(P);
  return `${stale}<div class="uw-grid" id="uw-mounted">
    <div class="uw-main">${uwTabsHtml()}${drawerPoolSwitch(riskBook.pools.map(x => x.marginAsset), P.marginAsset, 'uwPoolChanged')}${uwMode === 'plan' ? uwPlanHtml(P, uwLastPlan) : uwBuildHtml(P)}</div>
    <div class="uw-out" id="uwOut">${uwOutHtml(P, opts, closes)}</div>
  </div>`;
}
