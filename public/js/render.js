// render.js — the sidebar widgets, the main render() pass and the 15s dashboard poll.

function renderMarginHealth(data) {
  const hl = data.hyperliquid, bn = data.binance;

  // ── Binance: standard margin utilisation % ────────────────────────────
  const bnPct = Math.min(parseFloat(bn.marginPct) || 0, 100);
  const bnColVar = bnPct > 80 ? 'var(--danger)' : bnPct > 50 ? 'var(--warning)' : 'var(--bn)';

  // ── Hyperliquid: margin utilisation (marginUsed / equity) ────────────
  const hlEquity     = parseFloat(hl.equity)     || 0;
  const hlMarginUsed = parseFloat(hl.marginUsed) || 0;
  const hlFree       = parseFloat(hl.freeMargin) || 0;
  const hlPct        = hlEquity > 0 ? Math.min((hlMarginUsed / hlEquity) * 100, 100) : 0;
  const hlColVar     = hlPct > 80 ? 'var(--danger)' : hlPct > 50 ? 'var(--warning)' : 'var(--hl)';

  // ── Overall status ────────────────────────────────────────────────────
  const [statusLabel, statusCol, statusBg] =
    (bnPct > 80 || hlPct > 80) ? ['Critical', 'var(--red)',   'var(--red-bg)']
  : (bnPct > 50 || hlPct > 50) ? ['Warning',  'var(--amber)', 'var(--amber-bg)']
  :                              ['Healthy',  'var(--green)',  'var(--green-bg)'];

  // ── BN totals ─────────────────────────────────────────────────────────
  const bnFree = parseFloat(bn.freeMargin) || 0;
  const bnUsed = parseFloat(bn.marginUsed) || 0;

  // ── SVG arc gauge helper ──────────────────────────────────────────────
  // Draws a half-circle (180°) gauge. cx/cy = center, r = radius, pct = 0-100.
  // Returns SVG path strings for track + fill + needle.
  function arcGaugeSVG(id, pct, fillColor, label, sublabel, valText, w) {
    const cx = w / 2, cy = w * 0.54, r = w * 0.38;
    const stroke = w * 0.07;
    // Arc from 180° to 0° (left to right = 0% to 100%)
    // SVG arc: start at (cx - r, cy), sweep 180° to (cx + r, cy)
    const trackPath = `M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx + r} ${cy}`;
    // Fill arc from 180° to (180° - pct*1.8°)
    const angle = Math.PI - (pct / 100) * Math.PI; // radians from left
    const ex = cx + r * Math.cos(angle);
    const ey = cy - r * Math.sin(angle);
    const largeArc = 0;   // the sweep never exceeds 180°, so always the minor arc
    const fillPath = pct > 0
      ? `M ${cx - r} ${cy} A ${r} ${r} 0 ${largeArc} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`
      : '';
    // Needle: line from center to arc at current angle, slightly inside
    const nr = r - stroke * 0.1;
    const nx = cx + nr * Math.cos(angle);
    const ny = cy - nr * Math.sin(angle);
    // Tick marks at 0, 25, 50, 75, 100%
    const ticks = [0, 25, 50, 75, 100].map(t => {
      const ta = Math.PI - (t / 100) * Math.PI;
      const inner = r - stroke * 0.8;
      const outer = r + stroke * 0.05;
      return `<line x1="${(cx + inner * Math.cos(ta)).toFixed(1)}" y1="${(cy - inner * Math.sin(ta)).toFixed(1)}"
                    x2="${(cx + outer * Math.cos(ta)).toFixed(1)}" y2="${(cy - outer * Math.sin(ta)).toFixed(1)}"
                    stroke="var(--bg)" stroke-width="1.2" stroke-linecap="round"/>`;
    }).join('');

    return `<svg id="${id}" viewBox="0 0 ${w} ${cy + stroke}" width="${w}" height="${cy + stroke + 2}" style="display:block;overflow:visible">
      <!-- track -->
      <path d="${trackPath}" fill="none" stroke="var(--border2)" stroke-width="${stroke}" stroke-linecap="butt"/>
      <!-- zone colours (green→amber→red) rendered as layered arcs behind fill -->
      <path d="M ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${(cx + r * Math.cos(Math.PI * 0.5)).toFixed(2)} ${(cy - r * Math.sin(Math.PI * 0.5)).toFixed(2)}" fill="none" stroke="var(--success)" stroke-width="${stroke}" stroke-linecap="butt" opacity="0.13"/>
      <path d="M ${(cx + r * Math.cos(Math.PI * 0.5)).toFixed(2)} ${(cy - r * Math.sin(Math.PI * 0.5)).toFixed(2)} A ${r} ${r} 0 0 1 ${(cx + r * Math.cos(Math.PI * 0.2)).toFixed(2)} ${(cy - r * Math.sin(Math.PI * 0.2)).toFixed(2)}" fill="none" stroke="var(--warning)" stroke-width="${stroke}" stroke-linecap="butt" opacity="0.18"/>
      <path d="M ${(cx + r * Math.cos(Math.PI * 0.2)).toFixed(2)} ${(cy - r * Math.sin(Math.PI * 0.2)).toFixed(2)} A ${r} ${r} 0 0 1 ${cx + r} ${cy}" fill="none" stroke="var(--danger)" stroke-width="${stroke}" stroke-linecap="butt" opacity="0.22"/>
      <!-- fill arc -->
      ${fillPath ? `<path d="${fillPath}" fill="none" stroke="${fillColor}" stroke-width="${stroke}" stroke-linecap="butt" opacity="0.9"/>` : ''}
      <!-- tick marks -->
      ${ticks}
      <!-- needle -->
      ${pct > 0 ? `<line x1="${cx}" y1="${cy}" x2="${nx.toFixed(2)}" y2="${ny.toFixed(2)}" stroke="${fillColor}" stroke-width="1.5" stroke-linecap="round" opacity="0.95"/>
      <circle cx="${cx}" cy="${cy}" r="3" fill="${fillColor}" opacity="0.95"/>` : ''}
      <!-- center label -->
      <text x="${cx}" y="${(cy - 6).toFixed(1)}" text-anchor="middle" font-size="13" font-weight="700" fill="${fillColor}" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">${valText}</text>
      <text x="${cx}" y="${(cy + 7).toFixed(1)}" text-anchor="middle" font-size="8" fill="var(--text3)" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">${sublabel}</text>
    </svg>`;
  }

  const gaugeW = 124;
  const offGauge = '<span class="b-val nu" style="padding:18px 0">off</span>';
  const hlSvg = venueOn('hyperliquid') ? arcGaugeSVG('mg-hl', hlPct, hlColVar, 'HL', 'margin used', fmt(hlPct,1)+'%', gaugeW) : offGauge;
  const bnSvg = venueOn('binance') ? arcGaugeSVG('mg-bn', bnPct, bnColVar, 'BN', 'margin used', fmt(bnPct,1)+'%', gaugeW) : offGauge;

  return `<div style="margin-top:8px">
    <div class="card" style="margin-bottom:0;background:var(--surface2);border:none;padding:10px 12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">
        <p class="section-label" style="margin:0">Margin health</p>
        <span style="font-size:10px;font-weight:600;padding:2px 7px;border-radius:10px;background:${statusBg};color:${statusCol}">${statusLabel}</span>
      </div>

      <!-- Dual arc gauges side by side -->
      <div style="display:flex;align-items:flex-end;justify-content:space-around;gap:4px;margin:0 -4px 2px">
        <div style="display:flex;flex-direction:column;align-items:center;gap:0;flex:1">
          <div style="display:flex;align-items:center;gap:4px;margin-bottom:2px">
            <span style="width:5px;height:5px;border-radius:50%;background:var(--hl);flex-shrink:0"></span>
            <span style="font-size:9px;font-weight:600;color:var(--text2)">HL</span>
          </div>
          ${hlSvg}
        </div>
        <div style="display:flex;flex-direction:column;align-items:center;gap:0;flex:1">
          <div style="display:flex;align-items:center;gap:4px;margin-bottom:2px">
            <span style="width:5px;height:5px;border-radius:50%;background:var(--bn);flex-shrink:0"></span>
            <span style="font-size:9px;font-weight:600;color:var(--text2)">BN</span>
          </div>
          ${bnSvg}
        </div>
      </div>

      <!-- Detail rows -->
      <div style="border-top:0.5px solid var(--border);padding-top:6px;display:flex;flex-direction:column;gap:3px">
        <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text3)">
          <span>HL equity</span>
          ${offOr('hyperliquid', `<span class="sb-num" style="color:var(--text2);font-weight:600">${fmtUsd(hlEquity)}</span>`)}
        </div>
        <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text3)">
          <span>HL margin used</span>
          ${offOr('hyperliquid', `<span class="sb-num" style="color:${hlColVar};font-weight:600">${fmtUsd(hlMarginUsed)}</span>`)}
        </div>
        <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text3)">
          <span>HL free</span>
          ${offOr('hyperliquid', `<span class="sb-num" style="color:var(--success);font-weight:600">${fmtUsd(hlFree)}</span>`)}
        </div>
        <div style="height:0.5px;background:var(--border);margin:2px 0"></div>
        <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text3)">
          <span>BN used</span>
          ${offOr('binance', `<span class="sb-num" style="color:${bnColVar};font-weight:600">${fmtUsd(bnUsed)}</span>`)}
        </div>
        <div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text3)">
          <span>BN free</span>
          ${offOr('binance', `<span class="sb-num" style="color:var(--success);font-weight:600">${fmtUsd(bnFree)}</span>`)}
        </div>
      </div>
    </div>
  </div>`;
}


