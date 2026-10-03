// journal.js — the Journal tab and its building blocks.

// ── Journal ───────────────────────────────────────────────────────────────────
// What already happened, rebuilt from the cached fill and income history.
let perfData = null, perfLoading = false, perfDays = 0, syncPoll = null;
let jrTab = 'overview', perfQuery = null;
function setJrTab(t) {
  jrTab = t;
  if (t === 'trades' && !tripsData && !tripsLoading) fetchTrips();
  if (t === 'goals' && !goalsLoading) fetchGoals();
  if (t === 'factors' && !factorsData && !factorsLoading) fetchFactors();
  rerenderStress();
}

async function fetchPerformance() {
  perfLoading = true;
  if (posView === 'journal') rerenderStress();
  const query = [clockParam(), perfDays ? `days=${perfDays}` : '', sessionParam()].filter(Boolean).join('&');
  try {
    const res = await fetch(`/api/performance?${query}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'performance failed');
    perfData = data;
    perfQuery = query;
    clearLoadError('perf');
    fetchGoals();
    reloadFactors();
    if (!fundLoading) fetchFunding();
  } catch (err) {
    noteLoadError('perf', err);
    if (query !== perfQuery) perfData = null;
  } finally {
    perfLoading = false;
    if (posView === 'journal') rerenderStress();
  }
}

function setPerfDays(d) { perfDays = d; fetchPerformance(); reloadTrips(); }

function syncProgressText(state) {
  if (!state.running) return `sync ${state.phase}`;
  if (state.phase === 'context') return `syncing trip context — ${state.contextDone}/${state.contextTotal} trips`;
  return `syncing ${state.phase} — ${state.symbolsDone}/${state.symbolsTotal} symbols, +${state.tradesAdded} fills`;
}

async function startSync(full = false) {
  const started = await (await fetch('/api/history/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ full }) })).json();
  if (!started.ok) {
    const el = document.getElementById('jr-sync-state');
    if (el) el.textContent = started.disabled ? 'Binance is switched off — switch it on to sync' : `Failed: ${esc(started.error)}`;
    return;
  }
  if (syncPoll) clearInterval(syncPoll);
  syncPoll = setInterval(async () => {
    const s = await (await fetch('/api/history/sync')).json();
    const el = document.getElementById('jr-sync-state');
    if (el) el.textContent = syncProgressText(s.state);
    if (!s.state.running) { clearInterval(syncPoll); syncPoll = null; fetchPerformance(); reloadTrips(); }
  }, 2000);
}

// ── Journal building blocks ───────────────────────────────────────────────────

// Sign by direction from a centre line, magnitude by length, count always shown. Thin
// buckets are dimmed rather than hidden, so a suspicious number stays visible but reads
// as what it is.
// USDT is the default quote and dropping it keeps labels short, but a USDC pair must keep
// its quote or two different symbols collapse into one row.
function jrSym(symbol) {
  if (!symbol) return '';
  if (symbol.endsWith('USDT')) return symbol.slice(0, -4);
  const m = symbol.match(/^(.*?)(USDC|BUSD|FDUSD)$/);
  return m ? `${m[1]}·${m[2]}` : symbol;
}

function jrDivergingBars(buckets, { valueKey = 'net', countKey = 'trips', showCount = true } = {}) {
  const live = buckets.filter(b => b[countKey] > 0);
  if (!live.length) return `<p style="font-size:11px;color:var(--text3)">No trades in this window.</p>`;
  const max = Math.max(...live.map(b => Math.abs(b[valueKey]))) || 1;

  return `<div class="jr-bars">${live.map(b => {
    const v = b[valueKey];
    const w = Math.abs(v) / max * 50;            // half the track per side
    const pos = v >= 0;
    return `<div class="jr-bar-row${b.thin ? ' thin' : ''}" title="${esc(b.label)}: ${fmtSignedUsd(v)} over ${b[countKey]} trips${b.thin ? ' — thin sample' : ''}">
      <span class="jr-bar-lbl">${esc(b.label)}</span>
      <span class="jr-bar-track">
        <span class="jr-bar-mid" style="left:50%"></span>
        <span class="jr-bar-fill" style="${pos ? 'left:50%' : `right:50%`};width:${w.toFixed(2)}%;
          background:${pos ? 'var(--success)' : 'var(--danger)'};opacity:.8"></span>
      </span>
      <span class="jr-bar-val ${pos ? 'up' : 'dn'}">${fmtSignedUsd(v)}</span>
      <span class="jr-bar-n">${showCount ? `${b[countKey]}${b.thin ? '⚠' : ''}` : ''}</span>
    </div>`;
  }).join('')}</div>`;
}

const CHART_MAX_POINTS = 400;

function thinPoints(points) {
  if (points.length <= CHART_MAX_POINTS) return points;
  const step = Math.ceil(points.length / CHART_MAX_POINTS);
  return points.filter((_, i) => i % step === 0 || i === points.length - 1);
}

function renderOverviewChart(walletCurve, accountCurve) {
  const series = [
    { label: 'Account value', points: thinPoints((accountCurve || []).map(p => ({ t: p.t, v: p.accountValue }))), cls: 'ov-account' },
    { label: 'Wallet', points: thinPoints((walletCurve || []).map(p => ({ t: p.t, v: p.wallet }))), cls: 'ov-wallet' }
  ].filter(s => s.points.length > 1);
  if (!series.length) return `<p style="font-size:11px;color:var(--text3)">Not enough history to plot.</p>`;

  const W = 1000, H = 150, PAD = 8, LABEL_W = 92;
  const all = series.flatMap(s => s.points);
  const t0 = Math.min(...all.map(p => p.t)), t1 = Math.max(...all.map(p => p.t));
  const v0 = Math.min(...all.map(p => p.v)), v1 = Math.max(...all.map(p => p.v));
  const x = t => PAD + (t - t0) / ((t1 - t0) || 1) * (W - PAD - LABEL_W);
  const y = v => PAD + (1 - (v - v0) / ((v1 - v0) || 1)) * (H - 2 * PAD);
  const path = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
  const when = t => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  const lines = series.map(s => {
    const last = s.points.at(-1);
    return `<path class="${s.cls}" d="${path(s.points)}" fill="none" stroke-width="2" vector-effect="non-scaling-stroke"></path>
      <text class="ov-label" x="${(x(last.t) + 6).toFixed(1)}" y="${(y(last.v) + 4).toFixed(1)}">${s.label}</text>
      ${s.points.map(p => `<circle cx="${x(p.t).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="6" fill="transparent">
        <title>${s.label} ${fmtUsd(p.v)} · ${when(p.t)}</title></circle>`).join('')}`;
  }).join('');
  const legend = series.map(s => `<span class="ov-key"><svg width="18" height="6"><line class="${s.cls}" x1="0" y1="3" x2="18" y2="3" stroke-width="2"></line></svg>${s.label}</span>`).join('');
  return `<div class="ov-legend">${legend}<span class="ov-range">${fmtUsd(v0)} – ${fmtUsd(v1)}</span></div>
    <svg class="ov-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Wallet and account value over time">${lines}</svg>`;
}

function jrStat(k, v, s, cls) {
  return `<div class="jr-stat"><div class="k">${k}</div><div class="v ${cls || ''}">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;
}

function jrSection(title, body, note) {
  return `<p class="section-label" style="margin:18px 0 7px">${title}</p>${body}
    ${note ? `<p style="font-size:10px;color:var(--text3);line-height:1.5;margin-top:6px">${note}</p>` : ''}`;
}

function journalSyncState() {
  if (!perfData) return 'history not loaded';
  if (perfData.empty) return 'no cached history';
  return `${perfData.session ? `${esc(perfData.session)} · ` : ''}${perfData.overall.trips} round trips · ${perfData.account.days} days`;
}

function journalSyncBar() {
  return `<div class="jr-sync" id="jr-mounted">
    <span id="jr-sync-state">${journalSyncState()}</span>
    <button class="st-btn" onclick="startSync(false)">Sync recent</button>
    <button class="st-btn" onclick="startSync(true)">Full rebuild</button>
    <span class="st-sep"></span>
    ${[0, 7, 30, 90].map(d => `<button class="st-btn${perfDays === d ? ' on' : ''}" onclick="setPerfDays(${d})">${d ? d + 'd' : 'all'}</button>`).join('')}
    <span class="st-sep"></span>
    ${sessionSelectHtml()}
  </div>`;
}

function openLegNote(check) {
  if (!check?.mismatches.length) return '';
  const legs = check.mismatches.map(m => `${esc(jrSym(m.symbol))} ${esc(m.positionSide.toLowerCase())}: rebuilt ${fmt(m.rebuilt, 4)}, Binance ${fmt(m.live, 4)}`).join(' · ');
  return `<p class="st-note jr-warn">${check.mismatches.length} open leg${check.mismatches.length > 1 ? 's' : ''} differ from Binance at the last sync,
    so their trips are missing fills or misread: ${legs}. A full sync usually repairs it.</p>`;
}

function renderJournal() {
  if (perfLoading && !perfData) return `<p style="font-size:12px;color:var(--text3);padding:14px 0">Loading history…</p>`;
  if (!perfData) {
    return loadErrors.perf ? `${journalSyncBar()}${loadErrorHtml('perf', 'fetchPerformance()', false)}`
      : `<p style="font-size:12px;color:var(--text3);padding:14px 0">No history loaded.</p>`;
  }
  const syncBar = journalSyncBar() + loadErrorHtml('perf', 'fetchPerformance()', true);

  if (perfData.empty) return `${syncBar}<p style="font-size:12px;color:var(--text3)">${perfData.hint}</p>`;

  const tabs = `<div class="jr-subtabs">${
    [['overview','Overview'],['goals','Goals'],['performance','Performance'],['behaviour','Behaviour'],['factors','Factors'],
     ['timing','Timing'],['symbols','Symbols'],['costs','Costs'],['trades','Trades']]
      .map(([k, l]) => `<button class="jr-subtab${jrTab === k ? ' on' : ''}" onclick="setJrTab('${k}')">${l}</button>`)
      .join('')}</div>`;

  let body = '';

  if (jrTab === 'overview') body = renderOverview();
  if (jrTab === 'performance') body = renderPerformanceTab();
  if (jrTab === 'behaviour') body = renderBehaviourTab();

  if (jrTab === 'timing') body = renderTimingTab();
  if (jrTab === 'symbols') body = renderSymbolsTab();
  if (jrTab === 'costs') body = renderCostsTab();
  if (jrTab === 'trades') body = renderTradesTab();
  if (jrTab === 'goals') body = renderGoalsTab();
  if (jrTab === 'factors') body = renderFactorsTab();

  return `${syncBar}${tabs}${body}${openLegNote(perfData.openLegCheck)}
    <p class="st-note">Round trips are rebuilt from fills, and every fill's realised PnL lands in exactly one place:
      a closed trip, a trip still open, or — for ${perfData.orphans?.fills ?? 0} fills that closed a position opened before
      the earliest reachable fill — an excluded bucket worth ${fmtSignedUsd(perfData.orphans?.realized ?? 0)}. Closed-trip
      totals therefore differ from the income ledger by those orphans and by trips that straddle the window edge.
      Fills reach back further than income does — Binance caps income at three months, so
      the curve and calendar cover ${perfData.account.days} days while trip statistics start ${(perfData.window.tripsFrom || '').slice(0, 10)}. Fees paid in BNB are kept
      out of dollar totals and priced separately under Costs.</p>`;
}
