// goals-view.js — the Journal's Goals sub-tab, its add / edit drawer and the Overview line.
// Goal types and their form fields arrive with /api/goals, defined once in /goals.js.

let goalsData = null, goalsLoading = false;
let goalOpen = null, goalConfirmDelete = null;
let goalDraft = null, goalPreview = null, goalPreviewTimer = null, goalPreviewSeq = 0, goalSaveError = null;

const GOAL_MARK = { kept: '✓', broken: '✗', progress: '●', idle: '·', paused: '‖' };
const GOAL_CELL = { kept: ['▮', 'kept'], broken: ['✕', 'broken'], none: ['·', 'no trades'], unset: ['', 'before the goal was set'] };
const GOAL_SESSIONS = SESSION_CHOICES.filter(s => s !== 'All');
const goalDay = t => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
const goalWhen = t => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const goalPct = v => (v == null ? '—' : `${fmt(v * 100, 0)}%`);
const goalType = id => goalsData.types.find(t => t.id === id);
const goalDefaults = id => Object.fromEntries(goalType(id).params.map(p => [p.key, p.default]));

async function fetchGoals() {
  goalsLoading = true;
  try {
    const data = await (await fetch(`/api/goals?${clockParam()}`)).json();
    if (!data.ok) throw new Error(data.error || 'goals failed');
    goalsData = data;
    clearLoadError('goals');
  } catch (err) {
    noteLoadError('goals', err);
  } finally {
    goalsLoading = false;
    if (posView === 'journal') rerenderStress();
  }
}

