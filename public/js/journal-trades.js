// journal-trades.js — the Journal's Trades table, one row per round trip from /api/trips.
// TRADE_COLUMNS drives the header, the cells, sorting and the CSV export.

let tripsData = null, tripsLoading = false;
let tradesSort = { id: 'closed', dir: -1 };
let tradesFilter = { symbol: '', exact: false, side: 'all', result: 'all', hedged: 'all', tag: 'all', day: null, closeDay: null };
let noteEditing = null, noteError = null;
let tradesMore = loadPref('tradesMore', false);
let tradesShowAll = false;
const TRADES_PAGE = 50;

const tripNet = t => t.netAfterFunding ?? t.net;
const tripCosts = t => (t.funding ?? 0) - t.commission;
const heldText = h => h >= 48 ? `${fmt(h / 24, 1)}d` : h >= 1 ? `${fmt(h, 1)}h` : `${fmt(h * 60, 0)}m`;
const browserDate = t => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const utcText = t => new Date(t).toISOString().slice(5, 16).replace('T', ' ');
const pctText = v => `${v < 0 ? '−' : v > 0 ? '+' : ''}${fmt(Math.abs(v), 2)}%`;
const signedCell = v => `<span class="${v >= 0 ? 'up' : 'dn'}">${fmtSignedUsd(v)}</span>`;
const BTC_ARROW = { up: '▲', down: '▼', flat: '–' };

function contextGap(t) {
  const why = t.context === 'unavailable' ? 'no candles for this symbol' : 'arrives with the next sync';
  return `<span class="jt-gap" title="${why}">—</span>`;
}

const isoDay = t => new Date(t).toISOString().slice(0, 10);

function fundingGap(t) {
  if (t.fundingIncomplete) {
    const from = tripsData?.coverage?.incomeCompleteFrom;
    return `a hedged settlement is missing a leg's row${from ? ` — history before ${isoDay(from)} is beyond Binance's 3-month window` : ''}`;
  }
  const from = tripsData?.coverage?.incomeFrom;
  return `before the income ledger starts${from ? ` (${isoDay(from)})` : ''}`;
}

function entryGap() {
  const since = tripsData?.coverage?.entryCapturedSince;
  const why = since ? `captured from ${new Date(since).toISOString().slice(0, 10)}, only while the server runs`
                    : 'captured from the next trade on, only while the server runs';
  return `<span class="jt-gap" title="${why}">—</span>`;
}

function entryStopCell(e) {
  if (!e.stopLooked) return '<span class="jt-gap" title="read 5 minutes after the fill">…</span>';
  if (!e.yourStop) return '<span class="dn" title="no stop order 5 minutes after the fill">none</span>';
  const title = `your stop ${fmt(e.yourStop.distancePct, 2)}% away, suggested ${fmt(e.suggestedStop?.distancePct, 2)}%`;
  return `<span title="${title}">${e.stopVsSuggested == null ? `${fmt(e.yourStop.distancePct, 2)}%` : `${fmt(e.stopVsSuggested, 2)}× sugg`}</span>`;
}

const withEntry = (t, render) => (t.entry ? render(t.entry) : entryGap());

const tagChips = tags => (tags || []).map(tag => `<span class="jt-tag">${esc(tag)}</span>`).join('');

function notesCell(t) {
  const empty = !t.note && !t.tags?.length;
  return `<button class="jt-note" onclick="editTripNote('${esc(t.key)}')" title="${esc(t.note || 'Add a note or tags')}">${
    t.note ? '<span class="jt-pen">✎</span>' : ''}${tagChips(t.tags)}${empty ? '<span class="jt-gap">+</span>' : ''}</button>`;
}

