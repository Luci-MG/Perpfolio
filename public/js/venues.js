// venues.js — the status bulb and its popover: switch each exchange on or off on the server.
// An exchange that is off is not called at all, so its figures read "off" rather than $0.

const VENUE_LABEL = { binance: 'Binance', hyperliquid: 'Hyperliquid' };
const VENUE_COLOR = { binance: 'var(--bn)', hyperliquid: 'var(--hl)' };
let venueState = null;
let venueError = null;
let lastHealth = null;

function venueOn(venue) { return lastData?.venues?.[venue] !== false; }

function venuesOn() { return ['hyperliquid', 'binance'].filter(venueOn); }

function shownVenues() {
  const filtered = venuesOn().filter(v => exchFilter.has(v));
  return filtered.length ? filtered : venuesOn();
}

function offOr(venue, html) { return venueOn(venue) ? html : '<span class="b-val nu">off</span>'; }

function venueOffHtml(venue) {
  return `<div class="venue-off">
    <p>${VENUE_LABEL[venue]} is switched off, so there is nothing to read here.</p>
    <button class="st-btn" onclick="setVenue('${venue}', true)">Switch ${VENUE_LABEL[venue]} on</button>
  </div>`;
}

function allVenuesOffHtml() {
  return `<div class="venue-off"><p>Every exchange is switched off. Switch one on from the status bulb.</p></div>`;
}

function bulbClass() {
  const on = venuesOn().length;
  const shape = on === 0 ? ' off' : on < 2 ? ' partial' : '';
  const level = lastHealth && lastHealth.level !== 'ok' ? ` ${lastHealth.level}` : '';
  return `status-dot${shape}${level}`;
}

async function toggleVenuePopover(e) {
  e.stopPropagation();
  const pop = document.getElementById('venuePopover');
  if (!pop.hidden) return closeVenuePopover();
  pop.hidden = false;
  document.getElementById('venueBulb').setAttribute('aria-expanded', 'true');
  renderVenuePopover();
  await loadVenues();
}

function closeVenuePopover() {
  const pop = document.getElementById('venuePopover');
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  document.getElementById('venueBulb').setAttribute('aria-expanded', 'false');
}

async function loadVenues() {
  try {
    const data = await (await fetch('/api/venues')).json();
    if (!data.ok) throw new Error(data.error || 'venues failed');
    venueState = data.venues;
    venueError = null;
  } catch (err) {
    venueError = err.message;
  }
  renderVenuePopover();
}

function venueStatusText(s) {
  if (!s.configured) return 'not set up in .env';
  if (!s.enabled) return 'off';
  return s.snapshotAgeMs == null ? 'on, not read yet' : `synced ${Math.round(s.snapshotAgeMs / 1000)}s ago`;
}

function renderVenuePopover() {
  const pop = document.getElementById('venuePopover');
  if (!pop || pop.hidden) return;
  if (!venueState) {
    pop.innerHTML = `<p class="vp-note">${venueError ? `Failed: ${esc(venueError)}` : 'Reading…'}</p>`;
    return;
  }
  const reasons = lastHealth?.reasons || [];
  const rows = Object.entries(venueState).map(([v, s]) => {
    const issues = s.enabled ? reasons.filter(r => (/hyperliquid/i.test(r.text) ? 'hyperliquid' : 'binance') === v) : [];
    return `<div class="vp-row">
      <span class="vp-dot" style="background:${VENUE_COLOR[v]}"></span>
      <span class="vp-name">${VENUE_LABEL[v]}</span>
      <span class="vp-status">${venueStatusText(s)}</span>
      <label class="vp-switch" title="${s.configured ? `Switch ${VENUE_LABEL[v]} ${s.enabled ? 'off' : 'on'}` : 'Add credentials to .env first'}">
        <input type="checkbox" ${s.enabled ? 'checked' : ''} ${s.configured ? '' : 'disabled'} onchange="setVenue('${v}', this.checked, this)"><span></span>
      </label>
      ${issues.map(i => `<div class="vp-issue ${i.level}">${esc(i.text)}</div>`).join('')}
    </div>`;
  }).join('');
  pop.innerHTML = rows + (venueError ? `<p class="vp-note vp-err">Failed: ${esc(venueError)}</p>` : '');
}

async function setVenue(venue, on, input) {
  if (venue === 'binance' && !on && !confirm('Switch Binance off? This also closes the live order stream; nothing is read from Binance until you switch it back on.')) {
    if (input) input.checked = true;
    return;
  }
  try {
    const res = await fetch('/api/venues', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ venue, enabled: on })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'switch failed');
    venueState = data.venues;
    venueError = null;
  } catch (err) {
    venueError = err.message;
    if (input) input.checked = !on;
  }
  renderVenuePopover();
  if (venue === 'binance') { riskBook = null; unwindData = null; hlData = null; }
  riskForceRender = true;
  await fetchData();
  if (venue === 'binance' && venueOn('binance') && toolFor(posView)?.binanceOnly) setView(posView);
}
