// journal.js — the Journal tab and its building blocks.

// ── Journal ───────────────────────────────────────────────────────────────────
// What already happened, rebuilt from the cached fill and income history.
let perfData = null, perfLoading = false, perfDays = 0, syncPoll = null;
let jrTab = 'overview';
function setJrTab(t) {
  jrTab = t;
  if (t === 'trades' && !tripsData && !tripsLoading) fetchTrips();
  if (t === 'goals' && !goalsLoading) fetchGoals();
  rerenderStress();
}

async function fetchPerformance() {
  perfLoading = true;
  if (posView === 'journal') rerenderStress();
  try {
    const tz = -new Date().getTimezoneOffset();
    const query = [`tz=${tz}`, perfDays ? `days=${perfDays}` : '', sessionParam()].filter(Boolean).join('&');
    const res = await fetch(`/api/performance?${query}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'performance failed');
    perfData = data;
    fetchGoals();
  } catch (err) {
    perfData = { error: err.message };
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
  const started = await (await fetch(`/api/history/sync?start=true${full ? '&full=true' : ''}`)).json();
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

// Cumulative realised PnL with the underwater curve beneath it. Two panels rather than two
// y-scales on one — a second axis is the classic way to make a chart lie.
//
// Daily profit and loss is encoded by DIRECTION from the zero baseline, not by colour alone:
// the green/red pair measures ΔE 3.2 under deuteranopia, far below the ΔE 8 needed for
// colour to carry meaning on its own.
function renderEquityChart(points) {
  if (!points || points.length < 2) {
    return `<p style="font-size:11px;color:var(--text3)">Not enough history to plot.</p>`;
  }
  const W = 1000, HC = 118, HD = 46, GAP = 16, PAD_L = 4, PAD_R = 4;
  const n = points.length;
  const xs = i => PAD_L + (i / (n - 1)) * (W - PAD_L - PAD_R);

  const cums = points.map(p => p.cumulative);
  const cMin = Math.min(0, ...cums), cMax = Math.max(0, ...cums);
  const cSpan = (cMax - cMin) || 1;
  const yc = v => 8 + (1 - (v - cMin) / cSpan) * (HC - 16);

  const dds = points.map(p => p.drawdown);
  const dMin = Math.min(-1, ...dds);
  const yd = v => HC + GAP + (v / dMin) * (HD - 6);

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${xs(i).toFixed(1)} ${yc(p.cumulative).toFixed(1)}`).join(' ');
  const ddArea = `M${xs(0).toFixed(1)} ${(HC + GAP).toFixed(1)} `
    + points.map((p, i) => `L${xs(i).toFixed(1)} ${yd(p.drawdown).toFixed(1)}`).join(' ')
    + ` L${xs(n - 1).toFixed(1)} ${(HC + GAP).toFixed(1)} Z`;

  const barW = Math.max(0.8, (W - PAD_L - PAD_R) / n * 0.55);
  const maxAbs = Math.max(...points.map(p => Math.abs(p.pnl))) || 1;
  const barH = v => (Math.abs(v) / maxAbs) * 26;
  const zero = HC + GAP + HD + 34;
  const bars = points.map((p, i) => {
    const h = barH(p.pnl);
    return `<rect x="${(xs(i) - barW / 2).toFixed(1)}" y="${(p.pnl >= 0 ? zero - h : zero).toFixed(1)}"
      width="${barW.toFixed(1)}" height="${Math.max(0.6, h).toFixed(1)}" rx="0.8"
      fill="${p.pnl >= 0 ? 'var(--success)' : 'var(--danger)'}" opacity="0.75"></rect>`;
  }).join('');

  const hits = points.map((p, i) => `<rect x="${(xs(i) - (W / n) / 2).toFixed(1)}" y="0"
      width="${(W / n).toFixed(2)}" height="${zero + 30}" fill="transparent"
      data-i="${i}" data-date="${p.date}" data-pnl="${p.pnl}" data-cum="${p.cumulative}" data-dd="${p.drawdown}"
      ></rect>`).join('');

  const last = points[n - 1];
  return `<div class="jr-chart" id="jr-chart">
    <svg viewBox="0 0 ${W} ${zero + 30}" role="img"
         aria-label="Cumulative realised profit and loss with drawdown and daily results">
      <line x1="${PAD_L}" x2="${W - PAD_R}" y1="${yc(0).toFixed(1)}" y2="${yc(0).toFixed(1)}"
            stroke="var(--border2)" stroke-width="1" vector-effect="non-scaling-stroke"></line>
      <path d="${line}" fill="none" stroke="var(--text)" stroke-width="2"
            vector-effect="non-scaling-stroke" stroke-linejoin="round"></path>
      <circle cx="${xs(n - 1).toFixed(1)}" cy="${yc(last.cumulative).toFixed(1)}" r="3.5" fill="var(--text)"></circle>
      <text class="jr-axis" x="${PAD_L}" y="${(HC + GAP - 4).toFixed(1)}">underwater</text>
      <path d="${ddArea}" fill="var(--danger)" opacity="0.18"></path>
      <path d="${ddArea.replace(/^M[^L]*/, 'M' + xs(0).toFixed(1) + ' ' + yd(points[0].drawdown).toFixed(1)).replace(/ L[\d.]+ [\d.]+ Z$/, '')}"
            fill="none" stroke="var(--danger)" stroke-width="1.5" vector-effect="non-scaling-stroke"></path>
      <line x1="${PAD_L}" x2="${W - PAD_R}" y1="${zero}" y2="${zero}" stroke="var(--border2)"
            stroke-width="1" vector-effect="non-scaling-stroke"></line>
      ${bars}
      <line id="jr-cross" x1="0" x2="0" y1="0" y2="${zero + 30}" stroke="var(--text3)"
            stroke-width="1" vector-effect="non-scaling-stroke" opacity="0"></line>
      ${hits}
    </svg>
    <div class="jr-tip" id="jr-tip"></div>
  </div>
  <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text3)">
    <span>${points[0].date}</span><span>daily result · bar direction shows sign</span><span>${last.date}</span>
  </div>`;
}

function initEquityHover() {
  const wrap = document.getElementById('jr-chart');
  if (!wrap) return;
  const tip = document.getElementById('jr-tip');
  const cross = document.getElementById('jr-cross');
  wrap.querySelectorAll('rect[data-date]').forEach(r => {
    r.addEventListener('mouseenter', () => {
      const d = r.dataset;
      tip.innerHTML = `<b>${d.date}</b><br>day ${fmtSignedUsd(+d.pnl)}<br>cumulative ${fmtSignedUsd(+d.cum)}`
        + (+d.dd < -0.5 ? `<br><span style="color:var(--danger)">${fmtSignedUsd(+d.dd)} below peak</span>` : '');
      tip.style.opacity = '1';
      const x = (+r.getAttribute('x') + +r.getAttribute('width') / 2);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.style.opacity = '0.5';
      const pct = x / 1000;
      tip.style.left = `calc(${(pct * 100).toFixed(2)}% ${pct > 0.6 ? '- 150px' : '+ 10px'})`;
      tip.style.top = '4px';
    });
  });
  wrap.addEventListener('mouseleave', () => { tip.style.opacity = '0'; cross.style.opacity = '0'; });
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
    return `<div class="jr-bar-row${b.thin ? ' thin' : ''}" title="${b.label}: ${fmtSignedUsd(v)} over ${b[countKey]} trips${b.thin ? ' — thin sample' : ''}">
      <span class="jr-bar-lbl">${b.label}</span>
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

const JR_PERIODS = [['today', 'Today'], ['week', 'This week'], ['month', 'This month']];

function jrPeriodStrip(periods) {
  if (!periods) return '';
  const cell = ([key, label]) => {
    const p = periods[key];
    const account = p.account
      ? `<div class="s">account ${fmtSignedUsd(p.account.change)}${p.account.partial
          ? ` since ${new Date(p.account.since).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}</div>`
      : '<div class="s" title="no equity snapshots in this period yet">account —</div>';
    return `<div class="jr-stat"><div class="k">${label}</div>
      <div class="v ${p.net > 0 ? 'up' : p.net < 0 ? 'dn' : ''}">${fmtSignedUsd(p.net)}</div>
      <div class="s">${p.trips} trips closed${p.trips ? `, ${p.wins} won` : ''}</div>${account}</div>`;
  };
  return `<div class="jr-hero">${JR_PERIODS.map(cell).join('')}</div>`;
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

function jrHabitsTable(habits) {
  if (!habits?.length) return '';
  const avg = v => (v == null ? '—' : `<span class="${v >= 0 ? 'up' : 'dn'}">${fmtSignedUsd(v)}</span>`);
  const rows = habits.map(h => `<tr class="${h.thin ? 'jr-thin' : ''}">
    <td>${h.label}<span class="jr-sub">against ${h.against}</span></td>
    <td>${h.trips}${h.thin ? ' ⚠' : ''}</td><td>${avg(h.avgNet)}</td>
    <td>${h.comparisonTrips}</td><td>${avg(h.avgNetComparison)}</td>
    <td>${h.cost == null ? '—' : `<b class="${h.cost >= 0 ? 'up' : 'dn'}">${fmtSignedUsd(h.cost)}</b>`}</td>
  </tr>`).join('');
  return `<table class="jr-tbl jr-habits"><tr><th>habit</th><th>trips</th><th>avg net</th><th>others</th><th>their avg</th><th>est. cost</th></tr>${rows}</table>`;
}

function jrSection(title, body, note) {
  return `<p class="section-label" style="margin:18px 0 7px">${title}</p>${body}
    ${note ? `<p style="font-size:10px;color:var(--text3);line-height:1.5;margin-top:6px">${note}</p>` : ''}`;
}

function jrCalendar(cal) {
  if (!cal?.weeks?.length) return '';
  const max = cal.maxAbs || 1;
  const cells = cal.weeks.map(week => `<div class="jr-cal-col">${week.map(d => {
    if (d.pnl == null) return `<div class="jr-cal-cell" title="${d.date} · no trading"></div>`;
    const mag = Math.min(1, Math.abs(d.pnl) / max);
    const col = d.pnl >= 0 ? 'var(--success)' : 'var(--danger)';
    return `<div class="jr-cal-cell" style="background:${col};opacity:${(0.18 + mag * 0.82).toFixed(2)}"
      title="${d.date} · ${fmtSignedUsd(d.pnl)}"></div>`;
  }).join('')}</div>`).join('');

  return `<div class="jr-cal">${cells}</div>
    <div class="jr-cal-key">
      <span>loss</span>
      <span class="jr-cal-cell" style="background:var(--danger);opacity:1"></span>
      <span class="jr-cal-cell" style="background:var(--danger);opacity:.4"></span>
      <span class="jr-cal-cell"></span>
      <span class="jr-cal-cell" style="background:var(--success);opacity:.4"></span>
      <span class="jr-cal-cell" style="background:var(--success);opacity:1"></span>
      <span>profit · each column is a week, Monday at the top · hover for the number</span>
    </div>`;
}

// Locked PnL of the open same-symbol hedges, from the dashboard poll — no extra request.
// A matched pair pins its PnL at (shortEntry − longEntry) × matchedQty.
function jrLockedFromPositions(positions) {
  const bySymbol = {};
  for (const p of positions || []) (bySymbol[p.symbol] = bySymbol[p.symbol] || []).push(p);
  let locked = 0, matchedNotional = 0, pairs = 0;
  for (const legs of Object.values(bySymbol)) {
    const L = legs.find(p => p.sizeRaw > 0), S = legs.find(p => p.sizeRaw < 0);
    if (!L || !S) continue;
    const q = Math.min(Math.abs(L.sizeRaw), Math.abs(S.sizeRaw));
    locked += q * (S.entry - L.entry);
    matchedNotional += 2 * q * L.mark;
    pairs++;
  }
  return { locked, matchedNotional, pairs };
}

function renderJournal() {
  if (perfLoading && !perfData) return `<p style="font-size:12px;color:var(--text3);padding:14px 0">Loading history…</p>`;
  if (!perfData) return `<p style="font-size:12px;color:var(--text3);padding:14px 0">No history loaded.</p>`;
  if (perfData.error) return `<p style="font-size:12px;color:var(--danger);padding:14px 0">Error: ${esc(perfData.error)}</p>`;

  const syncBar = `<div class="jr-sync" id="jr-mounted">
    <span id="jr-sync-state">${perfData.empty ? 'no cached history' : `${perfData.session ? `${perfData.session} · ` : ''}${perfData.overall.trips} round trips · ${perfData.equity.days} days`}</span>
    <button class="st-btn" onclick="startSync(false)">Sync recent</button>
    <button class="st-btn" onclick="startSync(true)">Full rebuild</button>
    <span class="st-sep"></span>
    ${[0, 7, 30, 90].map(d => `<button class="st-btn${perfDays === d ? ' on' : ''}" onclick="setPerfDays(${d})">${d ? d + 'd' : 'all'}</button>`).join('')}
    <span class="st-sep"></span>
    ${sessionSelectHtml()}
  </div>`;

  if (perfData.empty) return `${syncBar}<p style="font-size:12px;color:var(--text3)">${perfData.hint}</p>`;

  const o = perfData.overall, e = perfData.equity;

  const intro = `<p class="jr-intro">A <b>round trip</b> is one position from the fill that opened it to
    the fill that closed it — rebuilt from your trade history, because the exchange reports profit per
    fill, never per position. <b>Adds down</b> counts the times a position was increased at a worse price
    than its own average entry. Buckets with fewer than 10 trips are dimmed and marked ⚠ — a handful of
    trades can show a five-figure number and mean nothing.</p>`;

  const tabs = `<div class="jr-subtabs">${
    [['overview','Overview'],['goals','Goals'],['performance','Performance'],['behaviour','Behaviour'],
     ['timing','Timing'],['symbols','Symbols'],['costs','Costs'],['trades','Trades']]
      .map(([k, l]) => `<button class="jr-subtab${jrTab === k ? ' on' : ''}" onclick="setJrTab('${k}')">${l}</button>`)
      .join('')}</div>`;

  const stat = (k, v, s, cls) => `<div class="jr-stat"><div class="k">${k}</div>
    <div class="v ${cls || ''}">${v}</div>${s ? `<div class="s">${s}</div>` : ''}</div>`;

  const hero = `<div class="jr-hero">
    ${stat('Round trips', o.trips, `${o.wins}W / ${o.losses}L`)}
    ${stat('Win rate', `${fmt(o.winRate, 1)}%`, `median hold ${fmt(o.medianHoldHours, 1)}h`)}
    ${stat('Net', fmtSignedUsd(o.net), 'after fees', o.net >= 0 ? 'up' : 'dn')}
    ${stat('Payoff', fmt(o.payoff, 2), `avg win ${fmtUsd(o.avgWin)} / loss ${fmtUsd(Math.abs(o.avgLoss))}`)}
    ${stat('Expectancy', fmtSignedUsd(o.expectancy), 'per trip', o.expectancy >= 0 ? 'up' : 'dn')}
    ${stat('Fee drag', `${fmt(perfData.feeDragPct, 1)}%`, `${fmtUsd(Math.abs(perfData.totals.COMMISSION || 0))} of gross`)}
  </div>`;

  const card = (x, tone) => `<div class="jr-split-card" style="border-color:${tone}55;background:${tone}11">
    <div class="lbl" style="color:${tone}">${x.label}</div>
    <div class="big ${x.net >= 0 ? 'up' : 'dn'}">${fmtSignedUsd(x.net)}</div>
    <div class="sub">${x.trips} trips · ${fmt(x.winRate, 0)}% win · payoff ${x.payoff ?? '—'} · expectancy ${fmtSignedUsd(x.expectancy)}</div>
  </div>`;

  const r = perfData.records || {};
  const recCard = (k, t, extra) => !t ? '' : `<div class="jr-rec-card">
    <div class="k">${k}</div>
    <div class="v ${(t.net ?? t.pnl) >= 0 ? 'up' : 'dn'}">${fmtSignedUsd(t.net ?? t.pnl)}</div>
    <div class="s">${t.symbol ? `${jrSym(t.symbol)} ${t.positionSide.toLowerCase()}` : t.date}${extra ? ` · ${extra}` : ''}</div>
  </div>`;

  let body = '';

  // ── Overview: the account, not just the closed trades ──
  // Closed-trade statistics alone are misleading while a large position is still open:
  // the round-trip net can read a fraction of the loss while the account carries far more unrealised on top
  // of it. The front page reconciles the whole thing.
  if (jrTab === 'overview') {
    const bn = lastData?.binance;
    const positions = bn?.positions || [];
    const t = perfData.totals || {};
    const realised = t.REALIZED_PNL || 0, fees = t.COMMISSION || 0;
    const funding = t.FUNDING_FEE || 0, transfers = t.TRANSFER || 0;
    const ledger = realised + fees + funding + transfers;

    const wallet = parseFloat(bn?.walletBalance ?? 0);
    const upnl = positions.reduce((s, p) => s + p.upnl, 0);
    const accountValue = parseFloat(bn?.equity ?? 0);
    const startWallet = wallet - ledger;
    const hedge = jrLockedFromPositions(positions);
    const gross = positions.reduce((s, p) => s + p.sizeUsd, 0);

    const row = (k, v, cls = '', extra = '') =>
      `<div class="jr-flow-row ${extra}"><span class="k">${k}</span><span class="${cls}">${v}</span></div>`;

    const posRows = positions.length ? positions
      .sort((a, b) => a.upnl - b.upnl)
      .map(p => `<tr>
        <td>${jrSym(p.symbol)} <span style="font-weight:400;color:var(--text3)">${p.side.toLowerCase()}</span></td>
        <td>${p.size}</td>
        <td>${fmtPrice(p.entry)}</td>
        <td>${fmtPrice(p.mark)}</td>
        <td class="${p.upnl >= 0 ? 'up' : 'dn'}">${fmtSignedUsd(p.upnl)}</td>
        <td style="color:var(--text3)">${fmtUsd(p.sizeUsd)}</td>
      </tr>`).join('') : '';

    const sessionNote = perfData.session
      ? `<p class="jr-session-note">Overview is the whole account, so the ${esc(perfData.session)} filter does not apply here — it narrows the trip-based tabs.</p>` : '';
    body = `${goalsOverviewLine()}${sessionNote}
      ${jrSection('How it is going', jrPeriodStrip(perfData.periods),
        'Realised is net of fees and funding, from the Binance ledger — exact. Account value includes open positions on both venues, net of deposits and withdrawals, from snapshots the server records every 15 minutes while it runs.')}
      ${jrSection('Wallet and account value', renderOverviewChart(perfData.walletCurve, perfData.accountCurve),
        'The gap between the lines is what the open positions are worth. Wallet is rebuilt from the ledger as far back as it reaches; account value starts when snapshots began.')}
      ${jrSection('Where the account stands', `<div class="jr-hero">
        ${stat('Account value', fmtUsd(accountValue), 'wallet + open positions', accountValue >= 0 ? '' : 'dn')}
        ${stat('Wallet', fmtUsd(wallet), 'realised money')}
        ${stat('Open positions', fmtSignedUsd(upnl), 'unrealised', upnl >= 0 ? 'up' : 'dn')}
        ${stat('Free margin', fmtUsd(bn?.freeMargin ?? 0), `${bn?.marginPct ?? 0}% margin used`)}
        ${stat('Open', positions.length, `${fmtUsd(gross)} gross`)}
        ${hedge.pairs ? stat('Locked in hedges', fmtSignedUsd(hedge.locked), `${hedge.pairs} matched pair${hedge.pairs > 1 ? 's' : ''}`, 'dn') : ''}
      </div>`)}

      ${jrSection('How it got here', `<div class="jr-flow">
        ${row('wallet at the start of the window', fmtUsd(startWallet), '', 'muted')}
        ${row('deposits and withdrawals', fmtSignedUsd(transfers), transfers >= 0 ? 'up' : 'dn')}
        ${row('realised profit and loss', fmtSignedUsd(realised), realised >= 0 ? 'up' : 'dn')}
        ${row('trading fees', fmtSignedUsd(fees), 'dn')}
        ${row('funding', fmtSignedUsd(funding), funding >= 0 ? 'up' : 'dn')}
        ${row('wallet now', fmtUsd(wallet), '', 'rule')}
        ${row('open positions, unrealised', fmtSignedUsd(upnl), upnl >= 0 ? 'up' : 'dn')}
        ${row('account value', fmtUsd(accountValue), '', 'total')}
      </div>`,
      `Realised ${fmtSignedUsd(realised)} over this window, against ${fmtSignedUsd(upnl)} still open —
       ${realised + upnl >= 0
         ? `net <b>${fmtSignedUsd(realised + upnl)}</b> once both are counted.`
         : `the open book more than gives the realised gains back, <b>${fmtSignedUsd(realised + upnl)}</b> net.`}
       The starting wallet is derived from the ledger, so it is exact only for the window the income
       history covers.`)}

      ${positions.length ? jrSection(`Open right now`,
        `<table class="jr-tbl"><tr><th>position</th><th>size</th><th>entry</th><th>mark</th><th>unrealised</th><th>notional</th></tr>${posRows}</table>`,
        hedge.pairs ? `${fmtUsd(hedge.matchedNotional)} of that notional is matched long against short —
          its ${fmtSignedUsd(hedge.locked)} cannot change with price. See the hedge ledger in the sidebar.` : '')
        : jrSection('Open right now', `<p style="font-size:11px;color:var(--text3)">Nothing open — the account is flat.</p>`)}

      ${jrSection('Activity', `<div class="jr-hero">
        ${stat('Fills', (perfData.execution?.fills ?? 0).toLocaleString('en-US'), `${perfData.bySymbol.length} symbols`)}
        ${stat('Closed trips', o.trips, `${perfData.stillOpen} still open`)}
        ${stat('Trading days', e.days, `${e.greenDays} green / ${e.redDays} red`)}
        ${stat('Since', (perfData.window.tripsFrom || perfData.window.from || '').slice(0, 10), 'earliest reachable fill')}
      </div>`, 'Closed-trade performance lives under <b>Performance</b>; this page is the account as a whole.')}`;
  }

  if (jrTab === 'performance') {
    body = `${hero}
      ${jrSection(`Cumulative realised, net of fees and funding
        <span style="font-size:10px;color:var(--text3);font-weight:400">· ${e.days} days · ${e.greenDays} green / ${e.redDays} red · worst drawdown ${fmtSignedUsd(e.maxDrawdown)}</span>`,
        renderEquityChart(e.points))}
      ${jrSection('Month by month', jrDivergingBars(perfData.month))}
      ${jrSection('Records', `<div class="jr-rec">
        ${recCard('Best trip', r.bestTrip, `${r.bestTrip?.fills} fills`)}
        ${recCard('Worst trip', r.worstTrip, `${r.worstTrip?.fills} fills, ${r.worstTrip?.addsWhileUnderwater} adds down`)}
        ${recCard('Held longest', r.longestHeld, `${fmt((r.longestHeld?.holdHours || 0) / 24, 1)} days`)}
        ${recCard('Most fills', r.mostFills, `${r.mostFills?.fills} fills`)}
        ${recCard('Best day', r.bestDay)}
        ${recCard('Worst day', r.worstDay)}
      </div>`)}`;
  }

  if (jrTab === 'behaviour') {
    const sq = perfData.sequence, st = perfData.streaks, sz = perfData.size;
    body = `${jrSection('What your habits cost', jrHabitsTable(perfData.habits),
        'Each cost is an estimate: the habit\'s trips against the comparison group, the gap in average net times the habit\'s trips. Rows with fewer than 10 trips on either side are dimmed and marked ⚠.')}
      ${jrSection('Trips that added size while underwater, against those that did not',
        `<div class="jr-split">${card(perfData.behaviour.addedWhileUnderwater, 'var(--danger)')}${card(perfData.behaviour.clean, 'var(--success)')}</div>`,
        'The single largest split in the book. Adding at a worse price than your own average entry is the behaviour, not the outcome.')}
      ${jrSection('How long a position was held', jrDivergingBars(perfData.holdTime),
        'Win rate and profit part company here: a bucket can win most of its trades and still lose the most money.')}
      ${jrSection('Long against short', jrDivergingBars(perfData.side))}
      ${jrSection('Streaks and what follows a result', `<div class="jr-hero">
        ${stat('Longest win streak', st.longestWin, fmtSignedUsd(st.longestWinPnl), 'up')}
        ${stat('Longest loss streak', st.longestLoss, fmtSignedUsd(st.longestLossPnl), 'dn')}
        ${stat('Current streak', `${Math.abs(st.current)} ${st.currentIsWin ? 'wins' : 'losses'}`, '', st.currentIsWin ? 'up' : 'dn')}
        ${stat('Size after a win', fmtUsd(sq.afterWin.avgSize), `${sq.afterWin.trips} trips, avg ${fmtSignedUsd(sq.afterWin.expectancy)}`)}
        ${stat('Size after a loss', fmtUsd(sq.afterLoss.avgSize), `${sq.afterLoss.trips} trips, avg ${fmtSignedUsd(sq.afterLoss.expectancy)}`)}
      </div>`, `Revenge trading shows up as a <i>bigger</i> position after a loss. Here the average size after a loss is
        ${fmtUsd(sq.afterLoss.avgSize)} against ${fmtUsd(sq.afterWin.avgSize)} after a win.`)}
      ${sz ? jrSection('Position size', `<div class="jr-hero">
        ${stat('Median', fmtUsd(sz.median), `${sz.count} trips`)}
        ${stat('10th pct', fmtUsd(sz.p10))}
        ${stat('90th pct', fmtUsd(sz.p90))}
        ${stat('Largest', fmtUsd(sz.max))}
      </div>`) : ''}`;
  }

  if (jrTab === 'timing') {
    body = `${jrSection('Every day, coloured by result', jrCalendar(perfData.calendar))}
      ${jrSection('Day of the week', jrDivergingBars(perfData.dayOfWeek), 'Grouped by the day a position was closed, UTC.')}
      ${jrSection('Hour of the day', jrDivergingBars(perfData.hourOfDay), 'Grouped by the hour a position was opened, UTC. Most hours hold few trips — read the counts before the bars.')}`;
  }

  if (jrTab === 'symbols') {
    const rows = perfData.bySymbol.filter(x => x.trips > 0).map(x => `<tr>
        <td>${jrSym(x.symbol)}</td>
        <td class="${x.net >= 0 ? 'up' : 'dn'}">${fmtSignedUsd(x.net)}</td>
        <td>${x.trips}</td><td>${fmt(x.winRate, 0)}%</td>
        <td>${x.payoff ?? '—'}</td><td style="color:var(--text3)">${fmtUsd(x.fees)}</td>
      </tr>`).join('');
    const worst3 = perfData.bySymbol.slice(0, 3);
    body = `${jrSection('Where the money went',
      `<table class="jr-tbl"><tr><th>symbol</th><th>net</th><th>trips</th><th>win</th><th>payoff</th><th>fees</th></tr>${rows}</table>`,
      `${perfData.bySymbol.length} symbols traded. The worst three account for
       ${fmtSignedUsd(worst3.reduce((s, x) => s + x.net, 0))} against a total of ${fmtSignedUsd(o.net)}.`)}`;
  }

  if (jrTab === 'costs') {
    const x = perfData.execution;
    const fees = perfData.feesBySymbol.slice(0, 10)
      .map(f => ({ label: jrSym(f.symbol), net: -f.fees, trips: 1, thin: false }));
    const fund = perfData.fundingBySymbol.filter(f => Math.abs(f.funding) > 0.5).slice(0, 10)
      .map(f => ({ label: jrSym(f.symbol), net: f.funding, trips: 1, thin: false }));
    body = `${jrSection('Execution', `<div class="jr-hero">
        ${stat('Maker share', `${fmt(x.makerPct, 1)}%`, `${x.maker} of ${x.fills} fills`)}
        ${stat('Taker fees', fmtUsd(x.takerFee), `${x.taker} fills`)}
        ${stat('Maker fees', fmtUsd(x.makerFee), `${x.maker} fills`)}
        ${stat('Total fees', fmtUsd(x.totalFee), `${fmt(perfData.feeDragPct, 1)}% of gross realised`)}
        ${stat('Funding', fmtSignedUsd(perfData.totals.FUNDING_FEE || 0), 'paid or received')}
      </div>`, 'Taker costs 0.05% against maker at 0.02% — two and a half times as much per fill.')}
      ${jrSection('Fees by symbol', jrDivergingBars(fees, { showCount: false }))}
      ${fund.length ? jrSection('Funding by symbol', jrDivergingBars(fund, { showCount: false }),
        'Negative is funding you paid to hold the position.') : ''}`;
  }

  if (jrTab === 'trades') body = renderTradesTab();
  if (jrTab === 'goals') body = renderGoalsTab();

  if (jrTab === 'performance') requestAnimationFrame(initEquityHover);

  return `${syncBar}${tabs}${jrTab === 'performance' ? intro : ''}${body}
    <p class="st-note">Round trips are rebuilt from fills, and every fill's realised PnL lands in exactly one place:
      a closed trip, a trip still open, or — for ${perfData.orphans?.fills ?? 0} fills that closed a position opened before
      the earliest reachable fill — an excluded bucket worth ${fmtSignedUsd(perfData.orphans?.realized ?? 0)}. Closed-trip
      totals therefore differ from the income ledger by those orphans and by trips that straddle the window edge.
      Fills reach back further than income does — Binance caps income at three months, so
      the curve and calendar cover ${e.days} days while trip statistics start ${(perfData.window.tripsFrom || '').slice(0, 10)}. Fees paid in BNB are tracked
      separately${perfData.nonQuoteFees ? ` (${fmt(perfData.nonQuoteFees, 4)} BNB)` : ''} rather than mixed into dollar totals.</p>`;
}
