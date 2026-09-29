// hedge-ledger.js — the hedge-ledger drawer: locked PnL, carry and margin inflation.

// ── Hedge ledger (sidebar drawer) ─────────────────────────────────────────────
// A matched same-symbol hedge pins its PnL at (entryShort − entryLong) × matchedQty: the
// price terms cancel, so that slice of the loss is already decided and only the unmatched
// remainder is still exposed. The panel leads with that number because a book can show a
// huge notional while almost none of it is live risk.
let hlData = null, hlLoading = false;

async function openHlDrawer() {
  document.getElementById('hlOverlay').classList.add('open');
  document.getElementById('hlDrawer').classList.add('open');
  document.getElementById('hlDrawerBody').innerHTML =
    `<p style="font-size:12px;color:var(--text3)">Reading the book…</p>`;
  hlLoading = true;
  try {
    const res = await fetch('/api/hedgeledger');
    const data = await res.json();
    hlData = data.ok ? data : { error: data.error || 'failed' };
  } catch (err) { hlData = { error: err.message }; }
  hlLoading = false;
  renderHlBody();
}
function closeHlDrawer(e) {
  if (e && e.target !== document.getElementById('hlOverlay')) return;
  closeHlDrawerForce();
}
function closeHlDrawerForce() {
  document.getElementById('hlOverlay').classList.remove('open');
  document.getElementById('hlDrawer').classList.remove('open');
}

// A hedge is delta-neutral, not margin-neutral. Margin is charged on notional and notional
// is quantity × price, so the requirement inflates with a pump while the pair's PnL cannot
// move. That is how a "fully hedged" book runs out of usable margin on a rally.
// The question this answers: the leg moving against you has a huge unrealised loss — does
// that loss eat margin by itself? In cross margin, no: the other leg's gain offsets it to
// the cent, and margin is charged on |qty| × price × rate with PnL not an input at all.
// What does bite is that BOTH legs' notionals grow, so both are charged more.
function renderLegSwing(inf) {
  const now = inf.steps[0], far = inf.steps[inf.steps.length - 1];
  if (!now || !far || far.movePct === 0) return '';

  const legs = now.legs
    .filter(l => l.notional > 1000)
    .map(l => ({ ...l, far: far.legs.find(x => x.key === l.key) }))
    .filter(l => l.far)
    .sort((a, b) => (b.far.upnl - b.upnl) - (a.far.upnl - a.upnl));
  if (legs.length < 2) return '';

  const netNow = now.legs.reduce((s, l) => s + l.upnl, 0);
  const netFar = far.legs.reduce((s, l) => s + l.upnl, 0);
  const biggest = Math.max(...legs.map(l => Math.abs(l.far.upnl - l.upnl)));

  const rows = legs.map(l => {
    const swing = l.far.upnl - l.upnl;
    return `<div class="hl-row">
      <span class="k">${l.asset} ${l.positionSide.toLowerCase()}</span>
      <span><span class="${swing >= 0 ? 'up' : 'dn'}">${fmtSignedUsd(swing)}</span>
        <span class="k"> · margin ${fmtUsd(l.im)}→${fmtUsd(l.far.im)}</span></span>
    </div>`;
  }).join('');

  return `<div style="margin-top:12px;padding-top:10px;border-top:0.5px solid var(--border)">
    <div class="sim-sec">Each leg's uPnL at +${far.movePct}%, and what it is charged</div>
    ${rows}
    <div class="hl-row" style="border-top:0.5px solid var(--border);margin-top:4px;padding-top:5px">
      <span class="k"><b>net uPnL</b></span>
      <span><b class="${netFar - netNow >= 0 ? 'up' : 'dn'}">${fmtSignedUsd(netFar - netNow)}</b></span></div>
    <p style="font-size:10px;color:var(--text3);line-height:1.5;margin-top:6px">
      Individual legs swing by up to <b>${fmtUsd(biggest)}</b> while the net moves
      <b>${fmtUsd(Math.abs(netFar - netNow))}</b> — in cross margin the winning leg's profit offsets
      the losing leg's loss to the cent, so the loss does not eat margin on its own. Margin is
      <code style="font-family:inherit">|qty| × price × rate</code>; PnL is not an input. What grows is
      both legs' notional, and therefore both legs' charge. That offset only holds while both legs
      are open — close the winner and the loser stands alone.</p>
  </div>`;
}

