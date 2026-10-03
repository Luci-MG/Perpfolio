// funding-view.js — the Daily funding widget in the sidebar and its drawer: what holding the
// book costs at the estimated rate, hedged pairs netted, against what the ledger says was
// paid. The drawer reads /api/funding; the widget reads the dashboard poll.

let fundData = null, fundLoading = false;

const signedUsd = v => (v > 0 ? `+${fmtUsd(v)}` : fmtSignedUsd(v));
const signGlyph = v => (v > 0 ? '+' : v < 0 ? '−' : '');
const ratePctText = v => `${signGlyph(v)}${fmt(Math.abs(v), 4)}%`;
const aprText = v => `${signGlyph(v)}${fmt(Math.abs(v), 1)}%`;
const shortName = symbol => esc(jrSym(symbol));

function nextSettlementOf(positions) {
  const now = Date.now();
  const legs = positions.filter(p => p.nextFundingTime > now);
  if (!legs.length) return null;
  const at = Math.min(...legs.map(p => p.nextFundingTime));
  const amount = legs.filter(p => p.nextFundingTime === at)
    .reduce((s, p) => s + fundingPerDay(p) * fundingIntervalOf(p) / 24, 0);
  return { at, amount };
}

function countdownHtml(at) {
  return `<span data-until="${at}">${durationText(at - Date.now())}</span>`;
}

function tickCountdowns() {
  document.querySelectorAll('[data-until]').forEach(el => {
    el.textContent = durationText(Number(el.dataset.until) - Date.now());
  });
}

function renderDailyFundingWidget(data) {
  const hl = data.hyperliquid.positions, bn = data.binance.positions;
  const cost = positions => positions.reduce((sum, p) => sum + fundingPerDay(p), 0);
  const total = cost(hl) + cost(bn);
  const next = nextSettlementOf(bn);
  const tone = v => (v > 0 ? 'up' : v < 0 ? 'dn' : '');
  const venueRow = (label, venue, positions) => `<div class="fw-row"><span>${label}</span>${venueOn(venue)
    ? `<span class="sb-num ${tone(cost(positions))}">${signedUsd(cost(positions))}</span>` : '<span>off</span>'}</div>`;
  return `
    <div class="label" style="margin-bottom:6px">Daily funding</div>
    <div class="fw-total"><span class="sb-num ${total >= 0 ? 'up' : 'dn'}">${signedUsd(total)}</span><span class="fw-unit">/day est.</span></div>
    ${next ? `<div class="fw-row"><span>next in ${countdownHtml(next.at)}</span><span class="sb-num ${next.amount >= 0 ? 'up' : 'dn'}">${signedUsd(next.amount)}</span></div>` : ''}
    ${venueRow('HL', 'hyperliquid', hl)}${venueRow('BN', 'binance', bn)}`;
}

async function openFundDrawer() {
  document.getElementById('fundOverlay').classList.add('open');
  document.getElementById('fundDrawer').classList.add('open');
  renderFundBody();
  await fetchFunding();
}

function closeFundDrawer(e) {
  if (e && e.target !== document.getElementById('fundOverlay')) return;
  closeFundDrawerForce();
}

function closeFundDrawerForce() {
  document.getElementById('fundOverlay').classList.remove('open');
  document.getElementById('fundDrawer').classList.remove('open');
}

async function fetchFunding() {
  fundLoading = true;
  try {
    const data = await (await fetch('/api/funding')).json();
    if (!data.ok) throw new Error(data.error || 'funding failed');
    fundData = data;
    clearLoadError('funding');
  } catch (err) {
    noteLoadError('funding', err);
  } finally {
    fundLoading = false;
    renderFundBody();
  }
}

function sparkline(points) {
  if (!points?.length) return '';
  const W = 64, H = 16, lo = Math.min(0, ...points), hi = Math.max(0, ...points);
  const x = i => (points.length > 1 ? i / (points.length - 1) * W : W / 2);
  const y = v => H - (v - lo) / ((hi - lo) || 1) * H;
  const path = points.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  return `<svg class="fd-spark" viewBox="0 0 ${W} ${H}" aria-hidden="true"><line x1="0" x2="${W}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}"></line><path d="${path}"></path></svg>`;
}

function usualText(row) {
  const u = row.usual;
  if (!u) return '';
  if (!u.avgPct || Math.sign(u.avgPct) !== Math.sign(row.ratePct)) return `7d avg ${ratePctText(u.avgPct)}`;
  const ratio = row.ratePct / u.avgPct;
  return ratio >= 2 ? `${fmt(ratio, 1)}× its 7d avg` : ratio <= 0.5 ? 'below its 7d avg' : 'near its 7d avg';
}

function nearCapHtml(row) {
  const c = row.nearCap;
  if (!c) return '';
  return `<div class="fd-flag ${c.receiving ? 'up' : 'dn'}">⚠ ${fmt(c.share * 100, 0)}% of its cap — may switch to 1h settlements${c.receiving ? ', in your favour' : ''}</div>`;
}