function renderCalcTiles() {
  const tiles = [
    {
      tab: 'pnl',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>`,
      label: 'P&L',
      sub: 'Profit & loss'
    },
    {
      tab: 'avg',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
      label: 'Avg Down/Up',
      sub: 'Blended entry'
    },
    {
      tab: 'liq',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
      label: 'Liq Price',
      sub: 'Estimate liq'
    },
    {
      action: 'openLiqDrawer()',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/></svg>`,
      label: 'Liquidation after close — reprice what you keep'
    },
    {
      action: 'openSimDrawer()',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>`,
      label: 'Unwind simulator — close legs by hand'
    },
    {
      action: 'openHlDrawer()',
      icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="12" y1="9" x2="12" y2="21"/></svg>`,
      label: 'Hedge ledger — what is already decided, and what it costs to hold'
    }
  ];

  const tileHtml = tiles.map(t => {
    const onclick = t.action || `openCalcFromSidebar('${t.tab}')`;
    return `<div class="calc-tile" onclick="${onclick}" title="${t.label}">
      <div class="calc-tile-icon">${t.icon}</div>
    </div>`;
  }).join('');

  return `<div class="calc-tile-grid">${tileHtml}</div>`;
}

function renderSidebarBottomRow(data) {
  return `
    <div class="sb-bottom-row">
      <div class="sb-funding metric clickable" onclick="openFundDrawer()" title="Click to see funding breakdown" style="cursor:pointer">${renderDailyFundingWidget(data)}</div>
      <div style="min-width:0">
        ${renderCalcTiles()}
      </div>
    </div>`;
}