async function changeGoal(body) {
  const res = await fetch(`/api/goals?${clockParam()}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'change failed');
  await fetchGoals();
}

async function goalAction(id, action) {
  if (action === 'delete' && goalConfirmDelete !== id) {
    goalConfirmDelete = id;
    rerenderStress();
    return;
  }
  goalConfirmDelete = null;
  try {
    await changeGoal({ action, id });
  } catch (err) {
    goalsData.actionError = err.message;
    rerenderStress();
  }
}

function toggleGoal(id) {
  goalOpen = goalOpen === id ? null : id;
  goalConfirmDelete = null;
  rerenderStress();
}

function openGoalBreach(symbol, openTime) {
  const day = new Date(openTime);
  day.setHours(0, 0, 0, 0);
  tradesFilter = { ...tradesFilter, symbol, day: day.getTime() };
  tradesShowAll = false;
  setJrTab('trades');
}

function goalStateText(g) {
  if (g.status === 'broken') return g.today.broken > 1 ? `broke ${g.today.broken}× today` : 'broke today';
  if (g.status === 'progress') return `${g.today.trips}/${g.today.limit} today`;
  if (g.status === 'paused') return 'paused';
  if (g.status === 'idle') return g.waiting ? 'starts with the next captured entry' : 'no trades yet';
  return g.streak ? `kept · ${g.streak}${g.unit === 'day' ? 'd' : ' in a row'}` : 'kept';
}

function goalCells(cells) {
  return cells.map(c => `<span class="gl-cell ${c.state}" title="${goalDay(c.day)} · ${GOAL_CELL[c.state][1]}">${GOAL_CELL[c.state][0]}</span>`).join('');
}

function goalCalendar(cells) {
  const weeks = Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
  return `<div class="gl-cal">${weeks.map(w => `<div class="gl-cal-col">${goalCells(w)}</div>`).join('')}</div>`;
}

function goalCostText(c) {
  if (!c.brokenTrips) return 'Not broken.';
  if (c.cost == null) return `Broken ${c.brokenTrips}×, nothing kept yet to compare against.`;
  const verdict = c.cost < 0 ? `est. cost <b class="dn">${fmtSignedUsd(c.cost)}</b>`
    : `breaking it did better, <b class="up">${fmtSignedUsd(c.cost)}</b>`;
  return `Broken trades averaged ${fmtSignedUsd(c.avgBroken)} against ${fmtSignedUsd(c.avgKept)} kept · ${verdict}
    · ${c.brokenTrips} broken / ${c.keptTrips} kept${c.thin ? ' ⚠' : ''}`;
}

function goalBreachesHtml(g) {
  if (!g.breaches.length) return '';
  const rows = g.breaches.map(b => `<tr><td>${goalWhen(b.openTime)}</td>
    <td>${esc(jrSym(b.symbol))} <span class="gl-n">${b.side.toLowerCase()}</span></td>
    <td>${esc(b.what)}${b.tags?.length ? ` ${tagChips(b.tags)}` : ''}${b.note ? ` <span class="jt-pen" title="${esc(b.note)}">✎</span>` : ''}</td><td>${signedCell(b.net)}</td>
    <td><button class="gl-link" onclick="openGoalBreach('${esc(b.symbol)}', ${b.openTime})">open ›</button></td></tr>`).join('');
  const more = g.breachCount > g.breaches.length ? `<p class="gl-n">latest ${g.breaches.length} of ${g.breachCount}</p>` : '';
  return `<table class="jr-tbl gl-breaches">${rows}</table>${more}`;
}

function goalDetail(g) {
  const b = g.before;
  const before = b ? `<p class="gl-line${b.thin ? ' thin' : ''}">Before you set it: ${goalPct(b.adherence)} kept over ${b.n}
    ${b.unit === 'day' ? 'days' : 'trades'}${b.cost != null && b.brokenTrips ? ` · est. cost ${fmtSignedUsd(b.cost)}` : ''}${b.thin ? ' ⚠' : ''}</p>` : '';
  return `<div class="gl-detail">
    <div class="gl-detail-top">${goalCalendar(g.calendar)}
      <p class="gl-line${g.thin ? ' thin' : ''}">${goalCostText(g)}</p></div>
    ${goalBreachesHtml(g)}${before}
    <p class="gl-line gl-n">set ${goalDay(g.setAt)}${g.pausedAt ? ` · paused ${goalDay(g.pausedAt)}` : ''}</p>
    ${goalActionsHtml(g)}
  </div>`;
}

function goalRow(g) {
  const open = goalOpen === g.id;
  return `<div class="gl-row ${g.status}">
    <button class="gl-head" onclick="toggleGoal('${esc(g.id)}')" aria-expanded="${open}">
      <span class="gl-mark ${g.status}">${GOAL_MARK[g.status]}</span>
      <span class="gl-name">${esc(g.label)}</span>
      <span class="gl-state">${goalStateText(g)}</span>
      <span class="gl-adh">${goalPct(g.adherence)} <span class="gl-n">n=${g.n}${g.unit === 'day' ? 'd' : ''}</span></span>
      <span class="gl-strip">${goalCells(g.strip)}</span>
      <span class="gl-caret">${open ? '▾' : '▸'}</span>
    </button>
    ${open ? goalDetail(g) : ''}
  </div>`;
}

const isMilestone = g => g.unit === 'milestone';

function goalsTodayText(today, goals) {
  if (today.scored) return `today ${today.kept} of ${today.scored} kept`;
  const rules = goals.filter(g => !isMilestone(g) && g.status !== 'paused');
  if (rules.length) return `${rules.length} set · no trades today`;
  return `${goals.length} milestone${goals.length > 1 ? 's' : ''}`;
}

function goalEmptyHtml(suggestions) {
  const items = suggestions.map((s, i) => `<button class="gl-suggest" onclick="openGoalDrawer(null, ${i})">
    <span class="gl-name">${esc(s.preview.label)}</span>
    <span class="gl-n">breaking it cost ${fmtSignedUsd(s.preview.cost)} over ${s.preview.brokenTrips} trades${s.preview.thin ? ' ⚠' : ''}</span>
  </button>`).join('');
  return `<p class="gl-empty">No goals yet.${suggestions.length ? ' From your history:' : ''}</p>${items}`;
}

function renderGoalsTab() {
  if (!goalsData) return loadErrors.goals ? loadErrorHtml('goals', 'fetchGoals()', false) : `<p class="jt-count">Loading goals…</p>`;
  const { goals, today, suggestions } = goalsData;
  const head = `<div class="gl-top"><span class="section-label">Goals</span>
    <span class="gl-n">${goals.length ? goalsTodayText(today, goals) : ''}</span>
    <button class="st-btn" onclick="openGoalDrawer()">+ Add goal</button></div>`;
  const error = goalsData.actionError ? `<p class="dn gl-line">${esc(goalsData.actionError)}</p>` : '';
  const rules = goals.filter(g => !isMilestone(g)), milestones = goals.filter(isMilestone);
  const ruleBlock = rules.length ? `<div class="gl-list">${rules.map(goalRow).join('')}</div>` : goalEmptyHtml(suggestions);
  const milestoneBlock = milestones.length
    ? `<p class="section-label gl-block">Milestones</p><div class="gl-list">${milestones.map(milestoneRow).join('')}</div>` : '';
  return `${head}${loadErrorHtml('goals', 'fetchGoals()', true)}${error}${ruleBlock}${milestoneBlock}`;
}

const MILESTONE_MARK = { onpace: '◎', open: '◎', early: '◎', late: '◔', reached: '★', reachedLate: '★', missed: '✗', paused: '‖',
                         progress: '●', broken: '✗', kept: '✓', idle: '·' };
const clamp01 = v => Math.min(1, Math.max(0, v ?? 0));
const fallText = pct => `${pct < 0 ? '−' : ''}${fmt(Math.abs(pct), 1)}%`;

function targetStateText(g) {
  if (g.waiting) return 'waiting for the first snapshot';
  const pace = g.eta ? `on pace for ${goalDay(g.eta)}` : 'not rising';
  return {
    early: `not enough history · ${fmt(g.days, 1)} of 7 days`, open: pace, onpace: pace, late: `${pace} · late`,
    reached: `reached ${goalDay(g.reachedAt)}`, missed: `missed ${goalDay(g.deadline)}`, paused: 'paused',
    reachedLate: `reached ${goalDay(g.reachedAt)}, ${Math.ceil((g.reachedAt - g.deadline) / 86_400_000)} days after the date`
  }[g.status];
}

function milestoneBar(fill, tick) {
  const marker = tick == null ? '' : `<span class="gl-tick" style="left:${(clamp01(tick) * 100).toFixed(1)}%" title="where a straight line to the date would be today"></span>`;
  return `<span class="gl-bar"><span class="gl-fill" style="width:${(clamp01(fill) * 100).toFixed(1)}%"></span>${marker}</span>`;
}

function milestoneSummary(g) {
  if (g.type === 'accountTarget') {
    return `${g.waiting ? milestoneBar(0) : milestoneBar(g.progress, g.paceFraction)}
      <span class="gl-adh">${g.waiting ? '—' : goalPct(Math.max(0, g.progress))}</span><span class="gl-state">${targetStateText(g)}</span>`;
  }
  const m = g.month;
  const state = g.status === 'paused' ? 'paused' : m ? `${fallText(m.ddPct)} of −${m.limit}% this month${m.approx ? ' ≈ wallet' : ''}` : 'no readings this month';
  return `${milestoneBar(m ? Math.abs(m.ddPct) / m.limit : 0)}<span class="gl-adh">${goalPct(g.adherence)} <span class="gl-n">n=${g.n}mo</span></span>
    <span class="gl-state">${state}</span>`;
}

function milestoneRow(g) {
  const open = goalOpen === g.id;
  return `<div class="gl-row ${g.status}">
    <button class="gl-head gl-mhead" onclick="toggleGoal('${esc(g.id)}')" aria-expanded="${open}">
      <span class="gl-mark ${g.status}">${MILESTONE_MARK[g.status]}</span>
      <span class="gl-name">${esc(g.label)}</span>
      ${milestoneSummary(g)}
      <span class="gl-caret">${open ? '▾' : '▸'}</span>
    </button>
    ${open ? milestoneDetail(g) : ''}
  </div>`;
}

function milestoneChart(g) {
  const line = g.chart || [];
  if (line.length < 2) return '<p class="gl-n">The chart starts once a few snapshots have been recorded.</p>';
  const proj = g.projection || [];
  const all = [...line, ...proj];
  const W = 600, H = 120, PAD = 6;
  const t0 = Math.min(...all.map(p => p.t)), t1 = Math.max(...all.map(p => p.t), g.deadline ?? 0);
  const values = all.map(p => p.value);
  const v0 = Math.min(...values), v1 = Math.max(...values);
  const x = t => PAD + (t - t0) / ((t1 - t0) || 1) * (W - 2 * PAD);
  const y = v => PAD + (1 - (v - v0) / ((v1 - v0) || 1)) * (H - 2 * PAD);
  const path = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
  const targetIn = g.target >= v0 && g.target <= v1;
  return `<svg class="gl-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Account value since the goal was set">
      ${targetIn ? `<line class="gl-target" x1="${PAD}" x2="${W - PAD}" y1="${y(g.target).toFixed(1)}" y2="${y(g.target).toFixed(1)}"></line>` : ''}
      ${g.deadline && g.deadline <= t1 ? `<line class="gl-deadline" x1="${x(g.deadline).toFixed(1)}" x2="${x(g.deadline).toFixed(1)}" y1="${PAD}" y2="${H - PAD}"></line>` : ''}
      <path class="ov-account" d="${path(line)}" fill="none" stroke-width="2" vector-effect="non-scaling-stroke"></path>
      ${proj.length ? `<path class="gl-proj" d="${path(proj)}" fill="none" stroke-width="2" stroke-dasharray="5 4" vector-effect="non-scaling-stroke"></path>` : ''}
    </svg>
    <p class="gl-n">${fmtUsd(v0)} – ${fmtUsd(v1)}${proj.length ? ' · dashed: straight-line extrapolation of the daily trend' : ''}${targetIn ? '' : ` · target ${fmtUsd(g.target)} is off the chart`}</p>`;
}

function goalActionsHtml(g) {
  return `<div class="gl-actions">
      <button class="st-btn" onclick="openGoalDrawer('${esc(g.id)}')">Edit</button>
      <button class="st-btn" onclick="goalAction('${esc(g.id)}', '${g.pausedAt ? 'resume' : 'pause'}')">${g.pausedAt ? 'Resume' : 'Pause'}</button>
      <button class="st-btn${goalConfirmDelete === g.id ? ' gl-danger' : ''}" onclick="goalAction('${esc(g.id)}', 'delete')">${goalConfirmDelete === g.id ? 'Confirm delete' : 'Delete'}</button>
    </div>`;
}

function milestoneDetail(g) {
  if (g.type !== 'accountTarget') {
    const cells = g.strip.map(c => `<span class="gl-cell ${c.state}" title="${new Date(c.day).toLocaleDateString([], { month: 'short', year: 'numeric' })} · ${
      c.ddPct == null ? GOAL_CELL[c.state][1] : `${fallText(c.ddPct)}${c.approx ? ' ≈ wallet' : ''}`}">${GOAL_CELL[c.state === 'progress' ? 'kept' : c.state][0]}</span>`).join('');
    const b = g.before;
    const before = b ? `<p class="gl-line">Before you set it: ${goalPct(b.adherence)} of ${b.n} months kept · worst ${fallText(b.worst)}${b.approx ? ' ≈ wallet' : ''}</p>` : '';
    return `<div class="gl-detail"><p class="gl-line"><span class="gl-strip">${cells}</span> <span class="gl-n">last 12 months</span></p>${before}
      <p class="gl-line gl-n">set ${goalDay(g.setAt)}</p>${goalActionsHtml(g)}</div>`;
  }
  const facts = g.waiting ? '' : `<p class="gl-line">From ${fmtUsd(g.start)} toward ${fmtUsd(g.target)} · now ${fmtUsd(g.current)} as of ${goalWhen(g.asOf)}
    ${g.perDay != null ? ` · trend ${fmtSignedUsd(g.perDay)} a day` : ''} · deposits and withdrawals left out</p>`;
  return `<div class="gl-detail">${g.waiting ? '' : milestoneChart(g)}${facts}
    <p class="gl-line gl-n">set ${goalDay(g.setAt)}${g.deadline ? ` · due ${goalDay(g.deadline - 1)}` : ''}</p>${goalActionsHtml(g)}</div>`;
}

