// journal-timing.js — the Journal's Timing tab: the calendar of days, then weekday and hour by
// the local time a position opened, each average shrunk toward the book's with its interval,
// and when you trade as a grid of counts. The tested version of these splits is Factors.

const calStep = (pnl, max) => Math.min(3, 1 + Math.floor(Math.abs(pnl) / (max || 1) * 3));
const calDateText = date => new Date(`${date}T12:00:00Z`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

function calCell(d, max) {
  if (d.pnl == null) return `<span class="jr-cal-cell" title="${esc(d.date)} · no trading"></span>`;
  const label = `${calDateText(d.date)}: ${ovUsd(d.pnl)}, ${d.trips} trade${d.trips === 1 ? '' : 's'} closed`;
  const cls = d.pnl === 0 ? 'cal-zero' : `cal-${d.pnl > 0 ? 'gain' : 'loss'}-${calStep(d.pnl, max)}`;
  return `<button class="jr-cal-cell ${cls}" aria-label="${esc(label)}" title="${esc(label)}"
    onclick="openTradesFor({ closeDay: '${esc(d.date)}' })"></button>`;
}

function calendarHtml(cal) {
  if (!cal.weeks.length) return '<p class="gl-n">No trading in this window.</p>';
  const columns = cal.weeks.map(w => `<div class="jr-cal-col" title="Week of ${esc(w.start)}: ${ovUsd(w.total)}">
    ${w.days.map(d => calCell(d, cal.maxAbs)).join('')}</div>`).join('');
  const swatch = cls => `<span class="jr-cal-cell ${cls}"></span>`;
  const months = cal.months.map(m => `<span>${esc(m.month)} <b class="${ovTone(m.total)}">${ovUsd(m.total)}</b></span>`).join('');
  const weeks = [...cal.weeks].sort((a, b) => a.total - b.total);
  const extremes = weeks.length > 1 ? `<span class="gl-n">best week of ${esc(weeks.at(-1).start)} ${ovUsd(weeks.at(-1).total)} ·
    worst of ${esc(weeks[0].start)} ${ovUsd(weeks[0].total)}</span>` : '';
  return `<div class="jr-cal" role="group" aria-label="Net by day, one column per week, Monday at the top">${columns}</div>
    <div class="jr-cal-key">−${swatch('cal-loss-3')}${swatch('cal-loss-2')}${swatch('cal-loss-1')}${swatch('cal-zero')}${swatch('cal-gain-1')}${swatch('cal-gain-2')}${swatch('cal-gain-3')}+
      <span>orange is a loss, blue a gain, darker is larger · outlined: no trading · select a day for its trades</span></div>
    <div class="jr-cal-months">${months}${extremes}</div>`;
}

function estimateAxis(b) {
  const shown = b.rows.filter(r => !r.needs);
  const lo = Math.min(0, b.overall ?? 0, ...shown.map(r => r.ci.lo)), hi = Math.max(0, b.overall ?? 0, ...shown.map(r => r.ci.hi));
  const pad = (hi - lo || 1) * 0.04;
  return v => ((v - lo + pad) / (hi - lo + 2 * pad) * 100).toFixed(1);
}

function estimateRow(r, at, overall) {
  const n = `${r.units} unit${r.units === 1 ? '' : 's'} · ${ovUsd(r.total)}`;
  const guides = `<span class="sb-zero" style="left:${at(0)}%"></span>${overall == null ? '' : `<span class="sb-avg" style="left:${at(overall)}%"></span>`}`;
  if (r.needs) {
    return `<div class="sb-row needs"><span>${esc(r.label)}</span><span class="sb-track">${guides}</span>
      <span class="sb-val">${r.units ? `average after ${r.needs} more` : 'no trades'}</span><span class="sb-n">${n}</span></div>`;
  }
  return `<div class="sb-row"><span>${esc(r.label)}</span>
    <span class="sb-track" title="${esc(r.label)}: ${ovUsd(r.shrunk)}, 90% range ${ovUsd(r.ci.lo)} to ${ovUsd(r.ci.hi)}">${guides}
      <span class="sb-whisker" style="left:${at(r.ci.lo)}%;width:${(at(r.ci.hi) - at(r.ci.lo)).toFixed(1)}%"></span>
      <span class="sb-dot ${ovTone(r.shrunk)}" style="left:${at(r.shrunk)}%"></span></span>
    <span class="sb-val"><b class="${ovTone(r.shrunk)}">${ovUsd(r.shrunk)}</b> <span class="gl-n">${ovUsd(r.ci.lo)} to ${ovUsd(r.ci.hi)}</span></span>
    <span class="sb-n">${n}</span></div>`;
}

function shrunkBarsHtml(b) {
  const at = estimateAxis(b);
  const key = b.overall == null ? '' : `<div class="sb-key"><span class="sb-dot"></span> adjusted average · <span class="sb-key-line"></span> 90% range ·
    <span class="sb-key-avg"></span> book average ${ovUsd(b.overall)} · <span class="sb-key-zero"></span> $0</div>`;
  return `<div class="sb-bars">${b.rows.map(r => estimateRow(r, at, b.overall)).join('')}</div>${key}`;
}

function chanceLine(b) {
  const c = b.chance;
  if (!c.shown) return `Averages appear from ${b.min} units a bucket. Tested with intervals across the whole book in Factors.`;
  return `Each average per unit is pulled toward the book's in proportion to how few trades it rests on, so a bucket only stands
    apart from the dashed line when its trades say so. ${c.shown} bucket${c.shown === 1 ? '' : 's'} shown: about ${c.byChance} would stand clear of the
    average by chance alone, ${c.clear} do.`;
}

function gridHtml(g) {
  if (!g.max) return '';
  const head = `<tr><th></th>${Array.from({ length: 24 }, (_, h) => `<th>${h % 3 ? '' : String(h).padStart(2, '0')}</th>`).join('')}</tr>`;
  const rows = g.counts.map((hours, d) => `<tr><th>${g.weekdays[d].slice(0, 3)}</th>${hours.map((n, h) => {
    const label = `${g.weekdays[d]} ${String(h).padStart(2, '0')}:00 · ${n ? `${n} opened` : 'none opened'}`;
    return `<td title="${label}" aria-label="${label}" style="background:${n ? 'var(--count-hue)' : 'transparent'};opacity:${n ? (0.2 + 0.8 * n / g.max).toFixed(2) : 1};${n ? '' : 'border:0.5px solid var(--border)'}"></td>`;
  }).join('')}</tr>`).join('');
  return `<table class="jr-grid" aria-label="Units opened by weekday and hour">${head}${rows}</table>
    <div class="jr-cal-key">fewer <span class="jr-cal-cell" style="background:var(--count-hue);opacity:.25"></span><span class="jr-cal-cell" style="background:var(--count-hue);opacity:.6"></span><span class="jr-cal-cell" style="background:var(--count-hue)"></span> more · busiest cell ${g.max}</div>`;
}

function renderTimingTab() {
  const t = perfData.timing;
  const factors = '<button class="gl-link" onclick="setJrTab(\'factors\')">Tested in Factors ›</button>';
  const note = perfData.session ? `<p class="jr-session-note">${esc(perfData.session)} trips only: the calendar is their net by the day
    they closed, not the account's.</p>` : '';
  const source = t.calendarSource === 'trips' ? 'net of these trips by the day they closed' : 'net from the ledger by day, fees and funding in';
  if (!perfData.units.units && !t.calendar.weeks.length) return `${note}<p class="gl-n">No trips in this window.</p>`;
  return `${note}
    ${jrSection(`Every day <span class="gl-n">· ${source}</span>`, calendarHtml(t.calendar))}
    ${jrSection('Day of the week opened', shrunkBarsHtml(t.weekday), `${chanceLine(t.weekday)} ${factors}`)}
    ${jrSection('Hour opened', shrunkBarsHtml(t.hour), `${chanceLine(t.hour)} Your local time. ${factors}`)}
    ${jrSection('When you open positions', gridHtml(t.grid), 'Counts only: most cells hold one or two trades, too few to say how they went.')}`;
}
