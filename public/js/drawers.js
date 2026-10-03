// drawers.js — the exposure and uPnL drawers.

// ── Exposure Drawer ───────────────────────────────────────────────────────
function openExpDrawer() {
  if (!lastData) return;
  document.getElementById('expDrawerBody').innerHTML = buildExposureDrawerContent(lastData);
  document.getElementById('expOverlay').classList.add('open');
  document.getElementById('expDrawer').classList.add('open');
}
function closeExpDrawer(e) {
  if (e && e.target !== document.getElementById('expOverlay')) return;
  closeExpDrawerForce();
}
function closeExpDrawerForce() {
  document.getElementById('expOverlay').classList.remove('open');
  document.getElementById('expDrawer').classList.remove('open');
}

function buildExposureDrawerContent(data) {
  const allPos = [
    ...data.hyperliquid.positions,
    ...data.binance.positions
  ];

  if (!allPos.length) return `<p style="font-size:12px;color:var(--text3)">No open positions.</p>`;

  // ── totals ────────────────────────────────────────────────────────────
  const gross     = allPos.reduce((s, p) => s + p.sizeUsd, 0);
  const longExp   = allPos.filter(p => p.side === 'Long').reduce((s, p)  => s + p.sizeUsd, 0);
  const shortExp  = allPos.filter(p => p.side === 'Short').reduce((s, p) => s + p.sizeUsd, 0);
  const netExp    = longExp - shortExp;
  const longPct   = gross > 0 ? longExp  / gross * 100 : 50;
  const shortPct  = gross > 0 ? shortExp / gross * 100 : 50;
  const netDir    = netExp >= 0 ? 'Net Long' : 'Net Short';
  const netCol    = netExp >= 0 ? 'var(--success)' : 'var(--danger)';

  document.getElementById('expDrawerSub').textContent =
    `${allPos.length} position${allPos.length !== 1 ? 's' : ''} · as of last refresh`;

  // ── 1. summary strip ─────────────────────────────────────────────────
  const summaryHtml = `
    <div class="upnl-summary-strip">
      <div class="upnl-sum-cell">
        <div class="upnl-sum-label">Gross</div>
        <div class="upnl-sum-val">${fmtUsd(gross)}</div>
      </div>
      <div class="upnl-sum-cell">
        <div class="upnl-sum-label">${netDir}</div>
        <div class="upnl-sum-val" style="color:${netCol}">${fmtUsd(Math.abs(netExp))}</div>
      </div>
      <div class="upnl-sum-cell">
        <div class="upnl-sum-label">Positions</div>
        <div class="upnl-sum-val">${allPos.length}</div>
      </div>
    </div>`;

  // ── 2. long / short balance bar ───────────────────────────────────────
  const longLabel  = longPct  > 14 ? `L ${fmt(longPct,0)}%`  : '';
  const shortLabel = shortPct > 14 ? `S ${fmt(shortPct,0)}%` : '';
  const lsHtml = `
    <div>
      <div class="upnl-section-title">Long / Short balance</div>
      <div class="exp-ls-track">
        <div class="exp-ls-long"  style="width:${longPct.toFixed(1)}%"> <span class="exp-ls-lbl">${longLabel}</span></div>
        <div class="exp-ls-short" style="width:${shortPct.toFixed(1)}%"><span class="exp-ls-lbl">${shortLabel}</span></div>
      </div>
      <div style="display:flex;justify-content:space-between;margin-top:6px;font-size:10px">
        <span style="display:flex;align-items:center;gap:5px">
          <span style="width:7px;height:7px;border-radius:50%;background:var(--success);display:inline-block"></span>
          <span style="color:var(--text2)">Long</span>
          <span style="font-weight:600;color:var(--success)">${fmtUsd(longExp)}</span>
        </span>
        <span style="display:flex;align-items:center;gap:5px">
          <span style="font-weight:600;color:var(--danger)">${fmtUsd(shortExp)}</span>
          <span style="color:var(--text2)">Short</span>
          <span style="width:7px;height:7px;border-radius:50%;background:var(--danger);display:inline-block"></span>
        </span>
      </div>
    </div>`;

  // ── 3. per-position notional bars (ranked by size) ────────────────────
  const posSorted = [...allPos].sort((a, b) => b.sizeUsd - a.sizeUsd);
  const maxSize   = posSorted[0].sizeUsd || 1;

  const posRows = posSorted.map(p => {
    const pct       = (p.sizeUsd / maxSize) * 100;
    const isLong    = p.side === 'Long';
    const barColor  = isLong ? 'var(--success)' : 'var(--danger)';
    const exchColor = p.exchange === 'hyperliquid' ? 'var(--hl)' : 'var(--bn)';
    const exchLabel = p.exchange === 'hyperliquid' ? 'HL' : 'BN';
    const lev       = p.leverage || '—';
    return `<div class="exp-pos-row">
      <div class="exp-pos-pair" title="${p.pair}">
        <span style="font-size:9px;font-weight:700;color:${exchColor};margin-right:2px">${exchLabel}</span>${p.pair.replace(/-PERP$/i,'').replace(/\/USDT?$/i,'')}
      </div>
      <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">
        <span style="font-size:9px;padding:1px 4px;border-radius:3px;background:${isLong?'var(--green-bg)':'var(--red-bg)'};color:${isLong?'var(--green)':'var(--red)'};font-weight:600">${p.side}</span>
      </div>
      <div class="exp-pos-track">
        <div class="exp-pos-fill" style="width:${pct.toFixed(1)}%;background:${barColor};opacity:0.75"></div>
      </div>
      <div class="exp-pos-val">${fmtUsd(p.sizeUsd)}</div>
      <div class="exp-pos-lev">${lev}</div>
    </div>`;
  }).join('');

  const posHtml = `
    <div>
      <div class="upnl-section-title">By position <span style="font-weight:400;opacity:.6;text-transform:none;letter-spacing:0">— largest first</span></div>
      <div style="display:flex;justify-content:flex-end;gap:4px;margin-bottom:5px">
        <span style="font-size:10px;color:var(--text3);width:62px;text-align:right">Notional</span>
        <span style="font-size:10px;color:var(--text3);width:24px;text-align:right">Lev</span>
      </div>
      ${posRows}
    </div>`;

  // ── 4. pair concentration — grouped stacked bars ──────────────────────
  // Group by normalised pair key, accumulate long/short per group
  const pairMap = {};
  allPos.forEach(p => {
    const key = normalizePairKey(p.pair);
    if (!pairMap[key]) pairMap[key] = { long: 0, short: 0, total: 0 };
    if (p.side === 'Long')  pairMap[key].long  += p.sizeUsd;
    else                    pairMap[key].short += p.sizeUsd;
    pairMap[key].total += p.sizeUsd;
  });
  const pairsSorted = Object.entries(pairMap).sort((a, b) => b[1].total - a[1].total);
  const maxPairTotal = pairsSorted[0]?.[1].total || 1;

  const pairRows = pairsSorted.map(([key, g]) => {
    const barW     = (g.total / maxPairTotal) * 100;
    const longW    = g.total > 0 ? (g.long  / g.total) * barW : 0;
    const shortW   = g.total > 0 ? (g.short / g.total) * barW : 0;
    const isHedged = g.long > 0 && g.short > 0;
    const hedgeBadge = isHedged
      ? `<span style="font-size:8px;padding:1px 4px;border-radius:3px;background:var(--purple-bg);color:var(--purple);font-weight:600">Hedged</span>`
      : '';
    return `<div class="exp-pair-row">
      <div class="exp-pair-head">
        <span class="exp-pair-name">${key} ${hedgeBadge}</span>
        <span class="exp-pair-total">${fmtUsd(g.total)} · ${fmt(g.total/gross*100,1)}%</span>
      </div>
      <div style="height:12px;border-radius:3px;overflow:hidden;background:var(--surface2);display:flex">
        ${longW  > 0 ? `<div style="width:${longW.toFixed(1)}%;background:var(--success);height:100%;display:flex;align-items:center;padding-left:5px"><span style="font-size:8px;font-weight:700;color:rgba(255,255,255,0.85);white-space:nowrap;overflow:hidden">${longW > 12 ? 'L' : ''}</span></div>` : ''}
        ${shortW > 0 ? `<div style="width:${shortW.toFixed(1)}%;background:var(--danger); height:100%;display:flex;align-items:center;justify-content:flex-end;padding-right:5px"><span style="font-size:8px;font-weight:700;color:rgba(255,255,255,0.85);white-space:nowrap;overflow:hidden">${shortW > 12 ? 'S' : ''}</span></div>` : ''}
        <div style="flex:1;background:var(--surface2)"></div>
      </div>
      ${isHedged ? `<div style="display:flex;justify-content:space-between;font-size:9px;color:var(--text3);margin-top:2px"><span style="color:var(--success)">L ${fmtUsd(g.long)}</span><span style="color:var(--danger)">S ${fmtUsd(g.short)}</span></div>` : ''}
    </div>`;
  }).join('');

  const concHtml = `
    <div>
      <div class="upnl-section-title">Pair concentration <span style="font-weight:400;opacity:.6;text-transform:none;letter-spacing:0">— % of gross</span></div>
      ${pairRows}
    </div>`;

  return summaryHtml + lsHtml + posHtml + concHtml;
}

