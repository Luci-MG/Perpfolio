// stops.js — the Stops tab: volatility-adjusted stop width and size per position.

// ── Dynamic Stop Width view ───────────────────────────────────────────────
const REGIME_META = {
  low:     { label: 'Low',     color: 'var(--success)' },
  medium:  { label: 'Medium',  color: 'var(--text2)'   },
  high:    { label: 'High',    color: 'var(--warning)' },
  extreme: { label: 'Extreme', color: 'var(--danger)'  }
};

const STOP_VERDICT = {
  none:   { label: 'No stop',      color: 'var(--danger)' },
  hedged: { label: 'Hedged',       color: 'var(--text3)' },
  tight:  { label: 'Too tight',    color: 'var(--warning)' },
  wide:   { label: 'Too wide',     color: 'var(--warning)' },
  breakeven: { label: 'Breakeven', color: 'var(--success)' },
  locks:  { label: 'Locks profit', color: 'var(--success)' },
  ok:     { label: 'OK',           color: 'var(--success)' }
};

function stopVerdictPill(verdict) {
  const m = STOP_VERDICT[verdict];
  return m ? `<span class="regime-badge" style="background:${m.color}20;color:${m.color};border:1px solid ${m.color}55">${m.label}</span>` : '';
}

function yourStopHtml(p) {
  const s = p.yourStop;
  if (!s) {
    const why = p.verdict === 'unknown' ? 'stop orders could not be read; checked again on the next refresh'
      : p.verdict === 'hedged' ? 'no stop order — the opposite leg is open' : 'no stop order on this leg';
    return `<div class="vt-yours"><div class="vt-yours-head"><span class="vt-k">Your stop</span>${stopVerdictPill(p.verdict)}</div>
      <div class="vt-k">${why}</div></div>`;
  }
  const facts = [`${fmt(s.distancePct, 2)}% from mark`,
    s.atrMultiple != null ? `${fmt(s.atrMultiple, 1)} ATR` : null,
    p.verdict === 'breakeven' ? 'at entry' : p.verdict === 'locks' ? `locks +${fmt(p.lockedPct, 2)}%`
      : p.ratio != null ? `${fmt(p.ratio, 2)}× suggested` : null].filter(Boolean);
  const hit = s.hit
    ? `<div class="vt-k" title="${s.hit.windows} overlapping 24h windows, about ${s.hit.independent} independent">hit within 24h in ${fmt(s.hit.rate * 100, 0)}% of windows, last ${fmt(s.hit.days, 1)} days</div>`
    : '';
  return `<div class="vt-yours">
    <div class="vt-yours-head"><span class="vt-k">Your stop</span>${stopVerdictPill(p.verdict)}</div>
    <div class="vt-yours-val">${fmtPrice(s.price)} <span>${facts.join(' · ')}</span></div>
    ${hit}
  </div>`;
}

function stopVerdictSummary(positions) {
  const count = v => positions.filter(p => p.verdict === v).length;
  const parts = [[count('unknown'), 'stop unknown'], [count('none'), 'without a stop'], [count('tight'), 'too tight'], [count('wide'), 'too wide']]
    .filter(([n]) => n).map(([n, l]) => `${n} ${l}`);
  return parts.length ? parts.join(' · ') : 'every leg covered';
}

function regimeBadge(r) {
  const m = REGIME_META[r] || REGIME_META.medium;
  return `<span class="regime-badge" style="background:${m.color}20;color:${m.color};border:1px solid ${m.color}55">${m.label}</span>`;
}

function volControlsHtml() {
  return `<div class="vol-controls" id="vs-mounted">
    <label>Risk %
      <input type="number" step="0.1" min="0.1" max="50" value="${volRiskPct}"
        onchange="setVolRisk(this.value)" />
    </label>
    <label>k (stop mult)
      <input type="number" step="0.1" min="0.1" max="10" value="${volK}"
        onchange="setVolK(this.value)" />
    </label>
  </div>`;
}