function openGoalDrawer(id = null, suggestion = null) {
  const goal = id ? goalsData.goals.find(g => g.id === id) : null;
  openGoalDrawerFrom(goal || (suggestion != null ? goalsData.suggestions[suggestion] : null) || { type: goalsData.types[0].id }, id);
}

function openGoalDrawerFrom(source, id = null) {
  goalDraft = { id, type: source.type, params: { ...goalDefaults(source.type), ...source.params }, session: source.session ?? null };
  goalSaveError = null;
  goalPreview = null;
  document.getElementById('goalOverlay').classList.add('open');
  document.getElementById('goalDrawer').classList.add('open');
  renderGoalDrawer();
  requestGoalPreview(0);
}

function closeGoalDrawer(e) {
  if (e && e.target !== document.getElementById('goalOverlay')) return;
  closeGoalDrawerForce();
}

function closeGoalDrawerForce() {
  goalDraft = null;
  clearTimeout(goalPreviewTimer);
  document.getElementById('goalOverlay').classList.remove('open');
  document.getElementById('goalDrawer').classList.remove('open');
}

function setGoalType(type) {
  goalDraft = { ...goalDraft, type, params: goalDefaults(type), session: goalType(type).scoped ? goalDraft.session : null };
  renderGoalDrawer();
  requestGoalPreview();
}