// ── uPnL Drawer ───────────────────────────────────────────────────────────
function openUpnlDrawer() {
  if (!lastData) return;
  const overlay = document.getElementById('upnlOverlay');
  const drawer  = document.getElementById('upnlDrawer');
  document.getElementById('upnlDrawerBody').innerHTML = buildUpnlDrawerContent(lastData);
  overlay.classList.add('open');
  drawer.classList.add('open');
}

function closeUpnlDrawer(e) {
  // only close when clicking the backdrop itself
  if (e && e.target !== document.getElementById('upnlOverlay')) return;
  closeUpnlDrawerForce();
}

function closeUpnlDrawerForce() {
  document.getElementById('upnlOverlay').classList.remove('open');
  document.getElementById('upnlDrawer').classList.remove('open');
}

function buildUpnlDrawerContent(data) {
  const allPos = [
    ...data.hyperliquid.positions.map(p => ({ ...p, exchange: 'hyperliquid' })),
    ...data.binance.positions.map(p => ({ ...p, exchange: 'binance' }))
  ];

  const getLev    = p => parseFloat((p.leverage || '1').replace('×','').replace('x','')) || 1;
  const getMargin = p => (p.sizeUsd || 0) / getLev(p);
  const getRoi    = p => getMargin(p) > 0 ? (p.upnl || 0) / getMargin(p) * 100 : 0;

  const totalUpnl   = allPos.reduce((s, p) => s + (p.upnl || 0), 0);
  const totalMargin = allPos.reduce((s, p) => s + getMargin(p), 0);
  const overallRoi  = totalMargin > 0 ? (totalUpnl / totalMargin) * 100 : 0;
  const winners     = allPos.filter(p => (p.upnl || 0) > 0);
  const losers      = allPos.filter(p => (p.upnl || 0) < 0);

  document.getElementById('upnlDrawerSub').textContent =
    `${allPos.length} position${allPos.length !== 1 ? 's' : ''} · as of last refresh`;

  const sign   = n => n >= 0 ? '+' : '−';
  const col    = n => n >= 0 ? 'var(--success)' : 'var(--danger)';
  const colCls = n => n >= 0 ? 'up' : 'dn';
  const RAW_SUCCESS = '#1d9e75';
  const RAW_DANGER  = '#e24b4a';

  // ── 1. Summary strip ──────────────────────────────────────────────────
  const summaryHtml = `
    <div class="upnl-summary-strip">
      <div class="upnl-sum-cell">
        <div class="upnl-sum-label">Total uPnL</div>
        <div class="upnl-sum-val ${colCls(totalUpnl)}">${sign(totalUpnl)}${fmtUsd(Math.abs(totalUpnl))}</div>
      </div>
      <div class="upnl-sum-cell">
        <div class="upnl-sum-label">ROI on margin</div>
        <div class="upnl-sum-val ${colCls(overallRoi)}">${sign(overallRoi)}${fmt(Math.abs(overallRoi), 2)}%</div>
      </div>
      <div class="upnl-sum-cell">
        <div class="upnl-sum-label">W / L</div>
        <div class="upnl-sum-val" style="font-size:15px">
          <span style="color:var(--success)">${winners.length}</span><span style="color:var(--text3);font-weight:400;font-size:12px"> / </span><span style="color:var(--danger)">${losers.length}</span>
        </div>
      </div>
    </div>`;

  if (!allPos.length) return summaryHtml + `<p style="font-size:12px;color:var(--text3)">No positions.</p>`;

  // ── 2. Treemap — area ∝ |uPnL|, colour = direction ───────────────────
  // Simple squarified-ish layout: sort desc by |upnl|, fill rows greedily
  const tmSorted = [...allPos].sort((a, b) => Math.abs(b.upnl||0) - Math.abs(a.upnl||0));
  const totalAbs  = tmSorted.reduce((s, p) => s + Math.abs(p.upnl || 0), 0) || 1;

  // Each cell gets a flex-grow proportional to |upnl| — wrap in a flex container
  // We split into rows of ~3 so shapes stay readable
  const ROW_SIZE = Math.ceil(tmSorted.length / Math.ceil(tmSorted.length / 3));
  const rows = [];
  for (let i = 0; i < tmSorted.length; i += ROW_SIZE) rows.push(tmSorted.slice(i, i + ROW_SIZE));

  const tmRows = rows.map(row => {
    const cells = row.map(p => {
      const upnl    = p.upnl || 0;
      const isPos   = upnl >= 0;
      const weight  = Math.abs(upnl) / totalAbs;
      const roi     = getRoi(p);
      const intensity = Math.min(Math.abs(upnl) / (Math.abs(tmSorted[0]?.upnl) || 1), 1);
      const baseR   = isPos ? 29  : 226;
      const baseG   = isPos ? 158 : 75;
      const baseB   = isPos ? 117 : 74;
      const alpha   = 0.25 + intensity * 0.65;
      const bg      = `rgba(${baseR},${baseG},${baseB},${alpha.toFixed(2)})`;
      const shortName = p.pair.replace(/-PERP$/i,'').replace(/\/USDT?$/i,'');
      const exchLabel = p.exchange === 'hyperliquid' ? 'HL' : 'BN';
      const minH    = weight > 0.12 ? 64 : 48;
      return `<div style="flex:${(weight*100).toFixed(2)};min-width:60px;min-height:${minH}px;background:${bg};border-radius:5px;padding:7px 8px;display:flex;flex-direction:column;justify-content:space-between;cursor:default;transition:filter .15s;border:1px solid rgba(255,255,255,0.06)"
        title="${p.pair} · ${p.side} · ${sign(upnl)}${fmtUsd(Math.abs(upnl))} · ROI ${sign(roi)}${fmt(Math.abs(roi),2)}%"
        onmouseenter="this.style.filter='brightness(1.18)'" onmouseleave="this.style.filter=''">
        <div style="font-size:9px;font-weight:700;color:rgba(255,255,255,0.65)">${exchLabel} · ${p.side[0]}</div>
        <div>
          <div style="font-size:10px;font-weight:700;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${shortName}</div>
          <div style="font-size:${weight > 0.1 ? 11 : 9}px;font-weight:700;color:#fff">${sign(upnl)}${fmtUsd(Math.abs(upnl))}</div>
          ${weight > 0.08 ? `<div style="font-size:9px;color:rgba(255,255,255,0.65)">${sign(roi)}${fmt(Math.abs(roi),2)}%</div>` : ''}
        </div>
      </div>`;
    }).join('');
    return `<div style="display:flex;gap:4px;margin-bottom:4px">${cells}</div>`;
  }).join('');

  const treemapHtml = `
    <div>
      <div class="upnl-section-title">uPnL treemap <span style="font-weight:400;opacity:.6;text-transform:none;letter-spacing:0">— area = magnitude · colour = direction</span></div>
      <div style="margin-bottom:2px">${tmRows}</div>
      <div style="display:flex;gap:16px;font-size:10px;color:var(--text3)">
        <span style="display:flex;align-items:center;gap:4px"><span style="width:8px;height:8px;border-radius:2px;background:rgba(29,158,117,0.7);display:inline-block"></span>Profit</span>
        <span style="display:flex;align-items:center;gap:4px"><span style="width:8px;height:8px;border-radius:2px;background:rgba(226,75,74,0.7);display:inline-block"></span>Loss</span>
        <span style="margin-left:auto">Brighter = larger</span>
      </div>
    </div>`;

  // ── 3. Scatter plot — uPnL (x) vs ROI% (y) per position ─────────────
  const W = 320, H = 140;
  const PAD = { t: 12, r: 12, b: 28, l: 48 };
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;

  const upnlVals = allPos.map(p => p.upnl || 0);
  const roiAll   = allPos.map(getRoi);
  const minUpnl  = Math.min(...upnlVals, 0);
  const maxUpnl  = Math.max(...upnlVals, 0);
  const minRoi   = Math.min(...roiAll, 0);
  const maxRoi   = Math.max(...roiAll, 0);
  const rangeUpnl = maxUpnl - minUpnl || 1;
  const rangeRoi  = maxRoi  - minRoi  || 1;

  const sx = v => PAD.l + ((v - minUpnl) / rangeUpnl) * innerW;
  const sy = v => PAD.t + (1 - (v - minRoi) / rangeRoi) * innerH;
  const zeroX = sx(0).toFixed(1);
  const zeroY = sy(0).toFixed(1);

  const dots = allPos.map(p => {
    const x = sx(p.upnl || 0).toFixed(1);
    const y = sy(getRoi(p)).toFixed(1);
    const c = (p.upnl || 0) >= 0 ? RAW_SUCCESS : RAW_DANGER;
    const exchColor = p.exchange === 'hyperliquid' ? 'var(--hl)' : 'var(--bn)';
    const shortName = p.pair.replace(/-PERP$/i,'').replace(/\/USDT?$/i,'');
    const r = Math.max(4, Math.min(9, 4 + p.sizeUsd / 20000));
    return `<g>
      <circle cx="${x}" cy="${y}" r="${r.toFixed(1)}" fill="${c}" opacity="0.75" stroke="${exchColor}" stroke-width="1.5"/>
      <text x="${x}" y="${(parseFloat(y)-parseFloat(r)-2).toFixed(1)}" text-anchor="middle" font-size="7" fill="var(--text2)">${shortName}</text>
    </g>`;
  }).join('');

  // axis labels
  const xLabels = [minUpnl, 0, maxUpnl].filter((v,i,a)=>a.indexOf(v)===i).map(v => {
    const x = sx(v).toFixed(1);
    const lbl = v===0 ? '$0' : `${v>=0?'+':''}${fmtUsd(Math.abs(v))}`;
    return `<text x="${x}" y="${(H-8).toFixed(0)}" text-anchor="middle" font-size="8" fill="var(--text3)">${lbl}</text>
      <line x1="${x}" y1="${PAD.t}" x2="${x}" y2="${(H-PAD.b).toFixed(0)}" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="2 2"/>`;
  }).join('');

  const yLabels = [minRoi, 0, maxRoi].filter((v,i,a)=>a.indexOf(v)===i).map(v => {
    const y = sy(v).toFixed(1);
    const lbl = `${v>=0?'+':''}${fmt(Math.abs(v),1)}%`;
    return `<text x="${(PAD.l-4).toFixed(0)}" y="${y}" text-anchor="end" dominant-baseline="middle" font-size="8" fill="var(--text3)">${lbl}</text>
      <line x1="${PAD.l}" y1="${y}" x2="${(W-PAD.r).toFixed(0)}" y2="${y}" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="2 2"/>`;
  }).join('');

  const scatterHtml = `
    <div>
      <div class="upnl-section-title">uPnL vs ROI scatter <span style="font-weight:400;opacity:.6;text-transform:none;letter-spacing:0">— dot size = notional</span></div>
      <div style="position:relative;width:100%">
        <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:${H}px;overflow:visible">
          ${yLabels}
          ${xLabels}
          <!-- quadrant lines -->
          <line x1="${zeroX}" y1="${PAD.t}" x2="${zeroX}" y2="${(H-PAD.b).toFixed(0)}" stroke="var(--border2)" stroke-width="1"/>
          <line x1="${PAD.l}" y1="${zeroY}" x2="${(W-PAD.r).toFixed(0)}" y2="${zeroY}" stroke="var(--border2)" stroke-width="1"/>
          ${dots}
          <!-- axis labels -->
          <text x="${(W/2).toFixed(0)}" y="${(H-1).toFixed(0)}" text-anchor="middle" font-size="8" fill="var(--text3)">uPnL ($)</text>
          <text x="9" y="${(H/2).toFixed(0)}" text-anchor="middle" font-size="8" fill="var(--text3)" transform="rotate(-90,9,${(H/2).toFixed(0)})">ROI %</text>
        </svg>
      </div>
    </div>`;

  // ── 4. Ranked leaderboard — sorted by ROI%, each row is a self-contained ──
  //        stat strip: rank · pair · side badge · ROI pill · uPnL · progress arc
  const lbSorted = [...allPos].sort((a, b) => getRoi(b) - getRoi(a));
  const maxAbsUpnl = Math.max(...lbSorted.map(p => Math.abs(p.upnl || 0)), 0.01);

  // Mini SVG arc: draws a partial circle (stroke-dasharray trick) 0–100%
  const arc = (pct, color) => {
    const r = 10, circ = 2 * Math.PI * r;
    const dash = (Math.min(pct, 100) / 100 * circ).toFixed(2);
    const gap  = (circ - parseFloat(dash)).toFixed(2);
    return `<svg width="28" height="28" viewBox="0 0 28 28" style="flex-shrink:0;transform:rotate(-90deg)">
      <circle cx="14" cy="14" r="${r}" fill="none" stroke="var(--border)" stroke-width="3.5"/>
      <circle cx="14" cy="14" r="${r}" fill="none" stroke="${color}" stroke-width="3.5"
        stroke-dasharray="${dash} ${gap}" stroke-linecap="round"/>
    </svg>`;
  };

  const lbRows = lbSorted.map((p, i) => {
    const upnl      = p.upnl || 0;
    const roi       = getRoi(p);
    const isPos     = upnl >= 0;
    const exchColor = p.exchange === 'hyperliquid' ? 'var(--hl)' : 'var(--bn)';
    const exchLabel = p.exchange === 'hyperliquid' ? 'HL' : 'BN';
    const shortName = p.pair.replace(/-PERP$/i,'').replace(/\/USDT?$/i,'');
    const roiColor  = isPos ? 'var(--success)' : 'var(--danger)';
    const roiBg     = isPos ? 'var(--green-bg)' : 'var(--red-bg)';
    const roiTxt    = isPos ? 'var(--green)' : 'var(--red)';
    // bar width: proportion of max |uPnL| across all positions
    const barW      = (Math.abs(upnl) / maxAbsUpnl * 100).toFixed(1);
    // arc pct: |ROI| as % of the max |ROI| in the set (so best = full circle)
    const maxAbsRoi = Math.max(...lbSorted.map(p => Math.abs(getRoi(p))), 0.01);
    const arcPct    = Math.abs(roi) / maxAbsRoi * 100;
    const rankColor = i === 0 ? '#f5a623' : i === 1 ? '#a0a099' : i === 2 ? '#c07a3a' : 'var(--text3)';

    return `<div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:0.5px solid var(--border)">
      <!-- rank -->
      <span style="font-size:10px;font-weight:700;color:${rankColor};width:14px;text-align:center;flex-shrink:0">${i+1}</span>
      <!-- arc progress -->
      ${arc(arcPct, roiColor)}
      <!-- pair + exchange -->
      <div style="min-width:0;flex:1">
        <div style="display:flex;align-items:center;gap:5px;margin-bottom:3px">
          <span style="font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${shortName}</span>
          <span style="font-size:8px;font-weight:700;color:${exchColor};border:0.5px solid ${exchColor};border-radius:3px;padding:0 3px;flex-shrink:0">${exchLabel}</span>
          <span style="font-size:8px;font-weight:600;padding:1px 5px;border-radius:10px;background:${roiBg};color:${roiTxt};flex-shrink:0">${roi>=0?'+':''}${fmt(Math.abs(roi),2)}%</span>
        </div>
        <!-- uPnL progress bar -->
        <div style="height:4px;background:var(--surface2);border-radius:2px;overflow:hidden">
          <div style="height:100%;width:${barW}%;background:${roiColor};border-radius:2px;transition:width .4s;opacity:0.8"></div>
        </div>
      </div>
      <!-- uPnL value -->
      <span style="font-size:11px;font-weight:700;color:${roiColor};flex-shrink:0;text-align:right;min-width:60px">${upnl>=0?'+':''}${fmtUsd(Math.abs(upnl))}</span>
    </div>`;
  }).join('');

  const leaderboardHtml = `
    <div>
      <div class="upnl-section-title">ROI leaderboard <span style="font-weight:400;opacity:.6;text-transform:none;letter-spacing:0">— arc = ROI% · bar = uPnL magnitude</span></div>
      ${lbRows}
    </div>`;

  return summaryHtml + treemapHtml + scatterHtml + leaderboardHtml;
}