function renderVolStops() {
  if (volLoading && !volStopData) {
    return `<p style="font-size:12px;color:var(--text3);padding:14px 0">Computing volatility-adjusted stops…</p>`;
  }
  if (!volStopData) {
    return loadErrors.vol ? `${volControlsHtml()}${loadErrorHtml('vol', 'fetchVolStops()', false)}`
      : `<p style="font-size:12px;color:var(--text3);padding:14px 0">No stop data yet.</p>`;
  }

  // Apply the same HL/BN exchange filter used elsewhere.
  const all = volStopData.positions || [];
  const positions = all.filter(p => exchFilter.has(p.exchange));

  const combined = renderVolCombined(volStopData.combined, positions);
  const controls = volControlsHtml() + loadErrorHtml('vol', 'fetchVolStops()', true);

  if (!positions.length) {
    return `${controls}${combined}<p style="font-size:12px;color:var(--text3);padding:14px 0">No open positions for selected exchanges.</p>`;
  }

  const tiles = positions.map(renderVolTile).join('');
  const sessionNote = sessionFilter === 'All' ? ''
    : `<p class="jr-session-note">The ${esc(sessionFilter)} filter does not apply here: each hit rate counts 24h windows, which cover every session.</p>`;
  return `${controls}${combined}${sessionNote}<div class="vol-tile-grid">${tiles}</div>`;
}

function renderVolCombined(c, positions) {
  if (!c) return '';
  const m = REGIME_META[c.portfolioRegime] || REGIME_META.medium;

  // Totals are recomputed from the filtered positions; the server's figures cover every
  // venue and would disagree with the tiles below whenever a venue is filtered out.
  const shown = positions || [];
  const dollarRisk = shown.reduce((s, p) => s + (p.dollarRisk || 0), 0);
  const equity = (exchFilter.has('hyperliquid') ? (c.hlEquity || 0) : 0)
               + (exchFilter.has('binance')     ? (c.bnEquity || 0) : 0);
  const rc = { low: 0, medium: 0, high: 0, extreme: 0 };
  shown.forEach(p => { if (rc[p.regimeLabel] != null) rc[p.regimeLabel]++; });
  const distSegments = ['low','medium','high','extreme'].map(r => {
    const n = rc[r] || 0;
    if (!n) return '';
    const col = REGIME_META[r].color;
    return `<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--text2)">
      <span style="width:8px;height:8px;border-radius:2px;background:${col};display:inline-block"></span>${REGIME_META[r].label} ${n}</span>`;
  }).join('');

  const warnings = (c.hedgeWarnings || []).map(w =>
    `<div class="vol-warn">⚠ ${w.asset}: ${w.warning}</div>`
  ).join('');

  return `<div class="vol-combined" style="border-left:3px solid ${m.color}">
    <div class="vol-combined-row">
      <div class="vol-combined-cell">
        <div class="vc-label">Portfolio regime</div>
        <div class="vc-val">${regimeBadge(c.portfolioRegime)}</div>
      </div>
      <div class="vol-combined-cell">
        <div class="vc-label">Portfolio vol</div>
        <div class="vc-val">${fmt(c.portfolioVolPct, 2)}%</div>
        ${c.regimeBasis?.percentile != null
          ? `<div style="font-size:10px;color:var(--text3)">above ${fmt(c.regimeBasis.percentile, 0)}% of its last ${c.regimeBasis.bars} bars</div>`
          : `<div style="font-size:10px;color:var(--text3)">no history yet</div>`}
      </div>
      <div class="vol-combined-cell">
        <div class="vc-label">Total $ risk</div>
        <div class="vc-val">${fmtUsd(dollarRisk)}</div>
      </div>
      <div class="vol-combined-cell">
        <div class="vc-label">Account equity</div>
        <div class="vc-val">${fmtUsd(equity)}</div>
      </div>
      <div class="vol-combined-cell">
        <div class="vc-label">Your stops</div>
        <div class="vc-val">${stopVerdictSummary(shown)}</div>
      </div>
      <div class="vol-combined-cell" style="flex:2">
        <div class="vc-label">Regime spread</div>
        <div class="vc-val" style="display:flex;gap:12px;flex-wrap:wrap">${distSegments || '<span style="color:var(--text3)">—</span>'}</div>
      </div>
    </div>
    ${warnings ? `<div class="vol-warn-wrap">${warnings}</div>` : ''}
    ${renderHedgeHealth(c)}
  </div>`;
}

