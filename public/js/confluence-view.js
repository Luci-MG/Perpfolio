// confluence-view.js — the Confluence tab (the scoring engine is confluence.js on the server).

// ── Confluence ───────────────────────────────────────────────────────────────
// Independent signals for one coin, per timeframe, each shown next to its own track record.
const CF_ALL_TFS = ['15m', '1h', '4h', '1d'];
let cfData = null, cfLoading = false, cfSymbols = null;
let cfSymbol = (s => /^[A-Z0-9]{2,30}$/.test(s) ? s : 'BTCUSDT')(String(loadPref('cfSymbol', 'BTCUSDT')));
let cfTfs = (t => Array.isArray(t) && t.length && t.every(x => CF_ALL_TFS.includes(x)) ? t : [...CF_ALL_TFS])(loadPref('cfTfs', null));
let cfSeq = 0, cfQuery = null;

async function fetchConfluence() {
  const seq = ++cfSeq;
  cfLoading = true;
  if (posView === 'confluence') rerenderStress();
  if (!cfSymbols) {
    fetch('/api/symbols').then(r => r.json()).then(d => {
      if (!d.ok) return;
      cfSymbols = d.symbols;
      const list = document.getElementById('cf-sym-list');
      if (list) list.innerHTML = cfSymbolOptions();
    }).catch(() => {});
  }
  const query = `symbol=${encodeURIComponent(cfSymbol)}&tfs=${cfTfs.join(',')}${sessionParam() ? `&${sessionParam()}` : ''}`;
  try {
    const res = await fetch(`/api/confluence?${query}`);
    if (!(res.headers.get('content-type') || '').includes('json')) {
      throw new Error(`server returned ${res.status} without JSON — restart it so it picks up /api/confluence`);
    }
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'confluence failed');
    if (seq !== cfSeq) return;
    cfData = data;
    cfQuery = query;
    clearLoadError('cf');
  } catch (err) {
    if (seq !== cfSeq) return;
    noteLoadError('cf', err);
    if (query !== cfQuery) cfData = null;
  } finally {
    if (seq === cfSeq) {
      cfLoading = false;
      if (posView === 'confluence') rerenderStress();
    }
  }
}

function updateConfluenceAge() {
  const el = document.getElementById('cf-age');
  if (el && cfData?.lastUpdated) el.textContent = `updated ${cfAge(cfData.lastUpdated)}`;
}

function setCfSymbol(v) {
  const s = String(v || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,30}$/.test(s) || s === cfSymbol) return;
  cfSymbol = s;
  savePref('cfSymbol', cfSymbol);
  fetchConfluence();
}

function toggleCfTf(tf) {
  if (cfTfs.includes(tf) && cfTfs.length === 1) return;
  cfTfs = cfTfs.includes(tf) ? cfTfs.filter(t => t !== tf) : CF_ALL_TFS.filter(t => t === tf || cfTfs.includes(t));
  savePref('cfTfs', cfTfs);
  fetchConfluence();
}

function cfHeldSymbols() {
  return [...new Set((lastData?.binance?.positions || []).map(p => p.symbol).filter(Boolean))].sort();
}

function cfSymbolOptions() {
  return (cfSymbols || []).map(s => `<option value="${esc(s.symbol)}"></option>`).join('');
}

function cfFmtValue(v, unit) {
  if (v == null || !isFinite(v)) return '—';
  if (unit === 'pct') return `${v >= 0 ? '+' : '−'}${fmt(Math.abs(v), 2)}%`;
  if (unit === 'z') return `z ${v >= 0 ? '+' : '−'}${fmt(Math.abs(v), 2)}`;
  if (unit === 'ratio') return fmt(v, 2);
  return fmt(v, Math.abs(v) >= 10 ? 1 : 2);
}

function cfSigned(v, d = 2) {
  return v == null ? '—' : `${v >= 0 ? '+' : '−'}${fmt(Math.abs(v), d)}`;
}