const TRADE_COLUMNS = [
  { id: 'symbol', label: 'Symbol', value: t => t.symbol, cell: t => esc(jrSym(t.symbol)) },
  { id: 'side', label: 'Side', value: t => t.side, cell: t => `<span class="${t.side === 'Long' ? 'up' : 'dn'}">${t.side}</span>` },
  { id: 'opened', label: 'Opened UTC', value: t => t.openTime, cell: t => utcText(t.openTime),
    exports: [['opened_utc', t => new Date(t.openTime).toISOString()]] },
  { id: 'closed', label: 'Closed UTC', value: t => t.closeTime, cell: t => utcText(t.closeTime), more: true,
    exports: [['closed_utc', t => new Date(t.closeTime).toISOString()]] },
  { id: 'held', label: 'Held', value: t => t.holdHours, cell: t => heldText(t.holdHours),
    exports: [['held_hours', t => +t.holdHours.toFixed(4)]] },
  { id: 'size', label: 'Size', value: t => t.peakNotional,
    cell: t => `${fmtUsd(t.openNotional)} → ${fmtUsd(t.peakNotional)}`,
    exports: [['opened_usd', t => t.openNotional], ['peak_usd', t => t.peakNotional]] },
  { id: 'adds', label: 'Adds', value: t => t.adds,
    cell: t => (t.addsWhileUnderwater ? `<span class="dn" title="${t.addsWhileUnderwater} while underwater">${t.adds}</span>` : t.adds || '—'),
    exports: [['adds', t => t.adds], ['adds_underwater', t => t.addsWhileUnderwater], ['partial_closes', t => t.partialCloses]] },
  { id: 'net', label: 'Net', value: tripNet,
    cell: t => (t.funding == null ? `<span title="excludes funding: ${fundingGap(t)}">${signedCell(t.net)}*</span>` : signedCell(tripNet(t))),
    exports: [['net_after_funding', t => t.netAfterFunding], ['net_before_funding', t => t.net]] },
  { id: 'costs', label: 'Fees + funding', value: tripCosts,
    cell: t => `${signedCell(tripCosts(t))}${t.fundingSplit ? '<span class="jt-gap" title="no funding rate on record to tell the hedge legs apart, so it is shared evenly">≈</span>' : ''}`,
    exports: [] },
  { id: 'path', label: 'MAE / MFE', value: t => t.mae,
    cell: t => (t.mae == null ? contextGap(t) : `<span class="dn">${pctText(t.mae)}</span> / <span class="up">${pctText(t.mfe)}</span>`),
    exports: [['mae_pct', t => t.mae], ['mfe_pct', t => t.mfe], ['path_interval', t => t.pathInterval]] },
  { id: 'session', label: 'Session', value: t => t.session, cell: t => t.session },
  { id: 'notes', label: 'Notes', value: t => (t.tags || []).join(' ') || null, cell: notesCell,
    exports: [['note', t => t.note], ['tags', t => (t.tags || []).join(' ')]] },
  { id: 'hedged', label: 'Hedged', value: t => (t.hedged ? 1 : 0), cell: t => (t.hedged ? '✓' : ''),
    exports: [['hedged', t => t.hedged]] },
  { id: 'atr', label: 'ATR %', value: t => t.atrPct, more: true,
    cell: t => (t.atrPct == null ? contextGap(t) : `${fmt(t.atrPct, 2)}%`), exports: [['atr_pct', t => t.atrPct]] },
  { id: 'btc', label: 'BTC', value: t => t.btcTrend, more: true,
    cell: t => (t.btcTrend == null ? contextGap(t) : `<span title="BTC 1h EMA50 vs EMA200">${BTC_ARROW[t.btcTrend]}</span>`),
    exports: [['btc_trend', t => t.btcTrend]] },
  { id: 'entry', label: 'Entry → exit', value: t => t.avgEntry, more: true,
    cell: t => `${fmtPrice(t.avgEntry)} → ${fmtPrice(t.avgExit)}`,
    exports: [['avg_entry', t => t.avgEntry], ['avg_exit', t => t.avgExit]] },
  { id: 'realised', label: 'Realised', value: t => t.realized, more: true, cell: t => signedCell(t.realized) },
  { id: 'fees', label: 'Fees', value: t => t.commission, more: true, cell: t => signedCell(-t.commission),
    exports: [['fees', t => t.commission]] },
  { id: 'funding', label: 'Funding', value: t => t.funding, more: true,
    cell: t => (t.funding == null ? `<span class="jt-gap" title="${fundingGap(t)}">—</span>` : signedCell(t.funding)),
    exports: [['funding', t => t.funding], ['funding_split', t => t.fundingSplit]] },
  { id: 'eqEntry', label: 'Eq / margin at entry', value: t => t.entry?.account?.equity, more: true,
    cell: t => withEntry(t, e => (e.account ? `${fmtUsd(e.account.equity)} / ${fmt(e.account.marginPct, 1)}%` : entryGap())),
    exports: [['equity_at_entry', t => t.entry?.account?.equity], ['margin_pct_at_entry', t => t.entry?.account?.marginPct],
              ['free_margin_at_entry', t => t.entry?.account?.freeMargin]] },
  { id: 'lev', label: 'Lev', value: t => t.entry?.account?.leverage, more: true,
    cell: t => withEntry(t, e => (e.account?.leverage ? `${e.account.leverage}×` : entryGap())),
    exports: [['leverage_at_entry', t => t.entry?.account?.leverage]] },
  { id: 'cfEntry', label: 'Confluence at entry', value: t => t.entry?.confluence?.score, more: true,
    cell: t => withEntry(t, e => (e.confluence?.score == null ? entryGap()
      : `<span class="${e.confluence.score > 0 ? 'up' : e.confluence.score < 0 ? 'dn' : ''}" title="${esc(e.confluence.state)}">${e.confluence.score > 0 ? '▲' : e.confluence.score < 0 ? '▼' : '–'} ${fmt(Math.abs(e.confluence.score), 2)}</span>`)),
    exports: [['confluence_at_entry', t => t.entry?.confluence?.score], ['confluence_state_at_entry', t => t.entry?.confluence?.state],
              ['confluence_aligned_at_entry', t => t.entry?.confluence?.aligned]] },
  { id: 'stopEntry', label: 'Stop vs suggested', value: t => t.entry?.stopVsSuggested, more: true,
    cell: t => withEntry(t, entryStopCell),
    exports: [['your_stop_pct', t => t.entry?.yourStop?.distancePct], ['suggested_stop_pct', t => t.entry?.suggestedStop?.distancePct],
              ['stop_vs_suggested', t => t.entry?.stopVsSuggested]] },
  { id: 'fills', label: 'Fills', value: t => t.fills, more: true, cell: t => t.fills },
  { id: 'maker', label: 'Maker %', value: t => t.makerFills / t.fills, more: true,
    cell: t => `${fmt(t.makerFills / t.fills * 100, 0)}%`, exports: [['maker_fills', t => t.makerFills]] }
];

