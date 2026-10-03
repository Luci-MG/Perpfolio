// goals-view.js — the Journal's Goals sub-tab, its add / edit drawer and the Overview line.
// Goal types and their form fields arrive with /api/goals, defined once in /goals.js.

let goalsData = null, goalsLoading = false;
let goalOpen = null, goalConfirmDelete = null;
let goalDraft = null, goalPreview = null, goalPreviewTimer = null, goalPreviewSeq = 0, goalSaveError = null;

const GOAL_MARK = { kept: '✓', broken: '✗', progress: '●', idle: '·', paused: '‖' };
const GOAL_CELL = { kept: ['▮', 'kept'], broken: ['✕', 'broken'], none: ['·', 'no trades'], unset: ['', 'before the goal was set'] };
const GOAL_SESSIONS = SESSION_CHOICES.filter(s => s !== 'All');
const goalTz = () => -new Date().getTimezoneOffset();
const goalDay = t => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
const goalWhen = t => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const goalPct = v => (v == null ? '—' : `${fmt(v * 100, 0)}%`);
const goalType = id => goalsData.types.find(t => t.id === id);
const goalDefaults = id => Object.fromEntries(goalType(id).params.map(p => [p.key, p.default]));

async function fetchGoals() {
  goalsLoading = true;
  try {
    const data = await (await fetch(`/api/goals?tz=${goalTz()}`)).json();
    if (!data.ok) throw new Error(data.error || 'goals failed');
    goalsData = data;
  } catch (err) {
    goalsData = { error: err.message };
  } finally {
    goalsLoading = false;
    if (posView === 'journal') rerenderStress();
  }
}

async function changeGoal(body) {
  const res = await fetch('/api/goals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
    <td>${esc(b.what)}</td><td>${signedCell(b.net)}</td>
    <td><button class="gl-link" onclick="openGoalBreach('${esc(b.symbol)}', ${b.openTime})">open ›</button></td></tr>`).join('');
  const more = g.breachCount > g.breaches.length ? `<p class="gl-n">latest ${g.breaches.length} of ${g.breachCount}</p>` : '';
  return `<table class="jr-tbl gl-breaches">${rows}</table>${more}`;
}

function goalDetail(g) {
  const b = g.before;
  const before = b ? `<p class="gl-line${b.thin ? ' thin' : ''}">Before you set it: ${goalPct(b.adherence)} kept over ${b.n}
    ${b.unit === 'day' ? 'days' : 'trades'}${b.cost != null && b.brokenTrips ? ` · est. cost ${fmtSignedUsd(b.cost)}` : ''}${b.thin ? ' ⚠' : ''}</p>` : '';
  const del = goalConfirmDelete === g.id ? 'Confirm delete' : 'Delete';
  return `<div class="gl-detail">
    <div class="gl-detail-top">${goalCalendar(g.calendar)}
      <p class="gl-line${g.thin ? ' thin' : ''}">${goalCostText(g)}</p></div>
    ${goalBreachesHtml(g)}${before}
    <p class="gl-line gl-n">set ${goalDay(g.setAt)}${g.pausedAt ? ` · paused ${goalDay(g.pausedAt)}` : ''}</p>
    <div class="gl-actions">
      <button class="st-btn" onclick="openGoalDrawer('${esc(g.id)}')">Edit</button>
      <button class="st-btn" onclick="goalAction('${esc(g.id)}', '${g.pausedAt ? 'resume' : 'pause'}')">${g.pausedAt ? 'Resume' : 'Pause'}</button>
      <button class="st-btn${goalConfirmDelete === g.id ? ' gl-danger' : ''}" onclick="goalAction('${esc(g.id)}', 'delete')">${del}</button>
    </div>
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

function goalsTodayText(today, goals) {
  if (today.scored) return `today ${today.kept} of ${today.scored} kept`;
  return `${goals.filter(g => g.status !== 'paused').length} set · no trades today`;
}

function goalsOverviewLine() {
  if (!goalsData?.goals?.length) return '';
  const t = goalsData.today;
  const broken = t.broken.length ? ` · <span class="dn">✗ ${esc(t.broken.join(', '))}</span>` : '';
  return `<button class="gl-overview" onclick="setJrTab('goals')"><span class="k">Goals</span>${goalsTodayText(t, goalsData.goals)}${broken}<span class="gl-caret">›</span></button>`;
}

function goalEmptyHtml(suggestions) {
  const items = suggestions.map((s, i) => `<button class="gl-suggest" onclick="openGoalDrawer(null, ${i})">
    <span class="gl-name">${esc(s.preview.label)}</span>
    <span class="gl-n">breaking it cost ${fmtSignedUsd(s.preview.cost)} over ${s.preview.brokenTrips} trades${s.preview.thin ? ' ⚠' : ''}</span>
  </button>`).join('');
  return `<p class="gl-empty">No goals yet.${suggestions.length ? ' From your history:' : ''}</p>${items}`;
}

function renderGoalsTab() {
  if (!goalsData) return `<p class="jt-count">Loading goals…</p>`;
  if (goalsData.error) return `<p style="font-size:12px;color:var(--danger)">Error: ${esc(goalsData.error)}</p>`;
  const { goals, today, suggestions } = goalsData;
  const head = `<div class="gl-top"><span class="section-label">Goals</span>
    <span class="gl-n">${goals.length ? goalsTodayText(today, goals) : ''}</span>
    <button class="st-btn" onclick="openGoalDrawer()">+ Add goal</button></div>`;
  const error = goalsData.actionError ? `<p class="dn gl-line">${esc(goalsData.actionError)}</p>` : '';
  if (!goals.length) return `${head}${error}${goalEmptyHtml(suggestions)}`;
  return `${head}${error}<div class="gl-list">${goals.map(goalRow).join('')}</div>`;
}

function openGoalDrawer(id = null, suggestion = null) {
  const goal = id ? goalsData.goals.find(g => g.id === id) : null;
  const source = goal || (suggestion != null ? goalsData.suggestions[suggestion] : null) || { type: goalsData.types[0].id };
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
  const input = spec.options
    ? `<select class="st-btn" onchange="setGoalParam('${spec.key}', this.value)">${spec.options.map(([v, l]) =>
        `<option value="${v}"${value === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`
    : `<input class="cf-sym gl-num" type="number" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${esc(String(value))}"
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
  const q = new URLSearchParams({ type: goalDraft.type, params: JSON.stringify(goalDraft.params), tz: goalTz() });
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
