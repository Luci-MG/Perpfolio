// journal-overview.js — the Journal's Overview: what needs attention, this period against the
// same point in the last one, the account, the next milestone and the latest trades. Layout
// research: docs/research/overview.md. The wallet reconciliation is under Costs.

const OV_PERIODS = [['today', 'Today', 'yesterday'], ['week', 'This week', 'last week'], ['month', 'This month', 'last month']];
const OV_ATTENTION_MAX = 3;
const ovGoals = () => goalsData?.goals || [];
const ovTone = v => (v > 0 ? 'up' : v < 0 ? 'dn' : '');

const ATTENTION_SOURCES = [
  () => ovGoals().filter(g => g.unit !== 'milestone' && g.status === 'broken')
    .map(g => ({ html: `✗ ${esc(g.label)} broke today`, cls: 'dn', go: "setJrTab('goals')" })),
  () => ovGoals().filter(g => g.unit === 'milestone' && ['missed', 'broken'].includes(g.status))
    .map(g => ({ html: `✗ ${esc(g.label)} ${g.status === 'missed' ? 'missed' : 'broken this month'}`, cls: 'dn', go: "setJrTab('goals')" })),
  () => ovGoals().filter(g => g.status === 'late')
    .map(g => ({ html: `◔ ${esc(g.label)} late`, cls: 'gl-late', go: "setJrTab('goals')" })),
  () => (fundData?.realised?.differsFromEstimate
    ? [{ html: `⚠ Binance funding paid ${fmtPlusUsd(fundData.realised.perDay7d)}/day this week against ${fmtPlusUsd(fundData.realised.estimatePerDay)} estimated`,
         cls: 'gl-late', go: 'openFundDrawer()' }] : []),
  () => (factorsData?.worse || [])
    .map(b => ({ html: `✗ ${esc(b.bucket)} trips run ${fmtPlusUsd(b.diff)}/trip against the rest`, cls: 'dn', go: "setJrTab('factors')" })),
  () => (perfData?.habits || []).filter(h => h.verdict === 'costs')
    .map(h => ({ html: `✗ ${esc(h.label)}: ${fmtPlusUsd(h.cost)} over ${h.trips} trips`, cls: 'dn', go: "setJrTab('behaviour')" }))
];

function ovGoalsToday() {
  const rules = ovGoals().filter(g => g.unit !== 'milestone');
  if (!rules.length) return '';
  const t = goalsData.today;
  return t.scored ? `Goals today: ${t.kept} of ${t.scored} kept` : `Goals: no trades today`;
}

function ovAttention() {
  const items = ATTENTION_SOURCES.flatMap(source => source());
  const today = ovGoalsToday();
  if (!items.length) return `<p class="ov-calm">${today ? `${today} · ` : ''}nothing needs attention</p>`;
  const shown = items.slice(0, OV_ATTENTION_MAX).map(i => `<button class="ov-attn ${i.cls}" onclick="${i.go}">${i.html} ›</button>`).join('');
  const more = items.length > OV_ATTENTION_MAX ? `<span class="gl-n">+${items.length - OV_ATTENTION_MAX} more</span>` : '';
  return `<div class="ov-attention"><span class="section-label">Attention</span>${shown}${more}${today ? `<span class="gl-n">${today}</span>` : ''}</div>`;
}

function ovPeriods(periods) {
  if (!periods) return '';
  const cell = ([key, label, previousLabel]) => {
    const p = periods[key];
    const delta = p.previous ? p.net - p.previous.net : null;
    const account = p.account ? `<div class="s" title="account value, deposits and withdrawals removed">account ${fmtPlusUsd(p.account.change)}${p.account.partial ? ' (partial)' : ''}</div>` : '';
    return `<div class="jr-stat"><div class="k">${label}</div>
      <div class="v ${ovTone(p.net)}">${fmtPlusUsd(p.net)} <span class="gl-n">n=${p.trips}${p.trips ? ` · ${p.wins}W` : ''}</span></div>
      ${delta == null ? '' : `<div class="s">vs ${previousLabel} by now <span class="${ovTone(delta)}">${fmtPlusUsd(delta)}</span></div>`}${account}</div>`;
  };
  return `<div class="jr-hero ov-periods" title="Net of fees and funding, from the Binance ledger">${OV_PERIODS.map(cell).join('')}</div>`;
}

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