async function fetchTrips() {
  tripsLoading = true;
  try {
    const res = await fetch(`/api/trips${perfDays ? `?days=${perfDays}` : ''}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'trips failed');
    tripsData = data;
    clearLoadError('trips');
  } catch (err) {
    noteLoadError('trips', err);
  } finally {
    tripsLoading = false;
    if (posView === 'journal' && jrTab === 'trades') rerenderStress();
  }
}

function filteredTrips() {
  const f = tradesFilter;
  const sym = f.symbol.trim().toUpperCase();
  return (tripsData?.trips || []).filter(t =>
    (!sym || (f.exact ? t.symbol === sym : t.symbol.includes(sym)))
    && (sessionFilter === 'All' || t.session === sessionFilter)
    && (f.side === 'all' || t.side === f.side)
    && (f.result === 'all' || (f.result === 'win') === (tripNet(t) > 0))
    && (f.hedged === 'all' || (f.hedged === 'yes') === t.hedged)
    && (f.tag === 'all' || (f.tag === 'untagged' ? !t.tags?.length : t.tags?.includes(f.tag)))
    && (!f.day || (t.openTime >= f.day && t.openTime < f.day + 86_400_000))
    && (!f.closeDay || browserDate(t.closeTime) === f.closeDay));
}

function sortedTrips(trips) {
  const col = TRADE_COLUMNS.find(c => c.id === tradesSort.id);
  const key = t => col.value(t);
  return [...trips].sort((a, b) => {
    const x = key(a), y = key(b);
    if (x == null || y == null) return (x == null) - (y == null);
    return (x < y ? -1 : x > y ? 1 : 0) * tradesSort.dir;
  });
}

function tradesTableHtml() {
  const cols = TRADE_COLUMNS.filter(c => tradesMore || !c.more);
  const rows = sortedTrips(filteredTrips());
  const shown = tradesShowAll ? rows : rows.slice(0, TRADES_PAGE);
  const arrow = c => (c.id === tradesSort.id ? (tradesSort.dir > 0 ? ' ↑' : ' ↓') : '');
  const head = cols.map(c => `<th><button class="jt-sort" onclick="sortTrades('${c.id}')">${c.label}${arrow(c)}</button></th>`).join('');
  const body = shown.map(t => `<tr>${cols.map(c => `<td>${c.cell(t)}</td>`).join('')}</tr>${
    noteEditing === t.key ? `<tr class="jt-edit"><td colspan="${cols.length}">${noteEditorHtml(t)}</td></tr>` : ''}`).join('');
  const more = rows.length > shown.length
    ? `<button class="st-btn" onclick="showAllTrades()">Show all ${rows.length}</button>` : '';
  const scope = sessionFilter === 'All' ? '' : `${sessionFilter} · `;
  return `<p class="jt-count">${scope}${tripsData.trips.length} trips · ${rows.length} match · ${shown.length} shown</p>
    <div class="jt-wrap"><table class="jr-tbl jt-tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${more}`;
}

const knownTags = () => [...new Set((tripsData?.trips || []).flatMap(t => t.tags || []))].sort();

function noteEditorHtml(t) {
  return `<div class="jt-editor">
    <textarea id="jt-note-text" class="cf-sym" maxlength="500" rows="2" placeholder="Why you took it, what happened">${esc(t.note || '')}</textarea>
    <input id="jt-note-tags" class="cf-sym" list="jt-tag-list" placeholder="tags, comma separated" value="${esc((t.tags || []).join(', '))}">
    <datalist id="jt-tag-list">${knownTags().map(tag => `<option value="${esc(tag)}">`).join('')}</datalist>
    ${noteError ? `<span class="dn">${esc(noteError)}</span>` : ''}
    <button class="st-btn" onclick="cancelTripNote()">Cancel</button>
    <button class="st-btn on" onclick="saveTripNote('${esc(t.key)}')">Save</button>
  </div>`;
}

function editTripNote(key) {
  noteEditing = noteEditing === key ? null : key;
  noteError = null;
  refreshTradesTable();
}

function cancelTripNote() {
  if (noteEditing == null) return;
  noteEditing = null;
  refreshTradesTable();
}

async function saveTripNote(key) {
  const note = document.getElementById('jt-note-text').value;
  const tags = document.getElementById('jt-note-tags').value.split(',').map(s => s.trim()).filter(Boolean);
  try {
    const res = await fetch('/api/annotations', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                                                  body: JSON.stringify({ key, note, tags }) });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'save failed');
    const trip = tripsData.trips.find(t => t.key === key);
    Object.assign(trip, { note: data.annotation?.note || null, tags: data.annotation?.tags ?? [] });
    noteEditing = null;
    noteError = null;
    reloadFactors();
    if (goalsData) fetchGoals();
  } catch (err) {
    noteError = err.message;
  }
  refreshTradesTable();
}

