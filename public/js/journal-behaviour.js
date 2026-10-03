// journal-behaviour.js — the Journal's Behaviour tab: each habit as an action, how often it
// happens and its trend, what it cost with an interval or why that cannot be told yet, the
// window before, and a way to turn it into a goal. Then position sizing.

const SAME_SHARE_PP = 2;
const sharePct = v => (v == null ? '—' : `${fmt(v * 100, 0)}%`);

function habitSpark(weekly) {
  const W = 64, H = 16, step = W / weekly.length;
  const max = Math.max(0.01, ...weekly.map(w => w?.share ?? 0));
  const bars = weekly.map((w, i) => (w ? `<rect x="${(i * step + 1).toFixed(1)}" width="${(step - 2).toFixed(1)}"
    y="${(H - Math.max(1, w.share / max * H)).toFixed(1)}" height="${Math.max(1, w.share / max * H).toFixed(1)}"></rect>` : '')).join('');
  const text = weekly.map(w => (w ? sharePct(w.share) : '—')).join(', ');
  return `<svg class="hb-spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Share by week, oldest first: ${text}"><title>Last 8 weeks: ${text}</title>${bars}</svg>`;
}

function habitVsBefore(h) {
  if (!h.previous || h.previous.share == null || h.share == null) return '<span class="gl-n">—</span>';
  const pp = (h.share - h.previous.share) * 100;
  if (Math.abs(pp) < SAME_SHARE_PP) return `<span class="gl-n">about the same (${sharePct(h.previous.share)})</span>`;
  return `<span class="${pp > 0 ? 'dn' : 'up'}">${pp > 0 ? '▲ more' : '▼ less'} often</span> <span class="gl-n">than ${sharePct(h.previous.share)}</span>`;
}

function habitCostCell(h) {
  if (h.kind === 'ratio') {
    return h.ratio == null ? '<span class="gl-n">—</span>'
      : `<b class="${h.ratio > 1 ? 'dn' : ''}">${fmt(h.ratio, 1)}×</b> <span class="gl-n">as long</span>`;
  }
  if (h.kind === 'count') return `<span class="gl-n">counted only</span>${h.pending ? `<div class="gl-n">context pending for ${h.pending} losing trips</div>` : ''}`;
  if (h.verdict === 'thin') return `<span class="gl-n">too few to tell${h.comparisonTrips != null ? ` (${h.trips} against ${h.comparisonTrips})` : ` (${h.trips})`}</span>`;
  const range = h.ci ? `<div class="gl-n" title="90% interval">${fmtPlusUsd(h.ci.lo)} to ${fmtPlusUsd(h.ci.hi)}</div>` : '';
  const label = h.verdict === 'cant-tell' ? '<div class="gl-n">can\'t tell yet</div>' : '';
  return `<b class="${h.verdict === 'costs' ? 'dn' : h.verdict === 'helps' ? 'up' : ''}">${fmtPlusUsd(h.cost)}</b>${range}${label}`;
}

function openHabitGoal(index) {
  const goal = perfData.habits[index]?.goal;
  if (goal && goalsData?.types) openGoalDrawerFrom(goal);
}

function habitRow(h, i) {
  const n = h.kind === 'comparison' ? `${h.trips} vs ${h.comparisonTrips}` : `${h.trips} of ${h.outOf}`;
  return `<tr class="${h.verdict === 'thin' ? 'jr-thin' : ''}">
    <td>${esc(h.label)}<span class="jr-sub">against ${esc(h.against)}</span></td>
    <td>${sharePct(h.share)} ${habitSpark(h.weekly)}<div class="gl-n">${n}</div></td>
    <td>${habitVsBefore(h)}</td>
    <td>${habitCostCell(h)}</td>
    <td><button class="gl-link" onclick="openHabitGoal(${i})">Set a rule ›</button><br>
      <button class="gl-link" onclick="setJrTab('factors')">See in Factors ›</button></td>
  </tr>`;
}

function habitsTable(habits) {
  return `<table class="jr-tbl jr-habits"><tr><th>habit</th><th>how often</th><th>vs before</th><th>cost</th><th></th></tr>
    ${habits.map(habitRow).join('')}</table>`;
}

function sizingSection(s) {
  if (!s) return '';
  const after = (k, a) => jrStat(k, a.median == null ? '—' : fmtUsd(a.median), `median of ${a.trips} trips`);
  return jrSection('Position size at open', `<div class="jr-hero">
    ${jrStat('Median', fmtUsd(s.median), `${s.trips} trips`)}
    ${jrStat('10th to 90th', `${fmtUsd(s.p10)} – ${fmtUsd(s.p90)}`, `largest ${fmtUsd(s.max)}`)}
    ${after('After a loss', s.afterLoss)}${after('After a win', s.afterWin)}
  </div>`);
}

function renderBehaviourTab() {
  const note = perfData.session ? `<p class="jr-session-note">${esc(perfData.session)} trips only; the trip before, your usual
    size and busy days still count every session.</p>` : '';
  if (!perfData.units.units) return `${note}<p class="gl-n">No trips in this window.</p>`;
  return `${note}${jrSection('Habits', habitsTable(perfData.habits),
      `Costs are 90% intervals that treat a day's trips as one draw; one that spans zero reads "can't tell yet". Replayed costs
       close the opening lot at the trip's average exit and are estimates. "Winner turned loser" and "held losers" are picked by the
       trip's own result, so they are counted, not costed.`)}
    ${sizingSection(perfData.sizing)}`;
}