// Shape carries the sign so the read survives any colour perception; colour only reinforces.
function cfGlyph(state) {
  if (state === 'bull') return `<span class="cf-g up">▲</span>`;
  if (state === 'bear') return `<span class="cf-g dn">▼</span>`;
  if (state === 'gated') return `<span class="cf-g off">off</span>`;
  if (state === 'n/a') return `<span class="cf-g off">n/a</span>`;
  return `<span class="cf-g nt">–</span>`;
}

function cfBar(score) {
  if (score == null) return `<span class="jr-bar-track"><span class="jr-bar-mid" style="left:50%"></span></span>`;
  const w = Math.min(1, Math.abs(score)) * 50, pos = score >= 0;
  return `<span class="jr-bar-track">
    <span class="jr-bar-mid" style="left:50%"></span>
    <span class="jr-bar-fill" style="${pos ? 'left:50%' : 'right:50%'};width:${w.toFixed(2)}%;
      background:${pos ? 'var(--success)' : 'var(--danger)'};opacity:.8"></span>
  </span>`;
}

// Significance is judged on the effective sample (overlapping forward windows share bars),
// so ✓ appears only when the 95% interval clears what chance alone would score.
function cfHit(h) {
  if (!h || !h.n) return `<span class="cf-hit thin">no active history</span>`;
  const edge = h.edge == null ? '' : ` · ${h.edge >= 0 ? '+' : '−'}${fmt(Math.abs(h.edge) * 100, 1)}pt`;
  const ci = h.ci ? `95% ${fmt(h.ci[0] * 100, 0)}–${fmt(h.ci[1] * 100, 0)}% vs ${fmt(h.expected * 100, 0)}% by chance` : '';
  const mark = h.significant ? (h.edge > 0 ? ' ✓' : ' ✗') : '';
  return `<span class="cf-hit${h.thin ? ' thin' : ''}${h.significant ? ' sig' : ''}" title="${esc(`${ci} · ${h.n} readings ≈ ${h.nEff} independent`)}">${fmt(h.hitRate * 100, 0)}% · n≈${h.nEff}${h.thin ? '⚠' : ''}${edge}${mark}</span>`;
}

let cfShowAll = loadPref('cfShowAll', false);

function toggleCfDetail() {
  cfShowAll = !cfShowAll;
  savePref('cfShowAll', cfShowAll);
  rerenderStress();
}

const CF_REGIME_PLURAL = { trend: 'trends', range: 'ranges', transition: 'transitions', squeeze: 'squeezes', unknown: 'unclassified bars' };
const CF_LEAN = { 1: ['▲', 'Leaning long', 'up'], '-1': ['▼', 'Leaning short', 'dn'], 0: ['–', 'No clear lean', ''] };
function cfStabilityText(trust) {
  if (trust.stability === 'thin') return 'too few recent bars to say whether this holds';
  if (trust.stability === 'fades') return 'it changed direction in the most recent 30% of bars';
  return trust.record?.edge > 0
    ? 'it held up in the most recent 30% of bars'
    : 'it ran below chance in both the earlier and the recent bars, so the lean has not been a reliable guide here';
}

function cfRecordText(rec) {
  if (!rec || rec.hitRate == null) return '<span class="cf-hit thin">no active history</span>';
  const where = rec.scope === 'regime' ? `in ${CF_REGIME_PLURAL[rec.regime] ?? rec.regime}`
    : `overall — too few in ${CF_REGIME_PLURAL[rec.regime] ?? rec.regime}`;
  const mark = rec.significant ? (rec.edge > 0 ? ' ✓' : ' ✗') : '';
  return `<span class="cf-hit${rec.thin ? ' thin' : ''}${rec.significant ? ' sig' : ''}">${fmt(rec.hitRate * 100, 0)}% vs ${fmt(rec.expected * 100, 0)}% by chance ${where}, n≈${rec.nEff}${rec.thin ? '⚠' : ''}${mark}</span>`;
}

const cfStateOf = score => (score >= 0.25 ? 'bull' : score <= -0.25 ? 'bear' : 'neutral');

function cfReasonLine(r) {
  return `<div class="cf-v-line">${cfGlyph(cfStateOf(r.score))} <b>${esc(r.name)}</b> <span class="cf-v-tf">${r.tf}</span> ${cfRecordText(r.record)}</div>`;
}