function setGoalParam(key, value) {
  goalDraft.params = { ...goalDraft.params, [key]: value };
  requestGoalPreview();
}

function toggleGoalSession(session, on) {
  const list = goalDraft.params.sessions.filter(s => s !== session);
  setGoalParam('sessions', on ? [...list, session] : list);
}

function setGoalScope(session) {
  goalDraft.session = session || null;
  requestGoalPreview();
}

function goalFieldHtml(spec) {
  const value = goalDraft.params[spec.key];
  if (spec.sessions) {
    return `<div class="gl-field"><span class="k">${spec.label}</span><span class="gl-checks">${GOAL_SESSIONS.map(s => `<label class="gl-check">
      <input type="checkbox"${value.includes(s) ? ' checked' : ''} onchange="toggleGoalSession('${esc(s)}', this.checked)">${esc(s)}</label>`).join('')}</span></div>`;
  }
  if (spec.date) {
    const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
    return `<label class="gl-field"><span class="k">${spec.label}</span><input class="cf-sym gl-date" type="date" min="${tomorrow}" value="${esc(value ?? '')}"
      oninput="setGoalParam('${spec.key}', this.value || null)">${spec.optional ? '<span class="gl-n">optional</span>' : ''}</label>`;
  }
  const input = spec.options
    ? `<select class="st-btn" onchange="setGoalParam('${spec.key}', this.value)">${spec.options.map(([v, l]) =>
        `<option value="${v}"${value === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`
    : `${spec.prefix ? `<span class="gl-n">${spec.prefix}</span>` : ''}<input class="cf-sym gl-num" type="number" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${esc(String(value))}"
        oninput="setGoalParam('${spec.key}', this.value)">${spec.suffix ? `<span class="gl-n">${esc(spec.suffix)}</span>` : ''}`;
  return `<label class="gl-field"><span class="k">${spec.label}</span>${input}</label>`;
}

function renderGoalDrawer() {
  const d = goalDraft, def = goalType(d.type);
  document.getElementById('goalDrawerTitle').textContent = d.id ? 'Edit goal' : 'Add goal';
  const types = goalsData.types.map(t => `<option value="${t.id}"${t.id === d.type ? ' selected' : ''}>${esc(t.label)}</option>`).join('');
  const scope = def.scoped ? `<label class="gl-field"><span class="k">Applies</span><select class="st-btn" onchange="setGoalScope(this.value)">
      <option value="">All sessions</option>${GOAL_SESSIONS.map(s => `<option${d.session === s ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label>` : '';
  document.getElementById('goalDrawerBody').innerHTML = `<div class="gl-form">
      <label class="gl-field"><span class="k">Type</span><select class="st-btn" onchange="setGoalType(this.value)"${d.id ? ' disabled' : ''}>${types}</select></label>
      ${def.params.map(goalFieldHtml).join('')}${scope}
      ${def.forwardOnly ? '<p class="gl-n">Scored only on trades whose entry was captured.</p>' : ''}
    </div>
    <div id="goalPreview" class="gl-preview">${goalPreviewHtml()}</div>
    ${goalSaveError ? `<p class="dn gl-line">${esc(goalSaveError)}</p>` : ''}
    <div class="gl-actions"><button class="st-btn" onclick="closeGoalDrawerForce()">Cancel</button>
      <button class="st-btn on" onclick="saveGoal()">${d.id ? 'Save' : 'Add goal'}</button></div>`;
}

function requestGoalPreview(delay = 250) {
  clearTimeout(goalPreviewTimer);
  goalPreviewTimer = setTimeout(loadGoalPreview, delay);
}

async function loadGoalPreview() {
  if (!goalDraft) return;
  const seq = ++goalPreviewSeq;
  const q = new URLSearchParams(`${clockParam()}&type=${encodeURIComponent(goalDraft.type)}&params=${encodeURIComponent(JSON.stringify(goalDraft.params))}`);
  if (goalDraft.session) q.set('session', goalDraft.session);
  let preview;
  try {
    const data = await (await fetch(`/api/goals/preview?${q}`)).json();
    preview = data.ok ? data.preview : { error: data.error };
  } catch (err) {
    preview = { error: err.message };
  }
  if (seq !== goalPreviewSeq) return;
  goalPreview = preview;
  const el = document.getElementById('goalPreview');
  if (el) el.innerHTML = goalPreviewHtml();
}

function goalPreviewHtml() {
  const p = goalPreview;
  if (!p) return '<p class="gl-n">Scoring your history…</p>';
  if (p.error) return `<p class="dn">${esc(p.error)}</p>`;
  if (p.unit === 'milestone') return milestonePreviewHtml(p);
  if (!p.n) return '<p class="gl-n">No trades in your history that this applies to.</p>';
  const comparison = p.cost == null || !p.brokenTrips ? ''
    : p.cost < 0 ? ` · breaking trades averaged ${fmtSignedUsd(p.avgBroken)} vs ${fmtSignedUsd(p.avgKept)}`
    : ' · trades that broke this did better than those that kept it';
  return `<p class="section-label">On your last ${p.n} ${p.unit === 'day' ? 'trading days' : 'trades'} this would have been</p>
    <p class="gl-line${p.thin ? ' thin' : ''}">kept ${goalPct(p.adherence)} · broken ${p.brokenTrips}×${comparison}${p.thin ? ' ⚠' : ''}</p>
    <p class="gl-line"><span class="gl-strip">${goalCells(p.strip)}</span> <span class="gl-n">last 14 days</span></p>`;
}

async function saveGoal() {
  const d = goalDraft;
  try {
    await changeGoal({ action: d.id ? 'edit' : 'add', id: d.id, type: d.type, params: d.params, session: d.session });
    closeGoalDrawerForce();
  } catch (err) {
    goalSaveError = err.message;
    renderGoalDrawer();
  }
}

function milestonePreviewHtml(p) {
  if (p.type === 'monthlyDrawdown') {
    if (!p.n) return '<p class="gl-n">No months on record yet.</p>';
    return `<p class="section-label">On your last ${p.n} months</p>
      <p class="gl-line">kept ${goalPct(p.adherence)} · worst month ${fallText(p.worst)}${p.approx ? ' (≈ wallet before snapshots began)' : ''}</p>`;
  }
  if (p.current == null) return '<p class="gl-n">No account value recorded yet.</p>';
  const now = `Now ${fmtUsd(p.current)}${p.currentApprox ? ' ≈ wallet' : ''}`;
  if (p.needed <= 0) return `<p class="gl-line">${now} · already above this target.</p>`;
  const due = p.daysLeft != null ? ` in ${fmt(p.daysLeft, 0)} days · ${fmtUsd(p.requiredPerDay ?? 0)} a day` : '';
  const pace = p.pace ? `Your trend over the last 30 days: ${fmtSignedUsd(p.pace.perDay)} a day${p.pace.approx ? ' (≈ wallet)' : ''}`
    : 'Not enough history for a trend yet.';
  return `<p class="gl-line">${now} · needs +${fmtUsd(p.needed)} (+${fmt(p.neededPct, 1)}%)${due}</p><p class="gl-line gl-n">${pace}</p>`;
}
