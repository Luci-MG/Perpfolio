// sessions-view.js — the session clock in the sidebar header and the dashboard-wide session
// filter that Journal and Confluence honour. Session definitions are /sessions.js.

const SESSION_CHOICES = ['All', 'Asia', 'Europe', 'Europe + US', 'US', 'Off-hours'];
let sessionsModule = null;
let sessionFilter = (s => (SESSION_CHOICES.includes(s) ? s : 'All'))(loadPref('session', 'All'));

const sessionParam = () => (sessionFilter === 'All' ? '' : `session=${encodeURIComponent(sessionFilter)}`);

function durationText(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

const localTime = t => new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });

function sessionClockText(c, now) {
  const closing = c.markets.filter(m => m.open && m.closesAt).sort((a, b) => a.closesAt - b.closesAt)[0];
  const opening = c.markets.filter(m => !m.open && m.opensAt).sort((a, b) => a.opensAt - b.opensAt)[0];
  const edge = closing ? `${closing.name} closes in ${durationText(closing.closesAt - now)}`
    : opening ? `${opening.name} opens in ${durationText(opening.opensAt - now)}` : '';
  const next = c.next ? `next: ${c.next.session} in ${durationText(c.next.at - now)}` : '';
  return [c.session, edge, next].filter(Boolean).join(' · ');
}

function sessionClockInner() {
  if (!sessionsModule) return '';
  const now = Date.now();
  const c = sessionsModule.clockAt(now);
  const title = c.markets.map(m => (m.open ? `${m.name}: open, closes ${localTime(m.closesAt)}`
    : `${m.name}: opens ${localTime(m.opensAt)}`)).join('\n');
  return `<span class="session-dot ${c.session === 'Off-hours' ? 'off' : ''}"></span><span title="${esc(title)}">${esc(sessionClockText(c, now))}</span>`;
}

function renderSessionClock() {
  const el = document.getElementById('sessionClock');
  if (el) el.innerHTML = sessionClockInner();
}

async function startSessionClock() {
  sessionsModule = await import('/sessions.js');
  renderSessionClock();
  setInterval(renderSessionClock, 60_000);
}

function sessionSelectHtml() {
  return `<select class="st-btn" onchange="setSession(this.value)" aria-label="Session" title="Session: applies to trips and confluence calibration">
    ${SESSION_CHOICES.map(s => `<option value="${s}"${s === sessionFilter ? ' selected' : ''}>${s === 'All' ? 'All sessions' : s}</option>`).join('')}
  </select>`;
}

function setSession(value) {
  sessionFilter = SESSION_CHOICES.includes(value) ? value : 'All';
  savePref('session', sessionFilter);
  perfData = null;
  cfData = null;
  if (posView === 'journal') fetchPerformance();
  if (posView === 'confluence') fetchConfluence();
  rerenderStress();
}