const HEDGE_STATUS = {
  intact:    { label: 'intact',    color: 'var(--success)' },
  degrading: { label: 'decaying',  color: 'var(--warning)' },
  broken:    { label: 'broken',    color: 'var(--danger)'  },
  thin:      { label: 'thin data', color: 'var(--text3)'   },
  unknown:   { label: 'no data',   color: 'var(--text3)'   }
};

// Correlation risk sits between assets, so the book is netted per asset first: the two
// legs of a same-symbol hedge collapse into one delta (they cannot decorrelate from
// themselves) and what is left is the real hedge structure. Legs are then matched into a
// partition in BTC-equivalent terms, so each dollar is hedged once and the leftover is
// the book's naked exposure.
function renderHedgeHealth(c) {
  if (!c) return '';
  const pairs = c.hedgePairs || [];
  const naked = c.nakedBtcEquiv ?? 0;

  const rows = pairs.map(h => {
    const st = HEDGE_STATUS[h.status] || HEDGE_STATUS.unknown;
    if (h.status === 'unknown') {
      return `<tr><td colspan="5" style="color:var(--text3)">${h.longAsset} / ${h.shortAsset} — ${h.warning}</td></tr>`;
    }
    const decayed = h.corrRecent < h.corrBaseline - 0.05;
    return `<tr>
      <td><b>${h.longAsset}</b> long / <b>${h.shortAsset}</b> short</td>
      <td class="num" title="Correlation of hourly returns over the last 72h">
        ${fmt(h.corrRecent, 2)}<span style="color:var(--text3)"> ${decayed ? '↓' : ''}${fmt(h.corrBaseline, 2)}</span></td>
      <td class="num" title="Beta of the short leg against the long leg">β ${fmt(h.beta, 2)}</td>
      <td class="num" title="Exposure this pair actually offsets, in BTC-equivalent terms">${fmtUsd(h.matchedBtcEquiv)}</td>
      <td class="num"><span class="hedge-status" style="background:${st.color}22;color:${st.color}">${st.label}</span></td>
    </tr>`;
  }).join('');

  const netted = (c.nettedSymbols || []).map(n =>
    `${n.asset} ${n.netDelta >= 0 ? '+' : '−'}${fmtUsd(Math.abs(n.netDelta))}`).join(' · ');

  const side = v => Math.abs(v) < 1 ? 'flat' : `${v > 0 ? 'long' : 'short'} ${fmtUsd(Math.abs(v))}`;
  const nakedCol = Math.abs(naked) < 500 ? 'var(--success)'
                 : Math.abs(naked) > Math.abs(c.betaAdjustedNet || 0) * 0.5 ? 'var(--warning)' : 'var(--text)';

  return `<div class="hedge-wrap">
    <div class="hedge-head">
      <span>Hedge structure <span style="text-transform:none;letter-spacing:0;color:var(--text3)">· whole book, ignores the venue filter</span></span>
      <span style="text-transform:none;letter-spacing:0">pairing inferred by size — correlation 72h vs 20d</span>
    </div>
    ${pairs.length
      ? `<table class="hedge-tbl">${rows}</table>`
      : `<div style="font-size:11px;color:var(--text3)">No cross-asset hedge detected — the book is directional.</div>`}
    <div class="hedge-naked">
      <span><span class="k">naked after pairing</span>
        <b style="color:${nakedCol}"> ${side(naked)}</b>
        <span class="k">BTC-equivalent</span></span>
      <span><span class="k">raw net</span> ${side(c.rawNet ?? 0)}</span>
    </div>
    ${netted ? `<div class="hedge-netted">Same-symbol legs netted first (no correlation exposure): ${netted}</div>` : ''}
  </div>`;
}

