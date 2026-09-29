// positions.js — view switching, the HL/BN filter, the positions list and tiles, and the
// orders table.

function setView(v) {
  posView = v;
  savePref('posView', v);
  document.querySelectorAll('.view-tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  if (lastData) render(lastData);
  if (v === 'stops')  fetchVolStops();
  if (v === 'stress') fetchRiskBook();
  if (v === 'unwind') fetchUnwind();
  if (v === 'journal' && !perfData) fetchPerformance();
  if (v === 'confluence' && (!cfData || cfData.symbol !== cfSymbol)) fetchConfluence();
}

let volSeq = 0;
async function fetchVolStops() {
  const seq = ++volSeq;
  volLoading = true;
  if (posView === 'stops') rerenderStress();
  try {
    const res = await fetch(`/api/volstops?risk=${(volRiskPct / 100)}&k=${volK}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'volstops failed');
    if (seq !== volSeq) return;
    volStopData = data;
  } catch (err) {
    if (seq !== volSeq) return;
    volStopData = { error: err.message };
  } finally {
    if (seq === volSeq) {
      volLoading = false;
      if (posView === 'stops') rerenderStress();
    }
  }
}

function setVolRisk(v) {
  const n = parseFloat(v);
  if (!isNaN(n) && n > 0 && n <= 50) { volRiskPct = n; fetchVolStops(); }
}
function setVolK(v) {
  const n = parseFloat(v);
  if (!isNaN(n) && n >= 0.1 && n <= 10) { volK = n; fetchVolStops(); }
}

function toggleExch(exch) {
  if (exchFilter.has(exch) && exchFilter.size === 1) return;
  if (exchFilter.has(exch)) exchFilter.delete(exch);
  else exchFilter.add(exch);
  rerenderStress();
}

function renderPositions(positions) {
  if (!positions.length) return '<p style="font-size:12px;color:var(--text3);padding:8px 0">No open positions</p>';
  if (posView === 'tiles') return renderPositionTiles(positions);
  return `<div class="tbl-wrap"><table>
    <tr>
      <th>Pair</th><th>Side</th><th>Lev.</th><th>Size</th>
      <th>Entry</th><th>Current</th><th>Liq. price</th><th>uPnL</th><th>Funding rate</th><th>Daily funding</th>
    </tr>
    ${positions.map(p => {
      const dist = liqDist(p);
      const liqStyle = dist < 10 ? 'color:var(--danger);font-weight:600' : dist < 30 ? 'color:var(--warning)' : '';
      const costDay = fundingPerDay(p);
      const exchColor = p.exchange === 'hyperliquid' ? 'var(--hl)' : 'var(--bn)';
      const exchLabel = p.exchange === 'hyperliquid' ? 'HL' : 'BN';
      return `<tr>
        <td><span class="pair">${p.pair}</span><div class="pair-sub" style="display:flex;align-items:center;gap:4px"><span style="font-size:9px;font-weight:600;color:${exchColor}">${exchLabel}</span><span>${p.type}</span></div></td>
        <td>${sideBadge(p.side)}</td>
        <td>${p.leverage}</td>
        <td>${p.size}<div class="pair-sub">${fmtUsd(p.sizeUsd)}</div></td>
        <td>${fmtPrice(p.entry)}</td>
        <td>${fmtPrice(p.mark)}</td>
        <td style="${liqStyle}">${fmtPrice(p.liqPrice)}<div class="pair-sub">${dist < 999 ? fmt(dist,1)+'% away' : '—'}</div></td>
        <td>${fmtPnl(p.upnl)}</td>
        <td>${p.funding8h}<div class="pair-sub">every ${fundingIntervalOf(p)}h</div></td>
        <td>${fmtPnl(costDay)}</td>
      </tr>`;
    }).join('')}
  </table></div>`;
}

function renderPositionTiles(positions) {
  // Preserve user-defined drag order across re-renders
  const posMap = {};
  positions.forEach(p => { posMap[posId(p)] = p; });
  const orderedIds = tileOrder.filter(id => posMap[id]);
  const newIds = positions.filter(p => !orderedIds.includes(posId(p))).map(posId);
  tileOrder = [...orderedIds, ...newIds];
  const orderedPositions = tileOrder.map(id => posMap[id]).filter(Boolean);

  const pairGroups = {};
  orderedPositions.forEach(p => {
    const key = normalizePairKey(p.pair);
    if (!pairGroups[key]) pairGroups[key] = [];
    pairGroups[key].push(p);
  });

  let ci = 0;
  const threadColorMap = {};
  for (const [key, grp] of Object.entries(pairGroups)) {
    if (grp.some(p => p.side === 'Long') && grp.some(p => p.side === 'Short')) {
      threadColorMap[key] = THREAD_PALETTE[ci++ % THREAD_PALETTE.length];
    }
  }

  // Build two separate order lookup sets keyed exchange:normalizedPair:side
  // slSet  — genuine stop-loss orders only (stop market/limit, or reduceOnly limit)
  // tpSet  — take-profit orders (TP suppresses TP badge but NOT the SL glow)
  const slSet = new Set();
  const tpSet = new Set();
  if (lastData) {
    [...(lastData.hyperliquid?.orders || []), ...(lastData.binance?.orders || [])].forEach(o => {
      const t   = (o.type || '').toLowerCase();
      const key = `${o.exchange}:${normalizePairKey(o.pair)}:${o.side}`;
      if (t.includes('take profit')) {
        tpSet.add(key);                         // TP only — does NOT count as SL
      } else if (o.reduceOnly || t.includes('stop')) {
        slSet.add(key);                         // genuine stop / reduceOnly = real SL
      }
    });
  }

  const compact = orderedPositions.length > 10;

  const tiles = orderedPositions.map(p => {
    const key = normalizePairKey(p.pair);
    const tc = threadColorMap[key];
    const dist = liqDist(p);
    const distCls = dist < 10 ? 'danger' : dist < 30 ? 'warning' : 'success';
    const barWidth = dist < 999 ? Math.max(0, Math.min(100, 100 - dist)) : 0;
    const barColor = dist < 10 ? 'var(--danger)' : dist < 30 ? 'var(--warning)' : 'var(--success)';
    const costDay = fundingPerDay(p);
    const exchColor = p.exchange === 'hyperliquid' ? 'var(--hl)' : 'var(--bn)';
    const exchLabel = p.exchange === 'hyperliquid' ? 'HL' : 'BN';
    const focusColor = tc || (p.exchange === 'hyperliquid' ? '#7f77dd' : '#ef9f27');
    const threadAttrs = tc ? ` data-thread="${key}" data-thread-color="${tc}"` : '';
    const outlineStyle = tc ? `outline:1.5px solid ${tc}50;outline-offset:-1px;` : '';
    const threadDot = tc ? `<span style="width:5px;height:5px;border-radius:50%;background:${tc};flex-shrink:0;opacity:0.9;box-shadow:0 0 4px ${tc}88"></span>` : '';

    const isHedged = !!tc;
    const slSide = p.side === 'Long' ? 'Sell' : 'Buy';
    const orderKey = `${p.exchange}:${key}:${slSide}`;
    const hasStopLoss = slSet.has(orderKey);   // only real stop orders count
    // Show the SL glow if: not hedged AND no genuine stop order (TP alone does NOT suppress it)
    const noSlBadge = (!isHedged && !hasStopLoss)
      ? `<span class="sl-alert" title="No stop loss order detected" style="width:9px;height:9px;border-radius:50%;border:1.5px solid var(--danger);display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;margin-left:auto"><span style="width:3px;height:3px;border-radius:50%;background:var(--danger);display:block"></span></span>`
      : '';

    return `<div class="pos-tile" draggable="true" data-pos-id="${posId(p)}"${threadAttrs} data-focus-color="${focusColor}" style="${outlineStyle}" data-pos='${JSON.stringify({pair:p.pair,side:p.side,entry:p.entry,mark:p.mark,sizeUsd:p.sizeUsd,leverage:p.leverage,exchange:p.exchange})}'>
      <div class="ptile-head">
        <span class="ptile-pair">${p.pair}</span>
        ${threadDot}
        <span style="font-size:9px;font-weight:600;color:${exchColor};border:0.5px solid ${exchColor};border-radius:3px;padding:1px 4px;flex-shrink:0">${exchLabel}</span>
        ${sideBadge(p.side)}
        <span style="font-size:10px;color:var(--text3)">${p.leverage}</span>
        ${noSlBadge}
      </div>
      <div class="ptile-mark">${fmtPrice(p.mark)}</div>
      <div class="ptile-mark-sub">current price</div>
      <div style="height:5px;background:var(--border);border-radius:3px;margin:8px 0 3px;overflow:hidden">
        <div style="height:100%;border-radius:3px;width:${barWidth}%;background:${barColor};transition:width .4s"></div>
      </div>
      <div style="font-size:10px;color:var(--${distCls});margin-bottom:7px;display:flex;justify-content:space-between;align-items:center"><span>${dist < 999 ? fmt(dist,1)+'% to liquidation' : 'No liquidation price'}</span>${dist < 999 ? `<span style="color:${barColor};font-size:10px">Liq ${fmtPrice(p.liqPrice)}</span>` : ''}</div>
      <div class="ptile-rows">
        <div class="ptile-row"><span class="ptile-label">Size</span><span>${p.size} <span style="color:var(--text3)">(${fmtUsd(p.sizeUsd)})</span></span></div>
        <div class="ptile-row"><span class="ptile-label">Entry</span><span>${fmtPrice(p.entry)}</span></div>

        <div class="ptile-row"><span class="ptile-label">uPnL</span><span>${fmtPnl(p.upnl)}</span></div>
        ${!compact ? `<div class="ptile-row"><span class="ptile-label">Funding / ${fundingIntervalOf(p)}h</span><span>${p.funding8h}</span></div>` : ''}
        ${!compact ? `<div class="ptile-row"><span class="ptile-label">Daily funding</span><span>${fmtPnl(costDay)}</span></div>` : ''}
      </div>
    </div>`;
  }).join('');

  return `<div class="pos-tile-grid-wrap"><div class="pos-tile-grid" id="ptile-grid">${tiles}</div><svg id="thread-svg" aria-hidden="true"></svg></div>`;
}


function orderTypeBadge(o) {
  const t = (o.type || '').toLowerCase();
  if (t.includes('take profit')) return badge(o.type, 'b-long');
  if (t.includes('stop'))        return badge(o.type, 'b-short');
  if (t === 'limit')             return `<span style="color:var(--text2)">${o.type}</span>`;
  return `<span style="color:var(--text2)">${o.type}</span>`;
}

function renderOrdersFor(orders) {
  if (!orders.length) return '<p style="font-size:12px;color:var(--text3);padding:8px 0">No open orders</p>';
  // Determine if any order has a stopPrice so we conditionally show the Trigger column
  const hasStopPrices = orders.some(o => o.stopPrice && o.stopPrice > 0);
  return `<div class="tbl-wrap"><table>
    <tr>
      <th>Pair</th><th>Side</th><th>Type</th><th>Price</th>${hasStopPrices ? '<th>Trigger</th>' : ''}<th>Size</th><th>Reduce Only</th>
    </tr>
    ${orders.map(o => {
      const exchColor = o.exchange === 'hyperliquid' ? 'var(--hl)' : 'var(--bn)';
      const exchLabel = o.exchange === 'hyperliquid' ? 'HL' : 'BN';
      const t = (o.type || '').toLowerCase();
      // For pure stop/TP market orders the limit price is 0 — show trigger instead in Price col
      const priceDisplay = (o.price && o.price > 0) ? fmtUsd(o.price) : '<span style="color:var(--text3)">Market</span>';
      const triggerDisplay = (o.stopPrice && o.stopPrice > 0)
        ? `<span style="color:${t.includes('stop') ? 'var(--danger)' : 'var(--success)'};font-weight:500">${fmtUsd(o.stopPrice)}</span>`
        : '<span style="color:var(--text3)">—</span>';
      return `<tr>
      <td><span class="pair">${o.pair}</span><div class="pair-sub" style="display:flex;align-items:center;gap:4px"><span style="font-size:9px;font-weight:600;color:${exchColor}">${exchLabel}</span></div></td>
      <td>${sideBadge(o.side)}</td>
      <td>${orderTypeBadge(o)}</td>
      <td>${priceDisplay}</td>
      ${hasStopPrices ? `<td>${triggerDisplay}</td>` : ''}
      <td>${o.size}</td>
      <td>${o.reduceOnly ? badge('Reduce', 'b-warn') : '<span style="color:var(--text3)">—</span>'}</td>
    </tr>`;
    }).join('')}
  </table></div>`;
}