function cfSessionText(t) {
  if (!t.tf) return 'Only 4h and 1d are selected, and their bars span several sessions — add 1h or 15m to see this session.';
  if (!t.record || t.record.hitRate == null) return `No composite readings on ${t.tf} bars closing in this session yet.`;
  const r = t.record;
  const mark = r.significant ? (r.edge > 0 ? ' ✓' : ' ✗') : '';
  return `Composite on ${t.tf} bars closing in this session: <span class="cf-hit${r.thin ? ' thin' : ''}">${fmt(r.hitRate * 100, 0)}% vs ${fmt(r.expected * 100, 0)}% by chance, n≈${r.nEff}${r.thin ? '⚠' : ''}${mark}</span>`;
}

function renderCfVerdict(d) {
  const v = d.verdict;
  if (!v) return '';
  const [glyph, lean, cls] = CF_LEAN[v.direction];
  const meta = [v.aligned == null ? null : v.aligned ? '1h · 4h · 1d aligned' : 'timeframes not aligned',
    v.trust ? `regime on ${v.trust.tf}: ${v.trust.regime}` : null].filter(Boolean).join(' · ');
  const trust = v.trust
    ? `Composite on ${v.trust.tf} ${cfRecordText(v.trust.record)} — ${cfStabilityText(v.trust)}.`
    : 'No timeframe to judge it on.';
  return `<div class="cf-verdict">
    <div class="cf-v-head">
      <span class="cf-v-lean ${cls}">${glyph} ${lean}</span>
      <span class="cf-v-strength">${v.direction ? `${v.strength} · ` : ''}${cfSigned(v.score)}</span>
      <span class="cf-v-meta">${jrSym(d.symbol)} · ${meta}</span>
    </div>
    <div class="cf-v-row"><span class="k">${v.direction ? 'Why' : 'Strongest pulls'}</span><div>${v.reasons.map(cfReasonLine).join('') || '—'}</div></div>
    ${v.against ? `<div class="cf-v-row"><span class="k">Against</span><div>${cfReasonLine(v.against)}</div></div>` : ''}
    <div class="cf-v-row"><span class="k">Can you trust it?</span><div class="cf-v-line">${trust}</div></div>
    ${v.sessionTrust ? `<div class="cf-v-row"><span class="k">In ${esc(v.sessionTrust.session)}</span><div class="cf-v-line">${cfSessionText(v.sessionTrust)}</div></div>` : ''}
  </div>`;
}