function renderVolTile(p) {
  const exchColor = p.exchange === 'hyperliquid' ? 'var(--hl)' : 'var(--bn)';
  const exchLabel = p.exchange === 'hyperliquid' ? 'HL' : 'BN';

  if (p.error) {
    return `<div class="vol-tile">
      <div class="vt-head"><span class="pair">${p.pair}</span>
        <span style="font-size:9px;font-weight:600;color:${exchColor}">${exchLabel}</span></div>
      <div style="font-size:11px;color:var(--danger);padding:8px 0">Failed: ${esc(p.error)}</div>
    </div>`;
  }

  const m = REGIME_META[p.regimeLabel] || REGIME_META.medium;
  // Stop-distance bar: scale 0–10% across the bar width, capped.
  const barPct = Math.max(0, Math.min(100, (p.stopDistPct / 10) * 100));
  const estimated = (p.backfilled && p.backfilled.length)
    ? `<span class="vt-est" title="Estimated from: ${p.backfilled.join(', ')}">est</span>` : '';

  const layerBadge = (label, val, neutral = 1) => {
    const elevated = val > neutral + 0.001;
    const col = elevated ? 'var(--warning)' : 'var(--text3)';
    return `<span class="vt-layer" style="color:${col}">${label} ${fmt(val, 2)}×</span>`;
  };

  return `<div class="vol-tile" style="border-top:2px solid ${m.color}">
    <div class="vt-head">
      <span style="display:flex;align-items:center;gap:6px">
        <span class="pair">${p.pair}</span>
        <span style="font-size:9px;font-weight:600;color:${exchColor}">${exchLabel}</span>
        ${sideBadge(p.side)}
        ${estimated}
      </span>
      ${regimeBadge(p.regimeLabel)}
    </div>

    <div class="vt-stopbar-wrap" title="Stop distance ${fmt(p.stopDistPct,2)}%">
      <div class="vt-stopbar" style="width:${barPct}%;background:${m.color}"></div>
    </div>
    <div class="vt-stopline">
      <span>Suggested stop dist</span><span style="font-weight:600">${fmt(p.stopDistPct, 2)}%</span>
    </div>
    ${yourStopHtml(p)}

    <div class="vt-grid">
      <div><div class="vt-k">Entry</div><div class="vt-v">${fmtPrice(p.entry)}</div></div>
      <div><div class="vt-k">Mark</div><div class="vt-v">${fmtPrice(p.mark)}</div></div>
      <div><div class="vt-k">Stop price</div><div class="vt-v" style="color:var(--danger)">${fmtPrice(p.stopPrice)}</div></div>
      <div><div class="vt-k">Target (2R)</div><div class="vt-v" style="color:var(--success)">${fmtPrice(p.targetPrice)}</div></div>
      <div><div class="vt-k">Position size</div><div class="vt-v">${fmt(p.positionSize, 4)}</div></div>
      <div><div class="vt-k">Notional</div><div class="vt-v">${fmtUsd(p.notionalValue)}</div></div>
      <div><div class="vt-k">$ risk</div><div class="vt-v">${fmtUsd(p.dollarRisk)}</div></div>
      <div><div class="vt-k">Composite vol</div><div class="vt-v">${fmt(p.compositeVolPct, 2)}%</div></div>
    </div>

    <div class="vt-layers">
      <span class="vt-layer" style="color:var(--text3)">ATR ${fmt(p.layers.atrPct, 2)}%</span>
      ${layerBadge('BBW', p.layers.bbwAdj)}
      ${layerBadge('Fund', p.layers.fundingAdj)}
      ${layerBadge('Cross', p.layers.crossAdj)}
      <span class="vt-layer" style="color:var(--text3)">×${p.regimeMult}</span>
    </div>
  </div>`;
}