function render(data) {
  lastData = data;
  const s = data.summary;
  const upnlNum = parseFloat(s.totalUpnl);
  const hlUpnl = data.hyperliquid.positions.reduce((sum, p) => sum + p.upnl, 0);
  const bnUpnl = data.binance.positions.reduce((sum, p) => sum + p.upnl, 0);
  const hlOrders = data.hyperliquid.orders || [];
  const bnOrders = data.binance.orders || [];
  const totalOrders = hlOrders.length + bnOrders.length;

  const tabsHtml = `<div class="view-tabs">
    <button class="view-tab${posView==='tiles'?' active':''}" data-view="tiles" onclick="setView('tiles')">Tiles</button>
    <button class="view-tab${posView==='list'?' active':''}" data-view="list" onclick="setView('list')">List</button>
    <button class="view-tab${posView==='orders'?' active':''}" data-view="orders" onclick="setView('orders')">Orders${totalOrders ? ` <span style="background:var(--surface2);border-radius:10px;padding:0 5px;font-size:10px">${totalOrders}</span>` : ''}</button>
  </div>`;

  const exchTabsHtml = venuesOn().length < 2 ? '' : `<div class="view-tabs">
    <button class="view-tab${exchFilter.has('hyperliquid')?' active':''}" data-exch="hyperliquid" onclick="toggleExch('hyperliquid')" style="display:flex;align-items:center;gap:5px"><span style="width:6px;height:6px;border-radius:50%;background:var(--hl);flex-shrink:0;display:inline-block"></span>HL</button>
    <button class="view-tab${exchFilter.has('binance')?' active':''}" data-exch="binance" onclick="toggleExch('binance')" style="display:flex;align-items:center;gap:5px"><span style="width:6px;height:6px;border-radius:50%;background:var(--bn);flex-shrink:0;display:inline-block"></span>BN</button>
  </div>`;

  const shown = shownVenues();
  const showHL = shown.includes('hyperliquid');
  const showBN = shown.includes('binance');

  const filteredPositions = [
    ...(showHL ? data.hyperliquid.positions : []),
    ...(showBN ? data.binance.positions : [])
  ];
  const filteredOrders = [
    ...(showHL ? hlOrders : []),
    ...(showBN ? bnOrders : [])
  ];
  const countPill = (n) => `<span style="background:var(--surface2);border-radius:10px;padding:1px 7px;font-size:11px;font-weight:400;color:var(--text2);vertical-align:middle">${n}</span>`;
  let sectionLabel;
  if (posView === 'orders')      sectionLabel = `Open orders ${countPill(filteredOrders.length)}`;
  else if (posView === 'stops')  sectionLabel = `Dynamic stops ${countPill((volStopData?.positions || []).length)}`;
  else if (posView === 'stress') sectionLabel = `Cross-pool stress <span style="font-size:11px;color:var(--text3);font-weight:400">Binance only</span>`;
  else if (posView === 'unwind') sectionLabel = `Unwind planner <span style="font-size:11px;color:var(--text3);font-weight:400">Binance only</span>`;
  else if (posView === 'journal') sectionLabel = `Journal <span style="font-size:11px;color:var(--text3);font-weight:400">cached history</span>`;
  else if (posView === 'confluence') sectionLabel = `Confluence <span style="font-size:11px;color:var(--text3);font-weight:400">Binance perps</span>`;
  else                           sectionLabel = `Open positions ${countPill(filteredPositions.length)}`;
  const unifiedContent = posView === 'orders'
    ? renderOrdersFor(filteredOrders)
    : posView === 'stops'
      ? renderVolStops()
      : posView === 'stress'
        ? renderStress()
        : posView === 'unwind'
          ? renderUnwind()
          : posView === 'journal'
            ? renderJournal()
            : posView === 'confluence'
              ? renderConfluence()
              : shown.length ? renderPositions(filteredPositions) : allVenuesOffHtml();

  let cardHeader = '';
  if (showHL && showBN) {
    cardHeader = `<div class="exch-header" style="gap:0">
      <span style="display:flex;align-items:center;gap:8px;flex:1">
        <span class="exch-dot" style="background:var(--hl)"></span>
        <span class="exch-name">Hyperliquid</span>
        <span class="exch-stats">
          <span>Eq: <span class="exch-equity">${venueEq(data.hyperliquid)}</span></span>
          <span>Margin: ${venueMargin(data.hyperliquid)}</span>
        </span>
      </span>
      <span style="width:0.5px;height:14px;background:var(--border2);flex-shrink:0;margin:0 12px"></span>
      <span style="display:flex;align-items:center;gap:8px;flex:1">
        <span class="exch-dot" style="background:var(--bn)"></span>
        <span class="exch-name">Binance</span>
        <span class="exch-stats">
          <span>Eq: <span class="exch-equity">${venueEq(data.binance)}</span></span>
          <span>Margin: ${venueMargin(data.binance)}</span>
          <span>Free: ${venueFree(data.binance)}</span>
        </span>
      </span>
    </div>`;
  } else if (showHL) {
    cardHeader = `<div class="exch-header">
      <span class="exch-dot" style="background:var(--hl)"></span>
      <span class="exch-name">Hyperliquid</span>
      <span class="exch-stats">
        <span>Equity: <span class="exch-equity">${venueEq(data.hyperliquid)}</span></span>
        <span>Margin: ${venueMargin(data.hyperliquid)}</span>
      </span>
    </div>`;
  } else if (showBN) {
    cardHeader = `<div class="exch-header">
      <span class="exch-dot" style="background:var(--bn)"></span>
      <span class="exch-name">Binance</span>
      <span class="exch-stats">
        <span>Equity: <span class="exch-equity">${venueEq(data.binance)}</span></span>
        <span>Margin: ${venueMargin(data.binance)}</span>
        <span>Free: ${venueFree(data.binance)}</span>
      </span>
    </div>`;
  }

  const mainContent = `
    ${renderToolsStrip()}
    <div class="section-bar">
      <div style="display:flex;align-items:center;gap:8px">
        <p class="section-label" style="margin:0">${sectionLabel}</p>
        ${isToolView(posView) && !toolFor(posView).exchangeFilter ? '' : exchTabsHtml}
      </div>
      <span class="session-clock" id="sessionClock">${sessionClockInner()}</span>
      ${tabsHtml}
    </div>

    <div class="card" style="margin-bottom:24px">
      ${isToolView(posView) ? '' : cardHeader}
      ${unifiedContent}
    </div>

  `;

  const sidebarContent = `
    <div class="metric-stack" style="margin-top:2px">
      <div class="metric">
        <div class="label">Total equity</div>
        <div class="val">${fmtUsd(s.totalEquity)}</div>
        <div class="breakdown">
          <div class="b-row"><span class="b-dot" style="background:var(--hl)"></span><span class="b-label">HL</span>${offOr('hyperliquid', `<span class="b-val">${venueEq(data.hyperliquid)}</span>`)}</div>
          <div class="b-row"><span class="b-dot" style="background:var(--bn)"></span><span class="b-label">BN</span>${offOr('binance', `<span class="b-val">${venueEq(data.binance)}</span>`)}</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <div class="metric clickable" onclick="openUpnlDrawer()" title="Click to see uPnL breakdown">
          <div class="label">uPnL</div>
          <div class="val ${upnlNum>=0?'up':'dn'}" style="font-size:16px">${upnlNum>=0?'+':'−'}${fmtUsd(Math.abs(upnlNum))}</div>
          <div class="breakdown">
            <div class="b-row"><span class="b-dot" style="background:var(--hl)"></span><span class="b-label">HL</span>${offOr('hyperliquid', `<span class="b-val ${hlUpnl>=0?'up':'dn'}">${hlUpnl>=0?'+':'−'}${fmtUsd(Math.abs(hlUpnl))}</span>`)}</div>
            <div class="b-row"><span class="b-dot" style="background:var(--bn)"></span><span class="b-label">BN</span>${offOr('binance', `<span class="b-val ${bnUpnl>=0?'up':'dn'}">${bnUpnl>=0?'+':'−'}${fmtUsd(Math.abs(bnUpnl))}</span>`)}</div>
          </div>
        </div>
        <div class="metric clickable" onclick="openExpDrawer()" title="Click to see exposure breakdown">
          <div class="label">Exposure</div>
          <div class="val" style="font-size:16px">${fmtUsd(s.totalExposure)}</div>
          <div class="breakdown">
            <div class="b-row"><span class="b-dot" style="background:var(--hl)"></span><span class="b-label">HL</span>${offOr('hyperliquid', `<span class="b-val">${fmtUsd(s.hlExposure)}</span>`)}</div>
            <div class="b-row"><span class="b-dot" style="background:var(--bn)"></span><span class="b-label">BN</span>${offOr('binance', `<span class="b-val">${fmtUsd(s.bnExposure)}</span>`)}</div>
          </div>
        </div>
      </div>
    </div>
    ${renderToolsNav()}
    ${renderMarginHealth(data)}
    ${renderSidebarBottomRow(data)}
  `;

  const mountId = { stress: 'st-mounted', unwind: 'uw-mounted', confluence: 'cf-mounted', stops: 'vs-mounted', journal: 'jr-mounted' }[posView] || null;
  const keepPanel = mountId && !riskForceRender && document.getElementById(mountId);
  riskForceRender = false;
  if (keepPanel) {
    if (posView === 'stress') updateStressAge();
    if (posView === 'confluence') updateConfluenceAge();
    const account = posView === 'journal' && document.getElementById('ov-account');
    if (account) account.innerHTML = ovAccountLine();
  }
  else if (contentInUse()) contentStale = true;
  else document.getElementById('content').innerHTML = mainContent;
  document.getElementById('content').style.display = 'block';
  document.getElementById('loader').style.display = 'none';
  document.getElementById('sidebar').innerHTML = sidebarContent;
  if (posView === 'tiles') {
    requestAnimationFrame(() => {
      drawThreadLines();
      // Re-apply focus state after DOM/SVG rebuild (e.g. auto-refresh)
      if (_focusedThreadKey) {
        const grid = document.getElementById('ptile-grid');
        const hasTiles = grid && grid.querySelector(`.pos-tile[data-thread="${_focusedThreadKey}"]`);
        if (hasTiles) _applyFocus(_focusedThreadKey, null);
        else clearTileFocus();
      } else if (_focusedTileId) {
        const grid = document.getElementById('ptile-grid');
        const tile = grid && grid.querySelector(`.pos-tile[data-pos-id="${_focusedTileId}"]`);
        if (tile) _applyFocus(null, tile);
        else clearTileFocus();
      }
    });
    initTileDrag();
  }
}