function ovAccountNow() {
  const bn = lastData?.binance;
  const positions = bn?.positions || [];
  return { bn, positions, wallet: parseFloat(bn?.walletBalance ?? 0), accountValue: parseFloat(bn?.equity ?? 0),
           upnl: positions.reduce((s, p) => s + p.upnl, 0), hedge: jrLockedFromPositions(positions) };
}

function ovAccountLine() {
  const a = ovAccountNow();
  const hedges = a.hedge.pairs ? ` · <span title="${a.hedge.pairs} matched pair${a.hedge.pairs > 1 ? 's' : ''}: cannot change with price">hedges locked <span class="${ovTone(a.hedge.locked)}">${fmtPlusUsd(a.hedge.locked)}</span></span>` : '';
  const asOf = lastData?.lastUpdated ? ` <span class="gl-n">as of ${new Date(lastData.lastUpdated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>` : '';
  return `<span class="section-label">Account</span>
      <b>${fmtUsd(a.accountValue)}</b> · wallet ${fmtUsd(a.wallet)} · open <span class="${ovTone(a.upnl)}">${fmtPlusUsd(a.upnl)}</span>${hedges}${asOf}`;
}

function ovAccount() {
  return `<div class="ov-account" id="ov-account">${ovAccountLine()}</div>
    ${renderOverviewChart(perfData.walletCurve, perfData.accountCurve)}
    <button class="gl-link ov-bridge-link" onclick="setJrTab('costs')">How the wallet got here ›</button>`;
}

function ovNextMilestone() {
  const open = ovGoals().filter(g => g.type === 'accountTarget' && !['reached', 'paused', 'missed'].includes(g.status))
    .sort((a, b) => a.params.target - b.params.target);
  const reached = ovGoals().filter(g => g.type === 'accountTarget' && g.status === 'reached').length;
  if (!open.length) {
    const empty = reached ? `Every milestone reached (${reached}).` : 'No milestone set.';
    return `<div class="ov-card"><span class="section-label">Next milestone</span><p class="gl-n">${empty}</p>
      <button class="gl-link" onclick="setJrTab('goals')">Goals ›</button></div>`;
  }
  const g = open[0];
  return `<div class="ov-card"><span class="section-label">Next milestone</span>
    <div class="ov-ms"><span class="gl-mark ${g.status}">${MILESTONE_MARK[g.status]}</span><span class="gl-name">${esc(g.label)}</span>
      <span class="gl-adh">${g.waiting ? '—' : goalPct(Math.max(0, g.progress))}</span></div>
    ${g.waiting ? milestoneBar(0) : milestoneBar(g.progress, g.paceFraction)}
    <p class="gl-n">${targetStateText(g)}${open.length > 1 ? ` · ${open.length - 1} more after it` : ''}</p>
    <button class="gl-link" onclick="setJrTab('goals')">Goals ›</button></div>`;
}

function ovRecentTrades() {
  const trips = perfData.recentTrips || [];
  const rows = trips.map(t => `<button class="ov-trip" onclick="openGoalBreach(${jsArg(t.symbol)}, ${t.openTime})">
      <span>${esc(jrSym(t.symbol))} <span class="gl-n">${t.side.toLowerCase()}</span></span>
      <span class="${ovTone(t.net)}">${fmtPlusUsd(t.net)}</span><span class="gl-n">${heldText(t.holdHours)}</span>
      <span class="ov-tags">${tagChips(t.tags)}${t.note ? ` <span class="jt-pen" title="${esc(t.note)}">✎</span>` : ''}</span></button>`).join('');
  return `<div class="ov-card"><span class="section-label">Recent trades</span>${rows || '<p class="gl-n">No closed trades yet.</p>'}
    <button class="gl-link" onclick="setJrTab('trades')">Trades ›</button></div>`;
}

function ovFooter() {
  const since = (perfData.window.tripsFrom || perfData.window.from || '').slice(0, 10);
  const synced = perfData.syncedAt ? ` · as of last sync ${new Date(perfData.syncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
  return `<p class="ov-footer">${perfData.overall.trips} trips · ${perfData.account.days} days${since ? ` · since ${since}` : ''}${synced}</p>`;
}

function renderOverview() {
  const sessionNote = perfData.session
    ? `<p class="jr-session-note">Overview is the whole account; the ${esc(perfData.session)} filter narrows the trip tabs.</p>` : '';
  return `${ovAttention()}${sessionNote}${ovPeriods(perfData.periods)}${ovAccount()}
    <div class="ov-pair">${ovNextMilestone()}${ovRecentTrades()}</div>${ovFooter()}`;
}