function fundRowHtml(r) {
  const name = r.pair ? `${shortName(r.symbol)} hedge` : `${shortName(r.symbol)} <span class="gl-n">${r.side.toLowerCase()}</span>`;
  const legs = r.pair ? `<div class="gl-n">long ${signedUsd(r.long.perDay)} · short ${signedUsd(r.short.perDay)} a day</div>` : '';
  const venue = r.exchange === 'hyperliquid' ? ' <span class="gl-n">HL</span>' : '';
  const charged = r.usual?.lastCharged ? `<span title="charged at the last settlement">${ratePctText(r.usual.lastCharged.ratePct)}</span>` : '—';
  return `<tr>
    <td>${name}${venue}${legs}${nearCapHtml(r)}</td>
    <td>${ratePctText(r.ratePct)}<span class="gl-n"> /${r.intervalHours}h</span></td>
    <td class="gl-n">${aprText(r.aprPct)}</td>
    <td>${signedCell(r.perDay)}</td>
    <td>${sparkline(r.usual?.points)}<div class="gl-n">${usualText(r)}</div></td>
    <td class="gl-n">${charged}</td>
    <td class="gl-n">${r.nextAt ? countdownHtml(r.nextAt) : '—'}</td>
    <td>${r.realised7d ? signedCell(r.realised7d) : '<span class="gl-n">—</span>'}</td>
  </tr>`;
}

function fundSummaryHtml(d) {
  const t = d.totals, r = d.realised;
  const cell = (label, value, cls, sub) => `<div class="upnl-sum-cell"><div class="upnl-sum-label">${label}</div>
    <div class="upnl-sum-val ${cls}">${value}</div>${sub ? `<div class="gl-n">${sub}</div>` : ''}</div>`;
  const tone = v => (v > 0 ? 'up' : v < 0 ? 'dn' : '');
  return `<div class="upnl-summary-strip fd-summary">
    ${cell('Est. net / day', signedUsd(t.perDay), tone(t.perDay), 'at today’s estimated rates')}
    ${cell('Realised 7d', signedUsd(r.d7), tone(r.d7), `24h ${signedUsd(r.d1)} · 30d ${signedUsd(r.d30)}`)}
    ${cell('Of equity', t.pctOfEquityPerDay == null ? '—' : `${t.pctOfEquityPerDay < 0 ? '−' : ''}${fmt(Math.abs(t.pctOfEquityPerDay), 3)}%`, tone(t.perDay ?? 0), 'a day')}
    ${cell('On gross', t.aprOnGrossPct == null ? '—' : `${t.aprOnGrossPct < 0 ? '−' : ''}${fmt(Math.abs(t.aprOnGrossPct), 2)}%`, tone(t.perDay ?? 0), 'a year, estimated')}
  </div>`;
}

function fundNotesHtml(d) {
  const next = d.next ? `<p class="gl-line">Next settlement in ${countdownHtml(d.next.at)} · <span class="${d.next.amount >= 0 ? 'up' : 'dn'}">${signedUsd(d.next.amount)}</span></p>` : '';
  const gap = d.realised.differsFromEstimate
    ? `<p class="gl-line">Realised over 7 days averaged ${signedUsd(d.realised.perDay7d)} a day against ${signedUsd(d.totals.perDay)} estimated now: rates or positions have moved.</p>` : '';
  const synced = d.realised.syncedAt ? `<p class="gl-n">Realised as of the last history sync, ${goalWhen(new Date(d.realised.syncedAt).getTime())}.</p>` : '';
  return `${next}${gap}${synced}`;
}

function fundVenueLine(d) {
  const x = d.totals.byExchange;
  if (!x.binance || !x.hyperliquid) return '';
  return `<p class="gl-line">Binance ${signedUsd(x.binance)} · Hyperliquid ${signedUsd(x.hyperliquid)} a day</p>`;
}

function openFundingHistory() {
  closeFundDrawerForce();
  setView('journal');
  setJrTab('costs');
}

function renderFundBody() {
  const body = document.getElementById('fundDrawerBody');
  if (!body) return;
  if (!fundData) {
    body.innerHTML = loadErrors.funding ? loadErrorHtml('funding', 'fetchFunding()', false) : '<p class="gl-n">Reading funding…</p>';
    return;
  }
  const d = fundData;
  document.getElementById('fundDrawerSub').textContent =
    `${d.totals.legs} leg${d.totals.legs === 1 ? '' : 's'}${d.totals.pairs ? ` · ${d.totals.pairs} hedged pair${d.totals.pairs === 1 ? '' : 's'}` : ''}`;
  if (!d.rows.length) {
    body.innerHTML = `${loadErrorHtml('funding', 'fetchFunding()', true)}<p class="gl-n">No open positions.</p>`;
    return;
  }
  body.innerHTML = `${loadErrorHtml('funding', 'fetchFunding()', true)}${fundSummaryHtml(d)}${fundNotesHtml(d)}
    <table class="jr-tbl fd-tbl"><tr><th>position</th><th>est. rate</th><th>a year</th><th>a day</th><th>7 days</th><th>last</th><th>next</th><th>paid 7d</th></tr>
      ${d.rows.map(fundRowHtml).join('')}</table>
    ${fundVenueLine(d)}
    <button class="gl-link" onclick="openFundingHistory()">Funding by symbol over time ›</button>`;
}