function cfAge(iso) {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`;
}

function renderConfluence() {
  const held = cfHeldSymbols();
  const quick = ['BTCUSDT', ...held.filter(s => s !== 'BTCUSDT')].slice(0, 10);
  const controls = `<div class="jr-sync" id="cf-mounted">
    <input class="cf-sym" list="cf-sym-list" value="${esc(cfSymbol)}" spellcheck="false" aria-label="Symbol"
      onchange="setCfSymbol(this.value)" onkeydown="if(event.key==='Enter')setCfSymbol(this.value)">
    <datalist id="cf-sym-list">${cfSymbolOptions()}</datalist>
    ${quick.map(s => `<button class="st-btn${s === cfSymbol ? ' on' : ''}" onclick="setCfSymbol('${s}')"
      title="${held.includes(s) ? 'open position' : ''}">${jrSym(s)}${held.includes(s) ? ' •' : ''}</button>`).join('')}
    <span class="st-sep"></span>
    ${CF_ALL_TFS.map(tf => `<button class="st-btn${cfTfs.includes(tf) ? ' on' : ''}" onclick="toggleCfTf('${tf}')">${tf}</button>`).join('')}
    <span class="st-sep"></span>
    <span class="st-sep"></span>
    ${sessionSelectHtml()}
    <button class="st-btn" onclick="fetchConfluence()">${cfLoading ? 'Loading…' : 'Refresh'}</button>
    <span id="cf-age">${cfData?.lastUpdated ? `updated ${cfAge(cfData.lastUpdated)}` : ''}</span>
  </div>`;

  if (!cfData) {
    return `${controls}${loadErrors.cf ? loadErrorHtml('cf', 'fetchConfluence()', false)
      : '<p style="font-size:12px;color:var(--text3);padding:14px 0">Loading confluences…</p>'}`;
  }
  const stale = loadErrorHtml('cf', 'fetchConfluence()', true);

  const d = cfData;
  const tfs = CF_ALL_TFS.filter(tf => d.timeframes[tf] !== undefined);
  const live = tfs.filter(tf => d.timeframes[tf]);
  const o = d.overall;

  const intro = `<p class="jr-intro">Each row is an independent reading of <b>${jrSym(d.symbol)}</b> on closed bars.
    Signals in the same <b>source</b> share one vote, so correlated indicators cannot stack. ADX sets the
    <b>regime</b>: in a trend, mean reversion is switched off; in a range, trend signals count half.
    Under each reading is its <b>track record</b> on this coin and timeframe: how often a ▲ or ▼ reading
    pointed the right way ${d.timeframes[live[0]]?.calibration?.horizon ?? 6} bars later, the effective number of
    independent samples (<i>n≈</i> — overlapping windows share bars), and the <b>edge</b> in points over a
    coin-flip with the same long/short mix. <b>✓</b> or <b>✗</b> appears only when the 95% interval clears chance
    in that direction; with 48 signal × timeframe cells, two or three will do so by luck alone. No mark
    means the signal has not shown it predicts this market — treat it as context, not a forecast.</p>`;

  const overall = `<div class="cf-head">
    <div class="jr-stat cf-overall">
      <div class="k">Overall · ${jrSym(d.symbol)}</div>
      <div class="v ${o.score > 0 ? 'up' : o.score < 0 ? 'dn' : ''}">${cfSigned(o.score)} <span class="cf-state">${o.state}</span></div>
      ${cfBar(o.score)}
      <div class="s">${o.aligned == null ? 'alignment needs 1h, 4h and 1d'
        : o.aligned ? '1h, 4h and 1d aligned' : 'timeframes not aligned'}
        · weights ${Object.entries(d.tfWeights).map(([tf, w]) => `${tf} ${Math.round(w * 100)}%`).join(' ')}</div>
    </div>
    ${tfs.map(tf => {
      const r = d.timeframes[tf];
      if (!r) return `<div class="jr-stat"><div class="k">${tf}</div><div class="v">—</div><div class="s">no data</div></div>`;
      const c = r.counts, sc = r.calibration.composite;
      const warn = [
        r.regime.squeeze ? `<span class="badge b-warn" title="Bandwidth in the bottom 10% of 120 bars">squeeze: breakout pending</span>` : '',
        r.crowded ? `<span class="badge b-warn" title="Funding/basis z beyond ±2 capped the score">crowded ${r.crowded}</span>` : '',
        r.btc?.discounted ? `<span class="badge b-warn" title="Disagrees with BTC (${cfSigned(r.btc.score)}) at correlation ${fmt(r.btc.corr, 2)}; score halved from ${cfSigned(r.btc.rawScore)}">BTC disagrees</span>` : ''
      ].join('');
      return `<div class="jr-stat">
        <div class="k">${tf} · ${r.regime.label}${r.regime.adx != null ? ` · ADX ${fmt(r.regime.adx, 0)}` : ''}</div>
        <div class="v ${r.score > 0 ? 'up' : r.score < 0 ? 'dn' : ''}">${cfSigned(r.score)}</div>
        ${cfBar(r.score)}
        <div class="s">${c.bull} bull · ${c.bear} bear · ${c.neutral} neutral${c.na ? ` · ${c.na} n/a` : ''}</div>
        <div class="s" title="Composite: hit rate when |score| ≥ 0.3, against a coin-flip with the same long/short mix">composite ${cfHit(sc)}</div>
        ${warn ? `<div class="cf-warn">${warn}</div>` : ''}
      </div>`;
    }).join('')}
  </div>`;

  const head = `<tr><th>signal</th>${tfs.map(tf => `<th>${tf}</th>`).join('')}</tr>`;
  const body = d.sources.map(src => {
    const srcRow = `<tr class="cf-src"><td>${src.name} <span class="cf-w">${Math.round(src.weight * 100)}%</span></td>
      ${tfs.map(tf => {
        const s = d.timeframes[tf]?.sources.find(x => x.id === src.id);
        if (!s) return '<td>—</td>';
        const note = s.informational ? 'shown, not scored' : s.weight === 0 ? 'off in this regime' : `weight ${Math.round(s.weight * 100)}%`;
        return `<td class="${s.informational || s.weight === 0 ? 'cf-dim' : ''}" title="${note}">
          ${cfGlyph(s.state)} <span class="cf-num">${cfSigned(s.score)}</span>
          ${s.informational ? '<span class="cf-hit">info only</span>' : s.weight === 0 ? '<span class="cf-hit">off</span>' : ''}</td>`;
      }).join('')}</tr>`;
    const rows = d.timeframes[live[0]]?.signals.filter(s => s.source === src.id).map(sig => `<tr>
      <td class="cf-name">${sig.name}</td>
      ${tfs.map(tf => {
        const s = d.timeframes[tf]?.signals.find(x => x.id === sig.id);
        if (!s) return '<td>—</td>';
        const tip = [s.note, s.reason, s.value != null ? `value ${cfFmtValue(s.value, s.unit)}` : '',
          s.raw != null ? `would read ${cfSigned(s.raw)}` : '',
          s.hit?.n ? `expected ${fmt(s.hit.expected * 100, 0)}% by chance` : ''].filter(Boolean).join(' · ');
        return `<td title="${esc(tip)}" class="${s.state === 'n/a' || s.state === 'gated' ? 'cf-dim' : ''}">
          <div>${cfGlyph(s.state)} <span class="cf-num">${cfFmtValue(s.value, s.unit)}</span></div>
          <div class="cf-note">${s.note || s.reason || ''}</div>
          ${cfHit(s.hit)}</td>`;
      }).join('')}</tr>`).join('') || '';
    return srcRow + rows;
  }).join('');

  const gaps = d.dataGaps.length
    ? `<p class="cf-foot" style="color:var(--warning)">Missing from Binance: ${d.dataGaps.join(' · ')}. Those signals read n/a and drop out of the weights rather than counting as neutral.</p>`
    : '';
  const cal = d.timeframes[live[0]]?.calibration;
  const foot = `${gaps}<p class="cf-foot">
    Last price, closed bars only${live.length ? ` · last ${live.map(tf => `${tf} bar closed ${new Date(d.timeframes[tf].lastClosedAt + 1).toISOString().slice(5, 16).replace('T', ' ')}`).join(', ')} UTC` : ''}.
    Track records replay up to ${fmt(d.timeframes[live[0]]?.bars ?? 0, 0)} bars per timeframe; the forward windows overlap, so <i>n</i> overstates the
    number of independent samples, so the interval uses n ÷ horizon, and ⚠ marks fewer than 30 of those. Open interest, long/short and basis history is capped at 30 days
    by Binance, so their samples are short, and on 1d they are shown but not scored.
    Funding settles every ${d.fundingIntervalHours}h; last ${d.lastFundingRate == null ? '—' : `${cfSigned(d.lastFundingRate * 100, 4)}%`}.
    ${d.symbol !== 'BTCUSDT' ? 'For alts, a timeframe that disagrees with a clear BTC reading at correlation above 0.7 is halved.' : ''}
    ${cal ? `Up-bar share over the replay on ${live[0]}: ${fmt(cal.baseUp * 100, 0)}%.` : ''}</p>`;

  const toggle = `<button class="st-btn cf-detail-toggle" onclick="toggleCfDetail()">${cfShowAll ? 'Hide all signals' : 'Show all signals'}</button>`;
  return `${controls}${stale}${renderCfVerdict(d)}${overall}${toggle}
    ${cfShowAll ? `${intro}<div class="cf-table-wrap"><table class="cf-table">${head}${body}</table></div>` : ''}${foot}`;
}