function renderMarginInflation(inf) {
  if (!inf?.steps?.length) return '';
  const maxIm = Math.max(...inf.steps.map(s => s.im)) || 1;

  const rows = inf.steps.map(s => {
    const w = (s.im / maxIm) * 100;
    const dead = s.free <= 0;
    return `<div style="margin-bottom:6px">
      <div class="hl-row" style="padding:1px 0">
        <span class="k">${s.movePct === 0 ? 'now' : '+' + s.movePct + '%'}</span>
        <span>margin ${fmtUsd(s.im)}${s.imGrowth && s.movePct ? ` <span class="k">${fmt(s.imGrowth, 2)}×</span>` : ''}
          · free <b class="${dead ? 'dn' : ''}">${dead ? 'none' : fmtUsd(s.free)}</b></span>
      </div>
      <div style="height:5px;border-radius:3px;background:var(--surface2);overflow:hidden">
        <div style="width:${w.toFixed(1)}%;height:100%;background:${dead ? 'var(--danger)' : 'var(--bn)'};opacity:.75"></div>
      </div>
    </div>`;
  }).join('');

  const first = inf.steps[0], last = inf.steps[inf.steps.length - 1];
  return `<div class="sim-sec">If everything pumps together</div>
    <p style="font-size:10px;color:var(--text3);line-height:1.5;margin:-2px 0 8px">
      The matched PnL cannot move — but margin is charged on notional, and notional grows with
      price. Equity changes only by ${fmtSignedUsd(last.equityChange)} across this whole range;
      the margin requirement grows ${fmt(last.imGrowth, 1)}×.</p>
    ${rows}
    ${renderLegSwing(inf)}
    <div class="hl-row" style="border-top:0.5px solid var(--border);margin-top:4px;padding-top:6px">
      <span class="k">free margin runs out at</span>
      <span class="${inf.freeGoneAtPct != null ? 'dn' : 'up'}"><b>${inf.freeGoneAtPct != null
        ? '+' + fmt(inf.freeGoneAtPct, 1) + '%' : `not within +${inf.scannedToPct}%`}</b></span></div>
    <div class="hl-row"><span class="k">liquidation at</span>
      <span>${inf.liquidatedAtPct != null ? '+' + fmt(inf.liquidatedAtPct, 1) + '%'
        : `not within +${inf.scannedToPct}%`}</span></div>`;
}

