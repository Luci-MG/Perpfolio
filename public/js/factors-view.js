// factors-view.js — the Journal's Factors tab: which conditions at entry go with better or
// worse trips, from /api/factors. Verdict first, every factor behind "show all".

let factorsData = null, factorsLoading = false, factorsShowAll = false;

const FACTOR_STABILITY = { holds: 'holds recently', fades: 'fades recently', thin: 'too few recent trips' };
const plusUsd = v => (v > 0 ? `+${fmtUsd(v)}` : fmtSignedUsd(v));
const factorPct = v => `${fmt(v * 100, 0)}%`;

async function fetchFactors() {
  factorsLoading = true;
  try {
    const query = [`tz=${-new Date().getTimezoneOffset()}`, perfDays ? `days=${perfDays}` : '', sessionParam()].filter(Boolean).join('&');
    const data = await (await fetch(`/api/factors?${query}`)).json();
    if (!data.ok) throw new Error(data.error || 'factors failed');
    factorsData = data;
    clearLoadError('factors');
  } catch (err) {
    noteLoadError('factors', err);
  } finally {
    factorsLoading = false;
    if (posView === 'journal' && jrTab === 'factors') rerenderStress();
  }
}

function reloadFactors() {
  factorsData = null;
  if (jrTab === 'factors') fetchFactors();
}

function toggleFactorsShowAll() {
  factorsShowAll = !factorsShowAll;
  rerenderStress();
}

function openFactorGoal(index) {
  const goal = factorsData.worse[index]?.goal;
  if (goal && goalsData?.types) openGoalDrawerFrom(goal);
}

function factorFlags(b) {
  return [b.thin ? '<span title="under 40 trips">⚠</span>' : '',
    b.signFlip ? '<span title="changes sign when size or hedging is held equal">⚑</span>' : '',
    b.medianDisagrees ? '<span title="the median trip moves the other way: a few large trips drive the average">≠ median</span>' : '']
    .filter(Boolean).join(' ');
}

function verdictRow(b, i) {
  const worse = b.diff < 0;
  const goal = worse && b.goal ? ` <button class="gl-link" onclick="openFactorGoal(${i})">set a goal ›</button>` : '';
  return `<div class="fx-verdict${b.thin ? ' thin' : ''}">
    <span class="gl-mark ${worse ? 'broken' : 'kept'}">${worse ? '✗' : '✓'}</span>
    <span class="gl-name">${esc(b.bucket)} <span class="gl-n">${esc(b.label)}</span></span>
    <span class="${worse ? 'dn' : 'up'}">${plusUsd(b.diff)}/trip</span>
    <span class="gl-n">[${plusUsd(b.ci.lo)}, ${plusUsd(b.ci.hi)}] · win ${factorPct(b.winRate)} vs ${factorPct(b.restWinRate)} · n=${b.n} (${b.days}d) · ${FACTOR_STABILITY[b.stability]} ${factorFlags(b)}</span>${goal}
  </div>`;
}

function intervalBar(b, scale) {
  const x = v => 50 + v / scale * 50;
  const lo = Math.max(0, x(b.ci.lo)), hi = Math.min(100, x(b.ci.hi));
  return `<span class="fx-bar" title="90% interval ${plusUsd(b.ci.lo)} to ${plusUsd(b.ci.hi)} per trip">
    <span class="fx-zero"></span>
    <span class="fx-ci ${b.ci.hi < 0 ? 'dn' : b.ci.lo > 0 ? 'up' : ''}" style="left:${lo.toFixed(1)}%;width:${Math.max(1, hi - lo).toFixed(1)}%"></span>
    <span class="fx-dot" style="left:${Math.min(100, Math.max(0, x(b.diff))).toFixed(1)}%"></span>
  </span>`;
}

function factorTable(factors, scale, titled = true) {
  return factors.map(f => {
    const title = titled ? `<p class="section-label fx-factor">${esc(f.label)}</p>` : '';
    const hidden = f.hiddenBuckets ? `<p class="gl-n">${f.hiddenBuckets} bucket${f.hiddenBuckets > 1 ? 's' : ''} under 20 trips or 8 days</p>` : '';
    if (!f.buckets.length) return `${title}${hidden || '<p class="gl-n">no trips</p>'}`;
    const rows = f.buckets.map(b => `<tr class="${b.thin ? 'jr-thin' : ''}">
      <td>${esc(b.bucket)}${b.standsOut ? ' <b>•</b>' : ''}</td>
      <td>${signedCell(b.avgNet)}</td><td>${signedCell(b.diff)}</td><td>${intervalBar(b, scale)}</td>
      <td>${factorPct(b.winRate)} <span class="gl-n">${factorPct(b.winCi.lo)}–${factorPct(b.winCi.hi)}</span></td>
      <td>${b.n} <span class="gl-n">${b.days}d</span></td><td class="gl-n">${b.stability}</td><td>${factorFlags(b)}</td></tr>`).join('');
    return `${title}
      <table class="jr-tbl fx-tbl"><tr><th>bucket</th><th>avg net</th><th>vs rest</th><th>interval</th><th>win</th><th>n</th><th>recent</th><th></th></tr>${rows}</table>${hidden}`;
  }).join('');
}

function renderFactorsTab() {
  if (!factorsData) return loadErrors.factors ? loadErrorHtml('factors', 'fetchFactors()', false) : `<p class="jt-count">Comparing factors…</p>`;
  const d = factorsData;
  const verdicts = [...d.worse, ...d.better];
  const head = `<div class="gl-top"><span class="section-label">What goes with better or worse trips</span>
    <span class="gl-n">${d.comparisons} comparisons · ${d.trips} trips over ${d.days} days · exploratory, association not cause</span></div>`;
  const verdict = verdicts.length
    ? `${d.worse.map(verdictRow).join('')}${d.better.map(b => verdictRow(b, -1)).join('')}`
    : '<p class="gl-empty">Nothing stands out yet at this sample size.</p>';
  const waiting = d.waiting.length ? `<p class="gl-n fx-waiting">${esc(d.waiting.join(', '))}: waiting for captured entries (${d.entryCaptured} so far)</p>` : '';
  const session = d.session ? `<p class="jr-session-note">Session and weekend factors are hidden while the ${esc(d.session)} filter is on.</p>` : '';
  const toggle = `<button class="st-btn fx-toggle" onclick="toggleFactorsShowAll()">${factorsShowAll ? 'Hide factors' : 'Show all factors'}</button>`;
  const stale = loadErrorHtml('factors', 'fetchFactors()', true);
  if (!factorsShowAll) return `${head}${stale}${session}${verdict}${waiting}${toggle}`;
  const all = [...d.factors, ...d.during, d.tags].flatMap(f => f.buckets);
  const scale = Math.max(1, ...all.flatMap(b => [Math.abs(b.ci.lo), Math.abs(b.ci.hi)]));
  return `${head}${stale}${session}${verdict}${waiting}${toggle}
    ${factorTable(d.factors, scale)}
    <p class="section-label gl-block">During the trade</p>
    <p class="gl-n">Not known at entry, so never ranked with the factors above; the cost of each habit is under Behaviour.</p>
    ${factorTable(d.during, scale)}
    <p class="section-label gl-block">Your tags</p>
    <p class="gl-n">Set after the trade, so read with care: a tag can follow the result.</p>
    ${d.tags.buckets.length || d.tags.hiddenBuckets ? factorTable([d.tags], scale, false)
      : '<p class="gl-n">Tag trips in Trades to compare them here.</p>'}`;
}
