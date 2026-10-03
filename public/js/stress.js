// stress.js — the Stress tab: cross-pool what-if, patched in place on every slider frame.

// ── Cross-pool stress simulator ───────────────────────────────────────────
// Every number in this panel is computed in the browser by /risk-engine.js — the
// same module the API uses — so dragging a price costs no round-trip.
let riskBook       = null;
let riskEngine     = null;
let riskLoading    = false;
let riskShift      = {};      // asset → % move applied to its mark
let riskLink       = {};      // asset → moves with the beta chain
let riskBeta       = {};      // asset → beta vs BTC
let riskRange      = 30;      // slider half-range, %
let riskRangeExplicit = false;   // set once the user picks a range themselves
let riskHonorStops = false;
let riskStressCorr = false;
let riskFrame      = null;
let riskForceRender = false;

function rerenderStress() {
  riskForceRender = true;
  if (lastData) render(lastData);
}

const RANGE_TIERS = [30, 50, 80, 120];

async function fetchRiskBook(fresh = false) {
  riskLoading = true;
  if (posView === 'stress') rerenderStress();
  try {
    if (!riskEngine) riskEngine = await import('/risk-engine.js');
    const res  = await fetch(`/api/riskbook${fresh ? '?fresh=1' : ''}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'riskbook failed');
    riskBook = data;
    clearLoadError('risk');
    // Shifts are held as percentages, so a refreshed book keeps the scenario intact
    // even though every mark has moved underneath it.
    const live = new Set(data.pools.flatMap(P => Object.keys(P.marks)));
    Object.keys(riskShift).forEach(a => {
      if (!live.has(a)) { delete riskShift[a]; delete riskLink[a]; delete riskBeta[a]; }
    });
    data.pools.forEach(P => Object.keys(P.marks).forEach(a => {
      if (riskShift[a] == null) riskShift[a] = 0;
      if (riskLink[a]  == null) riskLink[a]  = true;
      riskBeta[a] = P.stats[a]?.beta ?? 1;
    }));
    // the account's real taker rate replaces the guessed default, unless it was set by hand
    if (!uwFeeTouched) {
      const taker = Object.values(data.pools?.[0]?.fees || {})[0]?.taker;
      if (taker > 0) uwFee = +(taker * 100).toFixed(4);
    }
    if (!riskRangeExplicit) riskRange = rangeForNearestKill(data);
  } catch (err) {
    noteLoadError('risk', err);
  } finally {
    riskLoading = false;
    if (posView === 'stress') rerenderStress();
  }
}

function betaOf(asset) { return riskStressCorr ? 1 : (riskBeta[asset] ?? 1); }

function updateStressAge() {
  const el = document.getElementById('st-age');
  if (!el || !riskBook?.lastUpdated) return;
  const secs = Math.round((Date.now() - new Date(riskBook.lastUpdated).getTime()) / 1000);
  const label = secs < 60 ? `${secs}s ago` : `${Math.round(secs / 60)}m ago`;
  el.textContent = `marks from ${label}`;
  el.style.color = secs > 120 ? 'var(--warning)' : 'var(--text3)';
}

function rangeForNearestKill(book) {
  const kills = (book?.pools || []).flatMap(P => (P.baseline || []).flatMap(b =>
    [b.killUpPct, b.killDownPct].filter(v => v != null).map(Math.abs)));
  if (!kills.length) return 30;
  const nearest = Math.min(...kills);
  return RANGE_TIERS.find(t => t >= nearest * 1.15) || RANGE_TIERS[RANGE_TIERS.length - 1];
}

function netDeltaLabel(delta) {
  const d = parseFloat(delta);
  if (isNaN(d) || Math.abs(d) < 1) return 'flat in the pool';
  const cls = d > 0 ? 'up' : 'dn';
  return `net <span class="${cls}">${d > 0 ? 'long' : 'short'} ${fmtUsd(Math.abs(d))}</span>`;
}

function priceDecimals(mark) {
  return mark >= 1000 ? 2 : mark >= 10 ? 3 : mark >= 1 ? 4 : 6;
}

function stressPrices(P) {
  const out = {};
  for (const [asset, mark] of Object.entries(P.marks)) out[asset] = mark * (1 + (riskShift[asset] || 0) / 100);
  return out;
}

function stressState(P, prices) {
  const pool = riskHonorStops ? riskEngine.applyStops(P.pool, P.marks, prices).pool : P.pool;
  return riskEngine.evalPool(pool, prices, P.opts);
}

function stressOpts(P) { return { ...P.opts, honorStops: riskHonorStops }; }

// ── interaction ──────────────────────────────────────────────────────────

// Drive the slider from an absolute price instead of a percentage. Goes through
// setStressShift so the beta chain and the range auto-expand behave identically.
function setStressPrice(asset, value) {
  const mark = markOf(asset);
  const price = parseFloat(value);
  if (!(mark > 0) || !(price > 0)) { rerenderStress(); return; }
  setStressShift(asset, (price / mark - 1) * 100);
}

function markOf(asset) {
  for (const P of riskBook?.pools || []) if (P.marks[asset] != null) return P.marks[asset];
  return null;
}

function priceStep(mark) {
  return mark >= 10000 ? 10 : mark >= 1000 ? 1 : mark >= 100 ? 0.1 : mark >= 1 ? 0.01 : 0.0001;
}

function setStressShift(asset, pct) {
  const raw = parseFloat(pct);
  const v = isNaN(raw) ? 0 : raw;

  if (riskLink[asset]) {
    const driver = v / (betaOf(asset) || 1);
    Object.keys(riskShift).forEach(a => { if (riskLink[a]) riskShift[a] = driver * betaOf(a); });
  } else {
    riskShift[asset] = v;
  }
  afterStressChange();
}

function toggleStressLink(asset) {
  riskLink[asset] = !riskLink[asset];
  rerenderStress();
}

function setStressRange(v) {
  riskRange = parseFloat(v) || 30;
  riskRangeExplicit = true;
  rerenderStress();
}

function resetStress() {
  Object.keys(riskShift).forEach(a => { riskShift[a] = 0; });
  riskRangeExplicit = false;
  riskRange = rangeForNearestKill(riskBook);
  rerenderStress();
}

function toggleStressOpt(which) {
  if (which === 'stops') riskHonorStops = !riskHonorStops;
  if (which === 'corr')  riskStressCorr = !riskStressCorr;
  rerenderStress();
}

// Apply a named scenario at a chosen magnitude, in the driving asset's own terms.
function applyStressScenario(poolIdx, mode, sign, magnitude) {
  const P = riskBook.pools[poolIdx];
  const dir = riskEngine.scenarioDir(P.pool, mode, {
    betas: Object.fromEntries(Object.keys(riskBeta).map(a => [a, betaOf(a)])),
    sign, prices: P.marks
  });
  Object.entries(dir).forEach(([a, d]) => { riskShift[a] = d * magnitude; });
  afterStressChange(true);
}

// Snap every slider to the point where the pool dies under this scenario.
function snapToKill(poolIdx, mode, sign) {
  const P = riskBook.pools[poolIdx];
  const dir = riskEngine.scenarioDir(P.pool, mode, {
    betas: Object.fromEntries(Object.keys(riskBeta).map(a => [a, betaOf(a)])),
    sign, prices: P.marks
  });
  const r = riskEngine.scanRay(P.pool, P.marks, dir, stressOpts(P));
  if (r.breachLambda == null) return;
  Object.entries(dir).forEach(([a, d]) => { riskShift[a] = d * r.breachLambda * 100; });
  afterStressChange(true);
}

// Grow the visible range rather than let a slider thumb misreport the real shift.
// Only ever grows: recomputing the smallest tier that fits would silently discard a range
// the user picked, snapping ±50% back to ±30% on the next nudge of any slider. Shrinking
// is left to Reset, which restores the auto-fitted range.
function afterStressChange(forceRender = false) {
  const peak = Math.max(...Object.values(riskShift).map(v => Math.abs(v || 0)), 0);
  const needed = RANGE_TIERS.find(t => t >= peak) || RANGE_TIERS[RANGE_TIERS.length - 1];

  if (needed > riskRange) {
    riskRange = needed;
    rerenderStress();
    return;
  }
  if (forceRender) {
    rerenderStress();
    return;
  }
  scheduleStressUpdate();
}

function scheduleStressUpdate() {
  if (riskFrame) return;
  riskFrame = requestAnimationFrame(() => { riskFrame = null; updateStress(); });
}

// ── live patching ────────────────────────────────────────────────────────
// Deliberately does not call render() — that rebuilds the whole dashboard and the
// hedge-thread SVG on every pointer move.

function updateStress() {
  if (!riskBook?.pools || !riskEngine) return;

  riskBook.pools.forEach((P, i) => {
    const prices = stressPrices(P);
    const state  = stressState(P, prices);
    const opts   = stressOpts(P);

    const set = (id, text, cls) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = text;
      if (cls !== undefined) el.className = cls;
    };

    set(`st-eq-${i}`,  fmtUsd(state.equity));
    set(`st-mm-${i}`,  fmtUsd(state.mm));
    const buffer = Math.abs(state.buffer) < 0.005 ? 0 : state.buffer;
    set(`st-buf-${i}`, (buffer < 0 ? '−' : '') + fmtUsd(Math.abs(buffer)),
        'st-pool-v ' + (state.liquidated ? 'dn' : ''));
    set(`st-free-${i}`, fmtUsd(state.freeUsable),
        'st-pool-v ' + (state.free <= 0 ? 'dn' : ''));
    set(`st-used-${i}`, `${fmt(state.usedPct, 1)}%`);

    const fill = document.getElementById(`st-fill-${i}`);
    if (fill) {
      const pct = Math.max(0, Math.min(100, state.usedPct));
      fill.style.width = pct + '%';
      fill.style.background = state.liquidated ? 'var(--danger)'
        : pct > 80 ? 'var(--warning)' : 'var(--bn)';
    }

    const badge = document.getElementById(`st-status-${i}`);
    if (badge) {
      const [label, col, bg] = state.liquidated ? ['Liquidated', 'var(--red)', 'var(--red-bg)']
        : state.usedPct > 80 ? ['Critical', 'var(--red)', 'var(--red-bg)']
        : state.usedPct > 50 ? ['Warning', 'var(--amber)', 'var(--amber-bg)']
        : ['Safe', 'var(--green)', 'var(--green-bg)'];
      badge.textContent = label;
      badge.style.color = col;
      badge.style.background = bg;
    }

    const casc = document.getElementById(`st-cascade-${i}`);
    if (casc) {
      if (!state.liquidated) casc.innerHTML = '';
      else {
        const c = riskEngine.cascade(riskHonorStops ? riskEngine.applyStops(P.pool, P.marks, prices).pool : P.pool, prices, P.opts);
        const names = c.closed.map(x => `${x.asset} ${x.positionSide.toLowerCase()}`).join(', ') || 'nothing left to close';
        casc.innerHTML = `<div class="st-note" style="color:var(--danger)">Cascade (approximate — Binance does not publish its ordering):
          force-closes ${names} → ${c.wipedOut ? 'account wiped out' : `survives with ${fmtUsd(c.finalBuffer)} buffer and ${c.survivors.length} position(s)`}.</div>`;
      }
    }

    Object.keys(P.marks).forEach(asset => {
      const base = { ...prices, [asset]: P.marks[asset] };
      const both = riskEngine.killPricesBoth(P.pool, asset, base, opts);
      const kill = both.buffer, freeK = both.free;

      // Binance publishes a liquidation price with the margin tier frozen at the current
      // notional; its live engine re-tiers. Where a threshold crosses a bracket the two
      // legitimately differ, so both are shown. Only scanned when it actually happens.
      const crossUp   = kill.up   != null && riskEngine.crossesTier(P.pool, asset, base, kill.up);
      const crossDown = kill.down != null && riskEngine.crossesTier(P.pool, asset, base, kill.down);
      const frozen = (crossUp || crossDown)
        ? riskEngine.killPrices(riskEngine.freezeTiers(P.pool, base), asset, base, opts)
        : null;
      const dr   = riskEngine.drainPer1Pct(P.pool, asset, prices, P.opts);
      const dec  = priceDecimals(P.marks[asset]);
      const sigma = P.stats[asset]?.dailySigmaPct || null;

      const slider = document.getElementById(`st-range-${i}-${asset}`);
      if (slider) slider.value = Math.max(-riskRange, Math.min(riskRange, riskShift[asset] || 0));

      const priceBox = document.getElementById(`st-new-${i}-${asset}`);
      if (priceBox && document.activeElement !== priceBox) priceBox.value = prices[asset].toFixed(dec);
      set(`st-shift-${i}-${asset}`, `${(riskShift[asset] || 0) >= 0 ? '+' : ''}${fmt(riskShift[asset] || 0, 1)}%`);
      const signed = v => `${v >= 0 ? '+' : '−'}${fmtUsd(Math.abs(v))}`;
      set(`st-drain-${i}-${asset}`, `buf ${signed(dr.up)} · free ${signed(dr.freeUp)}`,
          'v ' + (dr.up >= 0 ? 'up' : 'dn'));

      const killTxt = (price, pct, worst, exch) => {
        if (price == null) return `none · worst ${fmtUsd(worst)}`;
        const sig = sigma ? ` · ${fmt(Math.abs(pct) / sigma, 1)}σ` : '';
        const alt = exch != null ? ` · exch ${fmt(exch, dec)}` : '';
        return `${fmt(price, dec)} (${pct >= 0 ? '+' : ''}${fmt(pct, 1)}%${sig})${alt}`;
      };
      set(`st-killup-${i}-${asset}`, killTxt(kill.up, kill.upPct, kill.minBufferUp,
          crossUp ? frozen?.up : null));
      set(`st-killdn-${i}-${asset}`, killTxt(kill.down, kill.downPct, kill.minBufferDown,
          crossDown ? frozen?.down : null));
      set(`st-freeup-${i}-${asset}`, killTxt(freeK.up, freeK.upPct, freeK.minBufferUp));
      set(`st-freedn-${i}-${asset}`, killTxt(freeK.down, freeK.downPct, freeK.minBufferDown));

      placeTick(`st-tickup-${i}-${asset}`, kill.upPct, '▲', kill.up, dec);
      placeTick(`st-tickdn-${i}-${asset}`, kill.downPct, '▼', kill.down, dec);
      placeTick(`st-freetickup-${i}-${asset}`, freeK.upPct, '△', freeK.up, dec);
      placeTick(`st-freetickdn-${i}-${asset}`, freeK.downPct, '▽', freeK.down, dec);
    });
  });
}

function placeTick(id, pct, glyph, price, dec) {
  const el = document.getElementById(id);
  if (!el) return;
  if (pct == null) { el.style.display = 'none'; return; }

  const offScale = Math.abs(pct) > riskRange;
  const clamped  = Math.max(-riskRange, Math.min(riskRange, pct));
  el.style.display = 'block';
  el.style.left    = `${(clamped + riskRange) / (2 * riskRange) * 100}%`;
  el.style.opacity   = offScale ? '0.45' : '1';
  el.style.transform = offScale ? (pct > 0 ? 'translateX(-88%)' : 'translateX(-12%)') : 'translateX(-50%)';
  el.innerHTML = offScale
    ? `${pct > 0 ? '»' : '«'}<b>${fmt(price, dec)}</b>`
    : `${glyph}<b>${fmt(price, dec)}</b>`;
}

// ── scenarios ────────────────────────────────────────────────────────────

const STRESS_SCENARIOS = [
  { key: 'up',      mode: 'uniform', sign: +1, label: 'Everything up',   note: 'all marks rise together' },
  { key: 'down',    mode: 'uniform', sign: -1, label: 'Everything down', note: 'all marks fall together' },
  { key: 'adverse', mode: 'adverse', sign: -1, label: 'Adverse basket',  note: 'every net position moves against you' },
  { key: 'betaUp',  mode: 'btcBeta', sign: +1, label: 'BTC up × beta',   note: 'alts follow BTC by measured beta' },
  { key: 'betaDn',  mode: 'btcBeta', sign: -1, label: 'BTC down × beta', note: 'alts follow BTC by measured beta' }
];

function stressScenarios(P, poolIdx) {
  const betas = Object.fromEntries(Object.keys(riskBeta).map(a => [a, betaOf(a)]));
  return STRESS_SCENARIOS.map(s => {
    const dir = riskEngine.scenarioDir(P.pool, s.mode, { betas, sign: s.sign, prices: P.marks });
    const raw     = riskEngine.scanRay(P.pool, P.marks, dir, P.opts);
    const stopped = riskEngine.scanRay(P.pool, P.marks, dir, { ...P.opts, honorStops: true });
    const freeOut = riskEngine.scanRay(P.pool, P.marks, dir, { ...P.opts, metric: 'free' });
    const driver  = Object.entries(dir).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
    return { ...s, dir, raw, stopped, freeOut, driver, poolIdx };
  });
}

function renderScenarioTable(P, poolIdx) {
  const rows = stressScenarios(P, poolIdx).map(s => {
    const lam = r => r.breachLambda == null ? null : r.breachLambda * 100;
    const rawPct = lam(s.raw), stopPct = lam(s.stopped);
    const worse  = rawPct != null && stopPct != null && stopPct < rawPct - 0.01;

    const moves = Object.entries(s.dir)
      .map(([a, d]) => `${a} ${d >= 0 ? '+' : ''}${fmt(d * (rawPct ?? 0), 0)}%`)
      .join('  ');

    const cell = (pct, scannedTo) => pct == null
      ? `<span style="color:var(--success)">survives +${fmt(scannedTo * 100, 0)}%</span>`
      : `${fmt(pct, 1)}%`;

    return `<tr>
      <td>${s.label}<div style="color:var(--text3);font-size:10px">${s.note}</div></td>
      <td class="num" style="color:var(--warning)">${cell(lam(s.freeOut), s.freeOut.scannedTo)}</td>
      <td class="num">${cell(rawPct, s.raw.scannedTo)}</td>
      <td class="num ${worse ? 'st-worse' : (stopPct != null && rawPct != null && stopPct > rawPct ? 'st-better' : '')}">${cell(stopPct, s.stopped.scannedTo)}</td>
      <td style="color:var(--text3)">${rawPct == null ? '—' : moves}</td>
      <td class="num">${rawPct == null ? '' : `<button class="st-btn" onclick="snapToKill(${poolIdx},'${s.mode}',${s.sign})"
             title="Move every slider to this kill${riskHonorStops ? ', with reduce-only stops honoured' : ''}">snap</button>`}</td>
    </tr>`;
  }).join('');

  return `<p class="section-label" style="margin:18px 0 6px">Where the pool dies</p>
    <table class="st-scen">
      <tr><th>Scenario</th><th style="text-align:right">Free margin gone</th>
          <th style="text-align:right">Liquidated</th>
          <th style="text-align:right">With stops</th><th>At the kill</th><th></th></tr>
      ${rows}
    </table>
    <div class="st-note"><b>Free margin gone</b> is where you can no longer open a position or transfer out;
      <b>liquidated</b> is where the buffer reaches zero. Both are quoted as the move in the driving asset.
      <b>With stops</b> honours your reduce-only orders along the way — when it is <span class="st-worse">worse</span>,
      a take-profit fires on a hedge leg first and leaves the remaining side naked.
      Scenario magnitudes are unscaled by probability; check the σ figures on each slider for that.</div>`;
}

// ── markup ───────────────────────────────────────────────────────────────

function renderStressControls() {
  const btn = (label, on, onclick, title) =>
    `<button class="st-btn${on ? ' on' : ''}" onclick="${onclick}" title="${title}">${label}</button>`;

  return `<div class="st-controls" id="st-mounted">
    ${btn('Reset', false, 'resetStress()', 'Put every price back on its mark')}
    ${btn('Refresh marks', false, 'fetchRiskBook(true)', 'Re-read the book from the exchange')}
    <span id="st-age" style="font-size:10px;color:var(--text3)"></span>
    <span class="st-sep"></span>
    ${btn('Honour reduce-only stops', riskHonorStops, "toggleStressOpt('stops')",
          'Close positions when the path crosses your reduce-only triggers')}
    ${btn('Stress correlation (β→1)', riskStressCorr, "toggleStressOpt('corr')",
          'Force every beta to 1, which is what correlations do in a crash')}
    <span class="st-sep"></span>
    <label>Range ±
      <select class="st-btn" onchange="setStressRange(this.value)">
        ${RANGE_TIERS.map(t => `<option value="${t}"${t === riskRange ? ' selected' : ''}>${t}%</option>`).join('')}
      </select>
    </label>
  </div>`;
}

function renderStressBanner() {
  const pools = riskBook.pools || [];
  const bad   = pools.filter(P => !P.calibration.trustworthy);
  const est   = pools.filter(P => P.calibration.estimatedBrackets);
  const out   = [];

  if (bad.length) {
    out.push(`<div class="st-banner bad"><b>Model does not reconcile.</b>
      <code>${bad.map(P => `${P.marginAsset}: maintenance margin off by ${fmt(P.calibration.mmErrPct, 2)}%`).join('; ')}</code>
      Treat every threshold below as unreliable.</div>`);
  } else {
    out.push(`<div class="st-banner ok"><b>Calibrated.</b>
      <code>${pools.map(P => `${P.marginAsset}: maintenance margin ±${fmt(P.calibration.mmErrPct, 3)}%, initial margin ±${fmt(P.calibration.imErrPct, 3)}%, equity ±${fmt(P.calibration.equityErrPct, 3)}% vs Binance`).join('; ')}</code></div>`);
    const anchored = pools.filter(P => P.calibration.freeAnchored);
    if (anchored.length) {
      out.push(`<div class="st-banner ok" style="opacity:.85">Free margin starts from Binance's own availableBalance
        <code>${anchored.map(P => `${P.marginAsset}: ${fmtUsd(P.calibration.reportedFree)}, holding ${fmtUsd(P.calibration.freeReserved)} against open orders`).join('; ')}</code>
        and moves with position initial margin, which is modelled exactly.</div>`);
    }
  }
  if (est.length) {
    out.push(`<div class="st-banner warn">Bracket table unavailable for some positions — maintenance rate inferred from the reported margin with no tier deduction. Kill prices are approximate.</div>`);
  }
  if (riskBook.account?.multiAssetsMode) {
    out.push(`<div class="st-banner warn">Multi-assets margin is on: collateral is haircut across assets, which this model does not reproduce.</div>`);
  } else if (pools.length > 1) {
    out.push(`<div class="st-banner warn"><b>${pools.length} independent pools.</b>
      Single-asset margin mode means each collateral asset is liquidated separately — a ${pools[0].marginAsset} balance is no protection for a ${pools[1].marginAsset} position.</div>`);
  }
  if ((riskBook.isolated || []).length) {
    out.push(`<div class="st-banner warn">${riskBook.isolated.length} isolated position(s) excluded — they carry their own margin and liquidate on their own:
      ${riskBook.isolated.map(p => `${p.pair} ${p.side}`).join(', ')}.</div>`);
  }
  return out.join('');
}

function renderStressRow(P, poolIdx, asset) {
  const mark = P.marks[asset];
  const dec  = priceDecimals(mark);
  const b    = P.baseline.find(x => x.asset === asset) || {};
  const shift = riskShift[asset] || 0;
  const bars  = P.stats[asset]?.bars || 0;

  return `<div class="st-row">
    <div class="st-rowhead">
      <span class="st-asset">${asset}
        <button class="st-link${riskLink[asset] ? ' on' : ''}" onclick="toggleStressLink('${asset}')"
          title="${riskLink[asset] ? 'Moves with the beta chain — click to move it on its own' : 'Moves on its own — click to link it to the beta chain'}">β ${fmt(betaOf(asset), 2)}</button>
      </span>
      <span class="st-mark">mark ${fmt(mark, dec)}${bars ? '' : ' · no candles'}</span>
      <span class="st-mark">${netDeltaLabel(b.netDelta)}</span>
    </div>

    <div class="st-track">
      <span class="st-tick kill" id="st-tickup-${poolIdx}-${asset}" style="display:none"></span>
      <span class="st-tick kill" id="st-tickdn-${poolIdx}-${asset}" style="display:none"></span>
      <span class="st-tick freez" id="st-freetickup-${poolIdx}-${asset}" style="display:none"></span>
      <span class="st-tick freez" id="st-freetickdn-${poolIdx}-${asset}" style="display:none"></span>
      <input type="range" id="st-range-${poolIdx}-${asset}" min="${-riskRange}" max="${riskRange}" step="0.1"
        value="${Math.max(-riskRange, Math.min(riskRange, shift))}"
        oninput="setStressShift('${asset}', this.value)" />
      <div class="st-scale"><span>−${riskRange}%</span><span>mark</span><span>+${riskRange}%</span></div>
    </div>

    <div class="st-meta">
      <span class="k">price</span><span class="v"><input type="number" class="st-price" id="st-new-${poolIdx}-${asset}"
        step="${priceStep(mark)}" value="${mark.toFixed(dec)}"
        onchange="setStressPrice('${asset}', this.value)" title="Type a price to move this coin there" /></span>
      <span class="k">shift</span><span class="v" id="st-shift-${poolIdx}-${asset}">+0.0%</span>
      <span class="k">liq up</span><span class="v" id="st-killup-${poolIdx}-${asset}">—</span>
      <span class="k">liq down</span><span class="v" id="st-killdn-${poolIdx}-${asset}">—</span>
      <span class="k">free 0 up</span><span class="v" id="st-freeup-${poolIdx}-${asset}">—</span>
      <span class="k">free 0 down</span><span class="v" id="st-freedn-${poolIdx}-${asset}">—</span>
      <span class="k">per +1%</span><span class="v" id="st-drain-${poolIdx}-${asset}">—</span>
    </div>
  </div>`;
}

function renderStressPool(P, poolIdx) {
  const assets = P.baseline.map(b => b.asset);
  const cell = (k, v, id, sub) => `<div class="st-pool-cell">
      <div class="st-pool-k">${k}</div>
      <div class="st-pool-v" id="${id}">${v}</div>
      ${sub ? `<div class="st-pool-sub">${sub}</div>` : ''}
    </div>`;

  return `<div style="margin-bottom:26px">
    <div class="st-pool">
      ${cell('Collateral', fmtUsd(P.pool.collateral), `st-coll-${poolIdx}`, `${P.marginAsset} wallet`)}
      ${cell('Equity', fmtUsd(P.state.equity), `st-eq-${poolIdx}`, 'wallet + uPnL')}
      ${cell('Maint. margin', fmtUsd(P.state.mm), `st-mm-${poolIdx}`, `${P.pool.positions.length} position(s)`)}
      ${cell('Pool buffer', fmtUsd(P.state.buffer), `st-buf-${poolIdx}`, 'equity − maint. margin')}
      ${cell('Free margin', fmtUsd(P.state.free), `st-free-${poolIdx}`, 'usable for new positions or transfer out')}
      <div class="st-pool-cell" style="flex:1.4">
        <div class="st-pool-k">Pool used</div>
        <div class="st-pool-v" id="st-used-${poolIdx}">${fmt(P.state.usedPct, 1)}%</div>
        <div class="st-usedbar"><div class="st-usedfill" id="st-fill-${poolIdx}" style="width:${Math.min(100, P.state.usedPct)}%;background:var(--bn)"></div></div>
        <div class="st-pool-sub">maint. margin ÷ equity — the ratio Binance liquidates on, not the
          initial-margin ÷ wallet figure in the sidebar</div>
      </div>
      <div class="st-status" id="st-status-${poolIdx}" style="background:var(--green-bg);color:var(--green)">Safe</div>
    </div>
    <div id="st-cascade-${poolIdx}"></div>
    ${P.hedgedSymbols.length ? `<div class="st-note">Same-symbol hedges on ${P.hedgedSymbols.join(', ')} — both legs pay maintenance margin, and Binance gives them one shared liquidation price.</div>` : ''}
    ${(() => {
      const risky = (P.adl || []).filter(a => a.quantile >= 3);
      if (!risky.length) return '';
      return `<div class="st-banner warn">ADL queue: ${risky.map(a => `${a.asset} ${a.side.toLowerCase()} at ${a.quantile}/4`).join(', ')}.
        Auto-deleveraging closes <i>profitable</i> positions, so on a hedge it takes the winning leg and
        leaves the loser naked.</div>`;
    })()}
    ${assets.map(a => renderStressRow(P, poolIdx, a)).join('')}
    ${renderScenarioTable(P, poolIdx)}
  </div>`;
}

function renderStress() {
  if (!venueOn('binance')) return venueOffHtml('binance');
  if (riskLoading && !riskBook) {
    return `<p style="font-size:12px;color:var(--text3);padding:14px 0">Resolving the cross pool…</p>`;
  }
  if (!riskBook) {
    return loadErrors.risk ? `${renderStressControls()}${loadErrorHtml('risk', 'fetchRiskBook(true)', false)}`
      : `<p style="font-size:12px;color:var(--text3);padding:14px 0">No pool data yet.</p>`;
  }
  const stale = loadErrorHtml('risk', 'fetchRiskBook(true)', true);
  if (!riskBook.pools?.length) {
    return `${stale}${renderStressBanner()}<p style="font-size:12px;color:var(--text3);padding:14px 0">No open Binance cross positions.</p>`;
  }

  const body = riskBook.pools.map((P, i) => renderStressPool(P, i)).join('');
  requestAnimationFrame(updateStress);
  return `${stale}${renderStressBanner()}${renderStressControls()}${body}`;
}