function renderHlBody() {
  const body = document.getElementById('hlDrawerBody');
  if (!body) return;
  if (hlData?.error) { body.innerHTML = `<p style="font-size:12px;color:var(--danger)">Error: ${esc(hlData.error)}</p>`; return; }
  const pool = hlData?.pools?.[0];
  if (!pool) { body.innerHTML = `<p style="font-size:12px;color:var(--text3)">No Binance cross positions.</p>`; return; }

  if (!pool.rows.length) {
    body.innerHTML = `<p style="font-size:12px;color:var(--text3)">No same-symbol hedges open — every
      position is directional, so none of the PnL is locked.</p>`;
    return;
  }

  const pairs = pool.rows.map(r => {
    const total = r.matchedNotional + r.residualNotional || 1;
    const matchedPct = r.matchedNotional / total * 100;
    const dec = priceDecimals(r.mark);
    return `<div class="hl-pair">
      <div class="hl-pair-head">
        <b>${r.asset}</b>
        <span class="${r.locked >= 0 ? 'up' : 'dn'}" style="font-size:15px;font-variant-numeric:tabular-nums">
          ${fmtSignedUsd(r.locked)}</span>
      </div>
      <div class="hl-row"><span class="k">long entry / short entry</span>
        <span>${fmt(r.longEntry, dec)} / ${fmt(r.shortEntry, dec)}</span></div>
      <div class="hl-row"><span class="k">matched size</span><span>${fmt(r.matched, 4)} ${r.asset}</span></div>
      <div class="hl-bar">
        <div style="width:${matchedPct.toFixed(1)}%;background:var(--danger);opacity:.55"></div>
        <div style="flex:1;background:var(--bn);opacity:.7"></div>
      </div>
      <div class="hl-legend">
        <span>${fmtUsd(r.matchedNotional)} locked in place</span>
        <span>${fmtUsd(r.residualNotional)} ${r.residualSide === 'flat' ? 'flat' : r.residualSide + ' and live'}</span>
      </div>
      <div class="hl-row" style="margin-top:6px"><span class="k">pair uPnL right now</span>
        <span>${fmtSignedUsd(r.livePairPnl)}
          ${r.invariant ? '<span class="hl-ok">= locked</span>' : '<span style="color:var(--danger)">mismatch</span>'}</span></div>
    </div>`;
  }).join('');

  const carryRows = pool.carry.map(c => {
    const mismatch = c.observedHours && c.declaredHours && c.observedHours !== c.declaredHours;
    return `<div class="hl-row">
      <span class="k">${c.asset} ${c.side.toLowerCase()}
        <span style="opacity:.7">${c.intervalHours}h</span>
        ${mismatch ? `<span title="Binance declares ${c.declaredHours}h but ${c.settlementsSeen} settlements show ${c.observedHours}h" style="color:var(--warning)">✳</span>` : ''}</span>
      <span class="${c.perDay >= 0 ? 'up' : 'dn'}">${fmtSignedUsd(c.perDay)}/day</span></div>`;
  }).join('');

  const anyMismatch = pool.carry.some(c => c.observedHours && c.declaredHours && c.observedHours !== c.declaredHours);

  body.innerHTML = `
    <div>
      <div class="hl-headline">
        <div class="k">Already decided — no price can change it</div>
        <div class="v">${fmtSignedUsd(pool.totalLocked)}</div>
        <div class="s">A matched hedge fixes its PnL at (short entry − long entry) × size. The price terms
          cancel exactly, so this much is settled whatever the market does next. Only
          <b>${fmtUsd(pool.totalResidualNotional)}</b> of the ${fmtUsd(pool.grossNotional)} gross notional is
          still exposed to price.</div>
      </div>
      ${pairs}
    </div>
    <div class="sim-out">
      ${renderMarginInflation(pool.inflation)}
      <div class="sim-sec" style="margin-top:16px">What holding it costs</div>
      ${carryRows}
      <div class="hl-row" style="border-top:0.5px solid var(--border);margin-top:6px;padding-top:6px">
        <span class="k"><b>net funding</b></span>
        <span class="${pool.carryPerDay >= 0 ? 'up' : 'dn'}"><b>${fmtSignedUsd(pool.carryPerDay)}/day</b></span></div>
      <div class="hl-row"><span class="k">margin locked up</span><span>${fmtUsd(pool.marginLocked)}</span></div>
      <div class="hl-row"><span class="k">equity</span><span>${fmtUsd(pool.equity)}</span></div>
      <p style="font-size:10px;color:var(--text3);line-height:1.5;margin-top:10px">
        Funding uses the settlement cadence actually observed in your income history, not only the one
        Binance declares${anyMismatch ? ' — ✳ marks a symbol where the two disagree' : ''}. A hedge that is
        cheap to carry in funding still consumes margin, and the locked figure above does not shrink with time.
      </p>
    </div>`;
}
