// journal-costs.js — the Journal's Costs tab: what trading cost in basis points of notional and in
// dollars against the window before, the fee rate against the account's own, costs week by week
// and by symbol, and the wallet ledger with the checks that say whether it reconciles.

const bpText = v => (v == null ? '—' : `${fmt(v, 1)} bp`);
const sharePctText = v => (v == null ? '—' : `${fmt(v * 100, 0)}%`);

function costVs(current, before, format, lowerIsBetter = true) {
  if (current == null || before == null) return '';
  const delta = current - before;
  const better = lowerIsBetter ? delta < 0 : delta > 0;
  return `<div class="s">vs ${format(before)} before ${delta ? `<span class="${better ? 'up' : 'dn'}">${delta > 0 ? '▲' : '▼'}</span>` : '='}</div>`;
}

function makerSpark(trend) {
  const W = 64, H = 16, step = W / trend.length;
  const bars = trend.map((w, i) => (w ? `<rect x="${(i * step + 1).toFixed(1)}" width="${(step - 2).toFixed(1)}"
    y="${(H - Math.max(1, w.share * H)).toFixed(1)}" height="${Math.max(1, w.share * H).toFixed(1)}"></rect>` : '')).join('');
  const text = trend.map(w => (w ? sharePctText(w.share) : '—')).join(', ');
  return `<svg class="hb-spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Maker share by week, oldest first: ${text}"><title>Last 8 weeks: ${text}</title>${bars}</svg>`;
}

function costsHeadline(c) {
  const s = c.summary, p = c.previous;
  const usd = v => ovUsd(v);
  const drag = s.feeDragPct == null ? jrStat('Fee drag', '—', 'gross is under twice the costs, so a share of it says little')
    : jrStat('Fee drag', `${fmt(s.feeDragPct, 1)}%`, `of ${usd(s.gross)} gross realised${costVs(s.feeDragPct, p?.feeDragPct, v => (v == null ? '—' : `${fmt(v, 1)}%`))}`);
  return `<div class="jr-hero">
    ${jrStat('Fees', bpText(s.feesBp), `${usd(-s.fees)} on ${fmtUsd(s.traded)} traded${costVs(s.feesBp, p?.feesBp, bpText)}`)}
    ${jrStat('Funding', bpText(s.fundingBp), `paid <span class="dn">${usd(s.fundingPaid)}</span> · received <span class="up">${usd(s.fundingReceived)}</span>${
      s.fundingUnknown ? ` · ${s.fundingUnknown} trips unknown` : ''}${costVs(s.fundingBp, p?.fundingBp, bpText, false)}`, ovTone(s.fundingBp ?? 0))}
    ${jrStat('Maker share', `${sharePctText(s.makerShare)} ${makerSpark(c.makerTrend)}`, `by notional, last 8 weeks beside it${costVs(s.makerShare, p?.makerShare, sharePctText, false)}`)}
    ${drag}
  </div>`;
}

function feeCheckLine(c) {
  const f = c.feeCheck, s = c.summary;
  const rate = Object.values(f.rates)[0];
  const check = f.expectedBp == null ? 'Your own fee rates could not be read.'
    : `You paid ${bpText(f.effectiveBp)} of notional; your rates${rate ? ` (maker ${fmt(rate.makerBp, 1)} bp, taker ${fmt(rate.takerBp, 1)} bp)` : ''}
       imply ${bpText(f.expectedBp)} for your maker share, on the ${sharePctText(f.pricedShare)} of notional in your largest symbols${f.assumed ? ', some rates assumed' : ''}.`;
  const burn = c.feeBurn == null ? '' : ` BNB fee discount ${c.feeBurn ? 'on' : 'off'}.`;
  const bnb = s.bnb.fee ? ` ${fmt(s.bnb.fee, 4)} BNB of fees${s.bnb.usd == null ? ', not priced' : ` ≈ ${fmtUsd(s.bnb.usd)} at each day's close`}.` : '';
  return `<p class="gl-line">${check}${burn}${bnb}</p>
    <p class="gl-n">Slippage: not measured. It needs the price at the moment each order was sent, which the trade history does not keep.</p>`;
}