// One poll at a time, and none while the tab is hidden: a background tab was spending the
// same exchange quota as a visible one, and a slow response could land after a newer one.
// A rebuild of #content waits while a text field in it has focus or a tile is being dragged,
// and runs once that ends: replacing the markup would drop the typing or the drag.
let tileDragging = false;
let contentStale = false;

function contentInUse() {
  if (tileDragging) return true;
  const el = document.activeElement;
  const typing = el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && ['text', 'search'].includes(el.type)));
  return !!typing && !!document.getElementById('content')?.contains(el);
}

function resumeContent() {
  if (!contentStale || contentInUse()) return;
  contentStale = false;
  riskForceRender = true;
  if (lastData) render(lastData);
}

let pollInFlight = false;
let pollAgain = false;
let lastGoodAt = null;

// The server's own view of whether the figures can be trusted — ban state, request weight,
// order stream, snapshot age. Hidden while everything is fine; costs no exchange call.
async function updateHealthChip() {
  const el = document.getElementById('healthChip');
  if (!el) return;
  try {
    const h = await (await fetch('/api/health')).json();
    lastHealth = h;
    document.getElementById('statusDot').className = bulbClass();
    renderVenuePopover();
    el.hidden = h.level === 'ok';
    el.className = `health-chip ${h.level}`;
    el.textContent = `${h.level === 'bad' ? '⛔' : '⚠'} ${h.reasons.length} issue${h.reasons.length === 1 ? '' : 's'}`;
    el.title = h.reasons.map(r => `${r.level === 'bad' ? '⛔' : '⚠'} ${r.text}`).join('\n');
  } catch (_) {
    el.hidden = true;
  }
}