function refreshTradesTable() {
  const el = document.getElementById('jt-table');
  if (el) el.innerHTML = tradesTableHtml();
}

function sortTrades(id) {
  tradesSort = { id, dir: tradesSort.id === id ? -tradesSort.dir : -1 };
  refreshTradesTable();
}

function filterTrades(key, value) {
  tradesFilter = { ...tradesFilter, [key]: value };
  tradesShowAll = false;
  refreshTradesTable();
}

function openTradesFor(filter) {
  tradesFilter = { ...tradesFilter, symbol: '', exact: false, day: null, closeDay: null, ...filter };
  tradesShowAll = false;
  setJrTab('trades');
}

function showAllTrades() { tradesShowAll = true; refreshTradesTable(); }

function toggleTradeColumns() {
  tradesMore = !tradesMore;
  savePref('tradesMore', tradesMore);
  rerenderStress();
}

function tradesCsv() {
  const fields = TRADE_COLUMNS.flatMap(c => c.exports || [[c.id, c.value]]);
  const cell = v => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [fields.map(([h]) => h).join(','),
    ...sortedTrips(filteredTrips()).map(t => fields.map(([, f]) => cell(f(t))).join(','))].join('\n');
}

function exportTradesCsv() {
  const url = URL.createObjectURL(new Blob([tradesCsv()], { type: 'text/csv' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: `trades-${new Date().toISOString().slice(0, 10)}.csv` });
  link.click();
  URL.revokeObjectURL(url);
}

function tradesSelect(key, options) {
  return `<select class="st-btn" onchange="filterTrades('${key}', this.value)">${options.map(([v, l]) =>
    `<option value="${esc(v)}"${tradesFilter[key] === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
}

function reloadTrips() {
  tripsData = null;
  if (jrTab === 'trades') fetchTrips();
}

function renderTradesTab() {
  if (!tripsData) return loadErrors.trips ? loadErrorHtml('trips', 'fetchTrips()', false) : `<p class="jt-count">Loading trips…</p>`;
  const pending = tripsData.coverage.pending;
  const controls = `<div class="jt-controls">
    <input class="cf-sym" placeholder="Symbol" value="${esc(tradesFilter.symbol)}" oninput="tradesFilter.exact = false; filterTrades('symbol', this.value)">
    ${tradesSelect('side', [['all', 'Long + short'], ['Long', 'Long'], ['Short', 'Short']])}
    ${tradesSelect('result', [['all', 'Wins + losses'], ['win', 'Wins'], ['loss', 'Losses']])}
    ${tradesSelect('hedged', [['all', 'Hedged or not'], ['yes', 'Hedged at entry'], ['no', 'Not hedged']])}
    ${tradesSelect('tag', [['all', 'Any tag'], ['untagged', 'Untagged'], ...knownTags().map(tag => [tag, tag])])}
    ${tradesFilter.day ? `<button class="st-btn on" onclick="filterTrades('day', null)" title="Show every day">${new Date(tradesFilter.day).toLocaleDateString([], { month: 'short', day: 'numeric' })} ✕</button>` : ''}
    ${tradesFilter.closeDay ? `<button class="st-btn on" onclick="filterTrades('closeDay', null)" title="Show every day">closed ${esc(tradesFilter.closeDay)} ✕</button>` : ''}
    <button class="st-btn" onclick="toggleTradeColumns()">${tradesMore ? 'Fewer columns' : 'More columns'}</button>
    <button class="st-btn" onclick="exportTradesCsv()">Export CSV</button>
  </div>`;
  const orphans = tripsData.coverage.orphanNotes;
  const note = `${pending ? `<p class="jt-count">Price path and market context for ${pending} trips arrive with the next sync.</p>` : ''}${
    orphans ? `<p class="jt-count">${orphans} note${orphans > 1 ? 's' : ''} no longer match a trip.</p>` : ''}`;
  return `${controls}${loadErrorHtml('trips', 'fetchTrips()', true)}${note}<div id="jt-table">${tradesTableHtml()}</div>`;
}