function weeklyCostsHtml(weeks) {
  if (!weeks.length) return '<p class="gl-n">No trades in this window.</p>';
  const W = 1000, H = 120, mid = 60, gap = 2;
  const max = Math.max(1e-9, ...weeks.map(w => Math.max(w.received, w.fees - w.paid)));
  const bw = Math.min(40, W / weeks.length * 0.6);
  const x = i => (i + 0.5) * W / weeks.length - bw / 2;
  const h = v => Math.abs(v) / max * (mid - 6);
  const bars = weeks.map((w, i) => {
    const fee = h(w.fees), paid = h(w.paid), got = h(w.received);
    const label = `Week of ${w.week}: fees ${ovUsd(-w.fees)}, funding paid ${ovUsd(w.paid)}, received ${ovUsd(w.received)}`;
    return `<g><title>${esc(label)}</title>
      ${got ? `<rect x="${x(i).toFixed(1)}" y="${(mid - got).toFixed(1)}" width="${bw.toFixed(1)}" height="${got.toFixed(1)}" rx="2" fill="var(--cal-gain-2)"></rect>` : ''}
      ${fee ? `<rect x="${x(i).toFixed(1)}" y="${mid}" width="${bw.toFixed(1)}" height="${fee.toFixed(1)}" rx="2" fill="var(--text3)"></rect>` : ''}
      ${paid ? `<rect x="${x(i).toFixed(1)}" y="${(mid + fee + (fee ? gap : 0)).toFixed(1)}" width="${bw.toFixed(1)}" height="${paid.toFixed(1)}" rx="2" fill="var(--cal-loss-2)"></rect>` : ''}</g>`;
  }).join('');
  return `<svg class="cost-weeks" viewBox="0 0 ${W} ${H}" role="img" aria-label="Fees and funding by week">
      <line x1="0" x2="${W}" y1="${mid}" y2="${mid}" stroke="var(--border2)" stroke-width="1" vector-effect="non-scaling-stroke"></line>${bars}</svg>
    <div class="jr-chart-foot"><span>${esc(weeks[0].week)}</span><span>up: funding received · down: fees (grey), then funding paid (orange)</span><span>${esc(weeks.at(-1).week)}</span></div>`;
}

function symbolCostBars(part, sign) {
  const rows = part.top.map(e => ({ label: jrSym(e.symbol), net: sign * Math.abs(e.value), trips: e.trips, thin: false }));
  if (part.others.symbols) rows.push({ label: `others (${part.others.symbols})`, net: sign * Math.abs(part.others.value), trips: part.others.symbols, thin: false });
  return rows.length ? jrDivergingBars(rows, { showCount: false }) : '<p class="gl-n">None in this window.</p>';
}

function ledgerCheckText(check) {
  const ok = v => Math.abs(v) < 0.01;
  if (check.id === 'start') return check.checked ? `start against the equity snapshot then: ${ok(check.diff) ? 'matches' : `off by ${ovUsd(check.diff)}`}`
    : 'start: no equity snapshot that far back yet';
  if (check.id === 'realised') return `realised against your fills: ${ok(check.diff) ? 'matches' : `off by ${ovUsd(check.diff)}`}`;
  if (check.id === 'fees') return `fees against your fills: ${ok(check.diff) ? 'match' : `off by ${ovUsd(check.diff)}`}`;
  return !check.checked ? 'funding: not checked' : check.rows ? `funding: ${check.rows} payments, ${ovUsd(check.diff)}, match no position in the history` : 'funding: every payment matches a position';
}

function walletLedgerSection() {
  const l = perfData.costs.ledger;
  if (!l) return jrSection('How the wallet got here', '<p class="gl-n">Needs Binance switched on and one history sync.</p>');
  const row = (k, v, cls = '', extra = '') => `<div class="jr-flow-row ${extra}"><span class="k">${k}</span><span class="${cls}">${v}</span></div>`;
  const since = new Date(l.from).toLocaleDateString([], { month: 'short', day: 'numeric' });
  const synced = new Date(l.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const note = perfData.session ? ` The ledger is the whole account; the ${esc(perfData.session)} filter does not apply to it.` : '';
  return jrSection('How the wallet got here', `<div class="jr-flow">
      ${row(`wallet on ${since}`, fmtUsd(l.start), '', 'muted')}
      ${row('deposits and withdrawals', ovUsd(l.transfers), ovTone(l.transfers))}
      ${row('realised profit and loss', ovUsd(l.realised), ovTone(l.realised))}
      ${row('trading fees', ovUsd(l.fees), 'dn')}
      ${row('funding', ovUsd(l.funding), ovTone(l.funding))}
      ${l.other.map(o => row(esc(o.type.toLowerCase().replace(/_/g, ' ')), ovUsd(o.amount), ovTone(o.amount))).join('')}
      ${row(`wallet at the last sync, ${synced}`, fmtUsd(l.wallet), '', 'rule')}
      ${l.sinceSync == null ? '' : row('since then, not yet in the ledger', ovUsd(l.sinceSync), ovTone(l.sinceSync))}
    </div>
    <p class="gl-n">Checks: ${l.checks.map(ledgerCheckText).join(' · ')}</p>`,
    `Dollar assets only, from the Binance ledger.${note}`);
}

function renderCostsTab() {
  const c = perfData.costs;
  const note = perfData.session ? `<p class="jr-session-note">${esc(perfData.session)} trips only, except the wallet ledger.</p>` : '';
  const trades = c.summary.trips ? `${costsHeadline(c)}${feeCheckLine(c)}
    ${jrSection('Costs by week', weeklyCostsHtml(c.weekly))}
    ${jrSection('Fees by symbol', symbolCostBars(c.bySymbol.fees, -1))}
    ${jrSection('Funding paid by symbol', symbolCostBars(c.bySymbol.paid, -1))}
    ${jrSection('Funding received by symbol', symbolCostBars(c.bySymbol.received, 1))}` : '<p class="gl-n">No trips in this window.</p>';
  return `${note}${walletLedgerSection()}${trades}`;
}