const VENUE_NAMES = { hyperliquid: 'Hyperliquid', binance: 'Binance' };

function showPartialBanner(banner, data) {
  const down = data.summary.partial || [];
  if (!down.length) return;
  banner.style.display = 'block';
  banner.textContent = down.map(v => `${VENUE_NAMES[v]} unavailable (${data[v].error}) — totals exclude it`).join(' · ');
}

const venueEq = v => (v.error ? '<span class="dn">unavailable</span>' : fmtUsd(v.equity));
const venueMargin = v => (v.error ? '—' : `${v.marginPct}%`);
const venueFree = v => (v.error ? '—' : fmtUsd(v.freeMargin));

async function fetchData() {
  if (pollInFlight) { pollAgain = true; return; }
  pollInFlight = true;
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  const ico = document.getElementById('refreshIco');
  const err = document.getElementById('errBanner');

  dot.className = 'status-dot loading';
  txt.textContent = 'Fetching…';
  ico.style.animation = 'spin .7s linear infinite';
  err.style.display = 'none';

  try {
    const res  = await fetch('/api/dashboard');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'Unknown error');
    render(data);
    showPartialBanner(err, data);
    lastGoodAt = new Date(data.lastUpdated);
    dot.className = bulbClass();
    txt.textContent = `Last updated ${lastGoodAt.toLocaleTimeString()}`;
    updateHealthChip();
  } catch (e) {
    dot.className = 'status-dot error';
    txt.textContent = lastGoodAt
      ? `Stale — last good ${lastGoodAt.toLocaleTimeString()}`
      : 'Error fetching data';
    err.style.display = 'block';
    err.textContent = `Error: ${e.message}${lastGoodAt ? ' — figures below are from the last successful update' : ''}`;
  } finally {
    ico.style.animation = 'none';
    pollInFlight = false;
    if (pollAgain) { pollAgain = false; fetchData(); }
  }
}

// ── Sidebar visibility toggle ─────────────────────────────────────────────
let sidebarHidden = false;
function toggleSidebarVisibility() {
  sidebarHidden = !sidebarHidden;
  const sidebar = document.getElementById('sidebar');
  const eyeIco  = document.getElementById('eyeIco');
  const eyeBtn  = document.getElementById('eyeBtn');
  const app     = document.querySelector('.app');
  sidebar.classList.toggle('sidebar-nums-hidden', sidebarHidden);
  app.classList.toggle('nums-hidden', sidebarHidden);
  if (sidebarHidden) {
    eyeIco.innerHTML = '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>';
    eyeBtn.title = 'Show numbers';
  } else {
    eyeIco.innerHTML = '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>';
    eyeBtn.title = 'Hide numbers';
  }
}
