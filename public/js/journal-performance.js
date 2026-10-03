// journal-performance.js — the Journal's Performance tab: how the account did over the window
// against the window before, the account curve with its underwater strip, plain breakdowns
// that point to Factors for the tested version, records and streaks against chance.

const perfPct = (v, dp = 1) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(v), dp)}%`);
const perfRange = (ci, format) => (ci ? `<span class="gl-n" title="90% interval">${format(ci.lo)} to ${format(ci.hi)}</span>` : '');

function perfVs(current, before, format) {
  if (before == null || current == null) return '';
  const delta = current - before;
  return `<div class="s">vs ${format(before)} before <span class="${ovTone(delta)}">${delta > 0 ? '▲' : delta < 0 ? '▼' : '='}</span></div>`;
}

function perfSessionNote() {
  if (!perfData.session) return '';
  return `<p class="jr-session-note">${esc(perfData.session)} trips only: the curve is their net, not the account, so return,
    drawdown %, Sharpe and beta wait for the whole account.</p>`;
}

function perfReturnStat(a, prev) {
  if (a.curve === 'trips') return jrStat('Net', ovUsd(perfData.units.net), 'these trips, fees and funding in', ovTone(perfData.units.net));
  const twr = a.twr;
  return jrStat('Return', perfPct(twr.pct, 2), `${twr.days} day${twr.days === 1 ? '' : 's'}, transfers out${twr.gaps ? ` · ${twr.gaps} without data` : ''}`
    + perfVs(twr.pct, prev?.twr, v => perfPct(v, 2)), ovTone(twr.pct ?? 0));
}

function perfDrawdownStat(a) {
  if (a.curve === 'trips') return jrStat('Drawdown', ovUsd(a.maxDrawdownUsd), 'deepest fall in these trips\' net', ovTone(a.maxDrawdownUsd));
  const d = a.drawdown;
  if (!d.troughAt) return jrStat('Drawdown', '0%', 'no fall from a peak in this window');
  const recovery = d.recoveredAt ? `recovered in ${d.days}d` : `${d.days}d, not yet recovered`;
  const noEdge = d.zeroEdgePct == null ? '' : ` · a no-edge book ≈ ${perfPct(d.zeroEdgePct)}`;
  return jrStat('Drawdown', `${d.lowerBound ? '≥ ' : ''}${perfPct(d.maxPct)}`, `${recovery}${noEdge}`, 'dn');
}

function perfWinStat(u, prev) {
  if (!u.units) return jrStat('Win rate', '—', 'no units');
  const pct = v => `${fmt(v * 100, 0)}%`;
  return jrStat('Win rate', `${pct(u.winRate)} ${perfRange(u.winCi, pct)}`,
    `${u.units} units (${u.legs} legs) · ${u.wins}W ${u.losses}L${u.flat ? ` ${u.flat} flat` : ''}` + perfVs(u.winRate, prev?.winRate, pct));
}

function perfExpectancyStat(u, prev) {
  if (!u.units) return jrStat('Expectancy', '—', 'no units');
  return jrStat('Expectancy', `${ovUsd(u.expectancy)} ${perfRange(u.expectancyCi, ovUsd)}`, 'per unit' + perfVs(u.expectancy, prev?.expectancy, ovUsd),
    ovTone(u.expectancy));
}

function perfPayoffStat(u) {
  const pf = u.profitFactor.needs ? `profit factor after ${u.profitFactor.needs} more units`
    : `profit factor ${u.profitFactor.value == null ? '— (no losses)' : fmt(u.profitFactor.value, 2)}`;
  return jrStat('Payoff', u.payoff == null ? '—' : fmt(u.payoff, 2),
    `avg win ${u.avgWin == null ? '—' : fmtUsd(u.avgWin)} / loss ${u.avgLoss == null ? '—' : fmtUsd(Math.abs(u.avgLoss))} · ${pf}`);
}

function perfSharpeStat(a) {
  if (a.curve === 'trips') return jrStat('Sharpe', '—', 'whole account only');
  const r = a.ratios;
  if (r.needs) return jrStat('Sharpe', '—', `needs ${r.needs} more days of returns (${r.n} of 60)`);
  if (!r.sharpe) return jrStat('Sharpe', '—', 'no variation in daily returns');
  const sortino = r.sortino.value == null ? '' : ` · Sortino ${fmt(r.sortino.value, 2)}`;
  return jrStat('Sharpe', `${fmt(r.sharpe.value, 2)} <span class="gl-n">± ${fmt(r.sharpe.se, 2)}</span>`,
    `chance above 0: ${fmt(r.sharpe.probAboveZero * 100, 0)}%${sortino}`, ovTone(r.sharpe.value));
}

function perfCostsLine(a, u) {
  const c = perfData.costs.summary;
  const funding = c.fundingPaid + c.fundingReceived;
  const beta = a.curve !== 'account' ? '' : a.beta.needs ? ` · beta to BTC after ${a.beta.needs} more days`
    : ` · beta to BTC ${fmt(a.beta.beta, 2)} (correlation ${fmt(a.beta.correlation, 2)})`;
  const r = u.r.trips ? ` · ${fmt(u.r.avg, 2)}R a trip on the ${u.r.trips} of ${u.r.of} with a stop` : '';
  return `<p class="gl-line">Net ${ovUsd(u.net)} after fees <span class="dn">${ovUsd(-c.fees)}</span> and funding
    <span class="${ovTone(funding)}">${ovUsd(funding)}</span>${beta}${r}</p>`;
}

function perfChartPoints(a) {
  const underwater = new Map((a.drawdown?.underwater || []).map(d => [d.date, d.pct]));
  return a.series.filter(r => r.value != null)
    .map(r => ({ date: r.date, value: r.value, pnl: r.pnl ?? 0, source: r.source, dd: a.curve === 'trips' ? r.ddUsd : underwater.get(r.date) ?? 0 }));
}

function perfSegments(points, xs, y) {
  const runs = [];
  points.forEach((p, i) => {
    if (!runs.length || runs.at(-1).source !== p.source) runs.push({ source: p.source, pts: i ? [[i - 1, points[i - 1]]] : [] });
    runs.at(-1).pts.push([i, p]);
  });
  return runs.map(run => `<path d="${run.pts.map(([i, p], k) => `${k ? 'L' : 'M'}${xs(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ')}"
    fill="none" stroke="var(--text)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"
    ${run.source === 'wallet' ? 'stroke-dasharray="4 3" opacity="0.7"' : ''}></path>`).join('');
}

function renderPerfChart(a) {
  const points = perfChartPoints(a);
  if (points.length < 2) return '<p class="gl-n">Not enough history to plot.</p>';
  const W = 1000, HC = 118, HD = 46, GAP = 16, PAD = 4;
  const n = points.length;
  const xs = i => PAD + (i / (n - 1)) * (W - 2 * PAD);
  const values = points.map(p => p.value);
  const vMin = Math.min(...values), vMax = Math.max(...values);
  const y = v => 8 + (1 - (v - vMin) / ((vMax - vMin) || 1)) * (HC - 16);
  const dMin = Math.min(-1e-9, ...points.map(p => p.dd));
  const yd = v => HC + GAP + (v / dMin) * (HD - 6);
  const ddArea = `M${xs(0).toFixed(1)} ${HC + GAP} ${points.map((p, i) => `L${xs(i).toFixed(1)} ${yd(p.dd).toFixed(1)}`).join(' ')} L${xs(n - 1).toFixed(1)} ${HC + GAP} Z`;
  const barW = Math.max(0.8, (W - 2 * PAD) / n * 0.55);
  const maxAbs = Math.max(...points.map(p => Math.abs(p.pnl))) || 1;
  const zero = HC + GAP + HD + 34;
  const bars = points.map((p, i) => {
    const h = Math.abs(p.pnl) / maxAbs * 26;
    return `<rect x="${(xs(i) - barW / 2).toFixed(1)}" y="${(p.pnl >= 0 ? zero - h : zero).toFixed(1)}" width="${barW.toFixed(1)}"
      height="${Math.max(0.6, h).toFixed(1)}" rx="0.8" fill="${p.pnl >= 0 ? 'var(--success)' : 'var(--danger)'}" opacity="0.75"></rect>`;
  }).join('');
  const hits = points.map((p, i) => `<rect x="${(xs(i) - W / n / 2).toFixed(1)}" y="0" width="${(W / n).toFixed(2)}" height="${zero + 30}"
    fill="transparent" data-date="${p.date}" data-pnl="${p.pnl}" data-value="${p.value}" data-dd="${p.dd}" data-source="${p.source}"></rect>`).join('');
  const label = a.curve === 'trips' ? 'cumulative net of these trips' : 'value';
  const key = a.accountFrom && points[0].source === 'wallet'
    ? `<span>dashed: wallet rebuilt from the ledger, open positions not included · solid: account value from ${a.accountFrom}</span>` : `<span>${label}</span>`;
  return `<div class="jr-chart" id="jr-chart" data-unit="${a.curve === 'trips' ? 'usd' : 'pct'}">
    <svg viewBox="0 0 ${W} ${zero + 30}" role="img" aria-label="Account ${label} with drawdown and daily results">
      ${perfSegments(points, xs, y)}
      <text class="jr-axis" x="${PAD}" y="${HC + GAP - 4}">underwater</text>
      <path d="${ddArea}" fill="var(--danger)" opacity="0.18"></path>
      <line x1="${PAD}" x2="${W - PAD}" y1="${zero}" y2="${zero}" stroke="var(--border2)" stroke-width="1" vector-effect="non-scaling-stroke"></line>
      ${bars}
      <line id="jr-cross" x1="0" x2="0" y1="0" y2="${zero + 30}" stroke="var(--text3)" stroke-width="1" vector-effect="non-scaling-stroke" opacity="0"></line>
      ${hits}
    </svg>
    <div class="jr-tip" id="jr-tip"></div>
  </div>
  <div class="jr-chart-foot"><span>${points[0].date}</span>${key}<span>${points.at(-1).date}</span></div>`;
}

function initPerfHover() {
  const wrap = document.getElementById('jr-chart');
  if (!wrap) return;
  const tip = document.getElementById('jr-tip'), cross = document.getElementById('jr-cross');
  const usd = wrap.dataset.unit === 'usd';
  wrap.querySelectorAll('rect[data-date]').forEach(r => {
    r.addEventListener('mouseenter', () => {
      const d = r.dataset;
      const fall = usd ? ovUsd(+d.dd) : perfPct(+d.dd);
      tip.innerHTML = `<b>${esc(d.date)}</b><br>day ${fmtSignedUsd(+d.pnl)}<br>${d.source === 'wallet' ? 'wallet' : usd ? 'cumulative' : 'account'} ${fmtUsd(+d.value)}`
        + (+d.dd < 0 ? `<br><span class="dn">${fall} below peak</span>` : '');
      tip.style.opacity = '1';
      const x = +r.getAttribute('x') + +r.getAttribute('width') / 2;
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.style.opacity = '0.5';
      const pct = x / 1000;
      tip.style.left = `calc(${(pct * 100).toFixed(2)}% ${pct > 0.6 ? '- 150px' : '+ 10px'})`;
      tip.style.top = '4px';
    });
  });
  wrap.addEventListener('mouseleave', () => { tip.style.opacity = '0'; cross.style.opacity = '0'; });
}

function perfRecords(r) {
  const card = (k, value, sub) => `<div class="jr-rec-card"><div class="k">${k}</div>
    <div class="v ${ovTone(value)}">${ovUsd(value)}</div><div class="s">${sub}</div></div>`;
  const unit = (k, u) => (u ? card(k, u.net, `${esc(jrSym(u.symbol))}${u.legs > 1 ? ` hedge, ${u.legs} legs` : ''} · of ${r.units} units`) : '');
  const day = (k, d) => (d ? card(k, d.pnl, `${esc(d.date)} · of ${r.days} days`) : '');
  return `<div class="jr-rec">${unit('Best unit', r.bestUnit)}${unit('Worst unit', r.worstUnit)}${day('Best day', r.bestDay)}${day('Worst day', r.worstDay)}</div>`;
}

function perfStreaks(s) {
  if (!s.units) return '<p class="gl-n">No units in this window.</p>';
  const row = (label, seen, chance, cls) => {
    const verdict = !chance ? '' : chance.unusual ? `<b class="${cls}">longer than chance gives</b>` : 'within what chance gives';
    return `<p class="gl-line">${label} <b>${seen}</b> · reshuffling the same results gives ${chance ? fmt(chance.median, 0) : '—'} · ${verdict}</p>`;
  };
  const current = s.current ? `<p class="gl-n">Now: ${s.current.length} ${s.current.result === 'win' ? 'win' : 'loss'}${s.current.length > 1 ? (s.current.result === 'win' ? 's' : 'es') : ''} in a row, over ${s.units} units.</p>` : '';
  return `${row('Longest losing streak', s.longestLoss, s.chance.loss, 'dn')}${row('Longest winning streak', s.longestWin, s.chance.win, 'up')}${current}`;
}

function renderPerformanceTab() {
  const a = perfData.account, u = perfData.units, prev = perfData.previous;
  const factorsLink = '<button class="gl-link" onclick="setJrTab(\'factors\')">Tested in Factors ›</button>';
  const hero = u.units || a.curve === 'account' ? `<div class="jr-hero">
      ${perfReturnStat(a, prev)}${perfDrawdownStat(a)}${perfWinStat(u, prev)}${perfExpectancyStat(u, prev)}${perfPayoffStat(u)}${perfSharpeStat(a)}
    </div>${perfCostsLine(a, u)}` : '';
  const trips = u.units ? `
    ${jrSection('Month by month', jrDivergingBars(perfData.month), `Months in your local time. ${factorsLink}`)}
    ${jrSection('How long a position was held', jrDivergingBars(perfData.holdTime), factorsLink)}
    ${jrSection('Long against short', jrDivergingBars(perfData.side), factorsLink)}
    ${jrSection('Records', perfRecords(perfData.records))}
    ${jrSection('Streaks', perfStreaks(perfData.streaks), 'A streak is judged against the same wins and losses in random order: long runs happen by chance more often than they feel.')}`
    : '<p class="gl-n">No trips in this window.</p>';
  requestAnimationFrame(initPerfHover);
  return `${perfSessionNote()}${hero}
    ${jrSection(a.curve === 'trips' ? 'Net of these trips, by day' : 'Account, by day', renderPerfChart(a))}${trips}`;
}
