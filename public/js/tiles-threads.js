// tiles-threads.js — hedge popups, tile drag-to-reorder, tile focus and the hedge-thread SVG
// drawn between matched legs.

// ── Hedge popup helpers ───────────────────────────────────────────────────
function buildHedgePopup(srcPos, tgtPos) {
  const longP  = srcPos.side === 'Long' ? srcPos : tgtPos;
  const shortP = srcPos.side === 'Short' ? srcPos : tgtPos;

  const longSz  = longP.sizeUsd;
  const shortSz = shortP.sizeUsd;
  const total   = longSz + shortSz;
  const netExp  = longSz - shortSz;             // positive = net long, negative = net short
  const smaller = Math.min(longSz, shortSz);
  const hedgeRatio = total > 0 ? (smaller / Math.max(longSz, shortSz)) * 100 : 0;
  const longPct  = total > 0 ? (longSz  / total) * 100 : 50;
  const shortPct = total > 0 ? (shortSz / total) * 100 : 50;

  const netUpnl  = (longP.upnl || 0) + (shortP.upnl || 0);
  const netUpnlCol = netUpnl >= 0 ? 'var(--success)' : 'var(--danger)';

  // Funding net: if hedged, long pays when rate positive, short receives
  const longFundingDay  = fundingPerDay(longP);
  const shortFundingDay = fundingPerDay(shortP);
  const netFundingDay   = longFundingDay + shortFundingDay;

  // Avg entry delta
  const entryDelta = shortP.entry - longP.entry;
  const entryDeltaCol = entryDelta >= 0 ? 'var(--success)' : 'var(--danger)';

  // Hedge quality label
  const label = hedgeRatio >= 95 ? 'Full hedge' : hedgeRatio >= 70 ? 'Partial hedge' : hedgeRatio >= 40 ? 'Light hedge' : 'Skewed';
  const labelCol = hedgeRatio >= 95 ? 'var(--success)' : hedgeRatio >= 70 ? 'var(--warning)' : 'var(--danger)';

  // Mini donut via conic-gradient
  const donutGrad = `conic-gradient(var(--success) ${longPct}%, var(--danger) ${longPct}% 100%)`;

  const sameExch = longP.exchange === shortP.exchange;
  const exchNote = sameExch ? '' : `<span style="font-size:9px;color:var(--text3);margin-left:auto">cross-exchange</span>`;

  return `
    <div class="hedge-popup-title">
      <div style="width:10px;height:10px;border-radius:50%;background:${labelCol};flex-shrink:0"></div>
      ${esc(longP.pair)} hedge
      ${exchNote}
    </div>
    <div class="hedge-popup-sub">${label} · ${fmt(hedgeRatio, 1)}% matched</div>

    <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
      <div class="hedge-ratio-ring" style="background:${donutGrad}">
        <div class="hedge-ratio-hole" style="color:${labelCol}">${fmt(hedgeRatio,0)}%</div>
      </div>
      <div style="flex:1;min-width:0">
        <div class="hedge-bar-wrap">
          <div class="hedge-bar-long"  style="width:${longPct}%"></div>
          <div class="hedge-bar-short" style="width:${shortPct}%"></div>
        </div>
        <div class="hedge-bar-labels">
          <span style="color:var(--success)">L ${fmtUsd(longSz)}</span>
          <span style="color:var(--danger)">S ${fmtUsd(shortSz)}</span>
        </div>
      </div>
    </div>

    <div class="hedge-rows">
      <div class="hedge-row">
        <span class="hedge-row-label">Net exposure</span>
        <span class="hedge-row-val" style="color:${netExp >= 0 ? 'var(--success)' : 'var(--danger)'}">
          ${netExp >= 0 ? 'Long' : 'Short'} ${fmtUsd(Math.abs(netExp))}
        </span>
      </div>
      <div class="hedge-row">
        <span class="hedge-row-label">Combined uPnL</span>
        <span class="hedge-row-val" style="color:${netUpnlCol}">${fmtPlusUsd(netUpnl)}</span>
      </div>
      <div class="hedge-row">
        <span class="hedge-row-label">Long entry</span>
        <span class="hedge-row-val">${fmtPrice(longP.entry)}</span>
      </div>
      <div class="hedge-row">
        <span class="hedge-row-label">Short entry</span>
        <span class="hedge-row-val">${fmtPrice(shortP.entry)}</span>
      </div>
      <div class="hedge-row">
        <span class="hedge-row-label">Entry spread</span>
        <span class="hedge-row-val" style="color:${entryDeltaCol}">${entryDelta > 0 ? '+' : entryDelta < 0 ? '−' : ''}${fmtPrice(Math.abs(entryDelta))}</span>
      </div>
      <div class="hedge-row">
        <span class="hedge-row-label">Net funding/day</span>
        <span class="hedge-row-val" style="color:${netFundingDay >= 0 ? 'var(--success)' : 'var(--danger)'}">
          ${fmtPlusUsd(netFundingDay)}
        </span>
      </div>
    </div>`;
}

let hedgePinned = false;

function positionHedgePopup(x, y) {
  const popup = document.getElementById('hedgePopup');
  const pw = 280, ph = 300;
  const left = x + 16 + pw > window.innerWidth  ? x - pw - 8 : x + 16;
  const top  = y + 16 + ph > window.innerHeight ? y - ph - 8 : y + 16;
  popup.style.left = left + 'px';
  popup.style.top  = top  + 'px';
}

function showHedgePopup(content, x, y, pinned = false) {
  const popup = document.getElementById('hedgePopup');
  const inner = document.getElementById('hedgePopupInner');
  // If already pinned, don't overwrite with hover
  if (hedgePinned && !pinned) return;
  // Clean up previous drag before re-initialising
  destroyHedgeDrag(popup);
  hedgePinned = pinned;
  inner.innerHTML = pinned
    ? `<button class="hedge-pin-close" onclick="hideHedgePopup(true)">&#x2715;</button>${content}`
    : content;
  popup.classList.toggle('pinned', pinned);
  popup.classList.add('show');
  positionHedgePopup(x, y);
  if (pinned) initHedgeDrag(popup);
}

function hideHedgePopup(force = false) {
  if (hedgePinned && !force) return;
  hedgePinned = false;
  const popup = document.getElementById('hedgePopup');
  popup.classList.remove('show', 'pinned');
  destroyHedgeDrag(popup);
}

function initHedgeDrag(popup) {
  const inner = document.getElementById('hedgePopupInner');
  let isDragging = false, startX = 0, startY = 0, origLeft = 0, origTop = 0;

  function onMouseDown(e) {
    // Ignore close button clicks
    if (e.target.classList.contains('hedge-pin-close') || e.target.closest('.hedge-pin-close')) return;
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    origLeft = parseInt(popup.style.left, 10) || 0;
    origTop  = parseInt(popup.style.top,  10) || 0;
    popup.classList.add('dragging-popup');
    e.preventDefault();
  }

  function onMouseMove(e) {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const pw = popup.offsetWidth, ph = popup.offsetHeight;
    const newLeft = Math.max(0, Math.min(window.innerWidth  - pw, origLeft + dx));
    const newTop  = Math.max(0, Math.min(window.innerHeight - ph, origTop  + dy));
    popup.style.left = newLeft + 'px';
    popup.style.top  = newTop  + 'px';
  }

  function onMouseUp() {
    if (!isDragging) return;
    isDragging = false;
    popup.classList.remove('dragging-popup');
  }

  inner.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  // Store cleanup refs on the popup element
  popup._dragCleanup = () => {
    inner.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  };
}

function destroyHedgeDrag(popup) {
  if (popup._dragCleanup) { popup._dragCleanup(); popup._dragCleanup = null; }
}

function onThreadClick(threadKey, x, y) {
  // If clicking the same thread that's already pinned, toggle it off
  const popup = document.getElementById('hedgePopup');
  if (hedgePinned && popup.dataset.threadKey === threadKey) {
    hideHedgePopup(true);
    return;
  }
  if (!lastData) return;
  const all = [...(lastData.hyperliquid?.positions||[]), ...(lastData.binance?.positions||[])];
  const matches = all.filter(p => normalizePairKey(p.pair) === threadKey);
  const longP  = matches.find(p => p.side === 'Long');
  const shortP = matches.find(p => p.side === 'Short');
  if (!longP || !shortP) return;
  const content = buildHedgePopup(longP, shortP);
  popup.dataset.threadKey = threadKey;
  showHedgePopup(content, x, y, true);
}

function isHedgePair(srcTile, tgtTile) {
  const a = positionById(srcTile.dataset.posId);
  const b = positionById(tgtTile.dataset.posId);
  return !!a && !!b && normalizePairKey(a.pair) === normalizePairKey(b.pair) && a.side !== b.side;
}

function initTileDrag() {
  const grid = document.getElementById('ptile-grid');
  if (!grid) return;
  let dragSrc = null;
  let hedgeTarget = null;

  grid.querySelectorAll('.pos-tile').forEach(tile => {
    tile.addEventListener('contextmenu', e => {
      showCtxMenu(e, positionById(tile.dataset.posId));
    });

    tile.addEventListener('dragstart', e => {
      dragSrc = tile;
      tileDragging = true;
      tile.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', tile.dataset.posId);
    });

    tile.addEventListener('dragend', () => {
      tile.classList.remove('dragging');
      grid.querySelectorAll('.pos-tile').forEach(t => {
        t.classList.remove('drag-over');
        t.classList.remove('hedge-target');
      });
      dragSrc = null;
      hedgeTarget = null;
      hideHedgePopup(true);
      tileDragging = false;
      resumeContent();
    });

    tile.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (tile === dragSrc) return;

      grid.querySelectorAll('.pos-tile').forEach(t => {
        t.classList.remove('drag-over');
        t.classList.remove('hedge-target');
      });

      if (isHedgePair(dragSrc, tile)) {
        tile.classList.add('hedge-target');
        hedgeTarget = tile;
        const srcPos = positionById(dragSrc.dataset.posId), tgtPos = positionById(tile.dataset.posId);
        if (srcPos && tgtPos) showHedgePopup(buildHedgePopup(srcPos, tgtPos), e.clientX, e.clientY, false);
        else hideHedgePopup(true);
      } else {
        tile.classList.add('drag-over');
        hedgeTarget = null;
        hideHedgePopup(true);
      }
    });

    tile.addEventListener('dragleave', e => {
      if (!tile.contains(e.relatedTarget)) {
        tile.classList.remove('drag-over');
        tile.classList.remove('hedge-target');
        if (hedgeTarget === tile) {
          hedgeTarget = null;
          hideHedgePopup(true);
        }
      }
    });

    tile.addEventListener('drop', e => {
      e.preventDefault();
      hideHedgePopup(true);
      if (!dragSrc || dragSrc === tile) return;
      // If it's a hedge pair — don't reorder, just dismiss
      if (isHedgePair(dragSrc, tile)) {
        tile.classList.remove('hedge-target');
        return;
      }
      const allTiles = [...grid.querySelectorAll('.pos-tile')];
      const srcIdx = allTiles.indexOf(dragSrc);
      const tgtIdx = allTiles.indexOf(tile);
      if (srcIdx < tgtIdx) grid.insertBefore(dragSrc, tile.nextSibling);
      else grid.insertBefore(dragSrc, tile);
      tileOrder = [...grid.querySelectorAll('.pos-tile')].map(t => t.dataset.posId);
      tile.classList.remove('drag-over');
      requestAnimationFrame(drawThreadLines);
    });
  });

  // Update popup position as mouse moves over the grid
  grid.addEventListener('dragover', e => {
    const popup = document.getElementById('hedgePopup');
    if (!popup.classList.contains('show')) return;
    const pw = 280, ph = 260;
    const left = e.clientX + 16 + pw > window.innerWidth  ? e.clientX - pw - 8 : e.clientX + 16;
    const top  = e.clientY + 16 + ph > window.innerHeight ? e.clientY - ph - 8 : e.clientY + 16;
    popup.style.left = left + 'px';
    popup.style.top  = top  + 'px';
  });

  // ── Double-tap / double-click to focus tile + thread ─────────────────
  const tapTimers = new WeakMap();
  grid.querySelectorAll('.pos-tile').forEach(tile => {
    // Double-click (desktop)
    tile.addEventListener('dblclick', e => {
      e.stopPropagation();
      focusTile(tile);
    });
    // Double-tap (mobile): two taps within 300 ms
    tile.addEventListener('touchend', e => {
      if (tapTimers.has(tile)) {
        clearTimeout(tapTimers.get(tile));
        tapTimers.delete(tile);
        e.preventDefault();   // prevent ghost click
        focusTile(tile);
      } else {
        const t = setTimeout(() => tapTimers.delete(tile), 300);
        tapTimers.set(tile, t);
      }
    });
  });

  // Click on empty grid area → clear focus
  grid.addEventListener('click', e => {
    if (!e.target.closest('.pos-tile')) clearTileFocus();
  });
}

// ── Tile focus / unfocus ──────────────────────────────────────────────────
// Unified focus state — either a tile posId (solo) or a threadKey (group)
let _focusedTileId  = null;   // posId of solo-focused tile (no thread)
let _focusedThreadKey = null; // threadKey when focus was entered via tile-with-thread or thread line

function _applyFocus(threadKey, soloTile) {
  const grid    = document.getElementById('ptile-grid');
  const wrapper = grid && grid.closest('.pos-tile-grid-wrap');
  if (!grid || !wrapper) return;

  _focusedThreadKey = threadKey;
  _focusedTileId    = soloTile ? soloTile.dataset.posId : null;

  // Mark tiles and apply per-tile focus color
  grid.querySelectorAll('.pos-tile').forEach(t => {
    const focused = threadKey ? t.dataset.thread === threadKey
                              : soloTile && t === soloTile;
    t.classList.toggle('tile-focused', !!focused);
    if (focused) {
      const c = t.dataset.focusColor || '#7f77dd';
      t.style.setProperty('--focus-color', c);
      // Convert hex to rgba for the glow
      const r = parseInt(c.slice(1,3),16), g = parseInt(c.slice(3,5),16), b = parseInt(c.slice(5,7),16);
      t.style.setProperty('--focus-glow', `rgba(${r},${g},${b},0.22)`);
    } else {
      t.style.removeProperty('--focus-color');
      t.style.removeProperty('--focus-glow');
    }
  });

  // Put focus class on the wrapper so both #ptile-grid and #thread-svg are in scope
  wrapper.classList.add('grid-wrap-focused');

  // Mark SVG thread paths, hit targets and dots
  const svg = document.getElementById('thread-svg');
  if (svg) {
    svg.querySelectorAll('.thread-path').forEach(p => {
      p.classList.toggle('thread-focused', !!threadKey && p.dataset.threadKey === threadKey);
    });
    svg.querySelectorAll('.thread-hit').forEach(h => {
      h.classList.toggle('thread-hit-focused', !!threadKey && h.dataset.threadKey === threadKey);
    });
    svg.querySelectorAll('circle').forEach(d => {
      d.classList.toggle('thread-dot-focused', !!threadKey && d.dataset.threadKey === threadKey);
    });
  }
}

function focusTile(tile) {
  const clickedId  = tile.dataset.posId;
  const threadKey  = tile.dataset.thread || null;

  // Toggle off if same tile/thread already focused
  if (threadKey && _focusedThreadKey === threadKey) { clearTileFocus(); return; }
  if (!threadKey && _focusedTileId === clickedId)   { clearTileFocus(); return; }

  _applyFocus(threadKey, threadKey ? null : tile);
}

function focusThread(threadKey) {
  // Toggle off if same thread already focused
  if (_focusedThreadKey === threadKey) { clearTileFocus(); return; }
  _applyFocus(threadKey, null);
}

function clearTileFocus() {
  _focusedTileId    = null;
  _focusedThreadKey = null;
  const grid    = document.getElementById('ptile-grid');
  if (!grid) return;
  const wrapper = grid.closest('.pos-tile-grid-wrap');
  if (wrapper) wrapper.classList.remove('grid-wrap-focused');
  grid.querySelectorAll('.pos-tile').forEach(t => {
    t.classList.remove('tile-focused');
    t.style.removeProperty('--focus-color');
    t.style.removeProperty('--focus-glow');
  });
  const svg = document.getElementById('thread-svg');
  if (svg) {
    svg.querySelectorAll('.thread-path').forEach(p => p.classList.remove('thread-focused'));
    svg.querySelectorAll('.thread-hit').forEach(h => h.classList.remove('thread-hit-focused'));
    svg.querySelectorAll('circle').forEach(d => d.classList.remove('thread-dot-focused'));
  }
}

function drawThreadLines() {
  const svg = document.getElementById('thread-svg');
  const grid = document.getElementById('ptile-grid');
  if (!svg || !grid) return;

  const gr = grid.getBoundingClientRect();
  const gw = gr.right - gr.left;

  // ── Build row buckets (group tiles by same top-coordinate ±4px) ──────────
  const allTiles = [...grid.querySelectorAll('.pos-tile')];
  const rowBuckets = [];
  allTiles.forEach(t => {
    const r = t.getBoundingClientRect();
    let b = rowBuckets.find(b => Math.abs(b.top - r.top) < 4);
    if (!b) { b = { top: r.top, bottom: r.bottom, tiles: [] }; rowBuckets.push(b); }
    b.bottom = Math.max(b.bottom, r.bottom);
    b.tiles.push({ el: t, rect: r });
  });
  rowBuckets.sort((a, b) => a.top - b.top);

  // Center-y of the gap between rows[i] and rows[i+1]
  const rowGapY = rowBuckets.map((b, i) =>
    i < rowBuckets.length - 1 ? (b.bottom + rowBuckets[i + 1].top) / 2 : null
  );

  function getRowIdx(el) {
    return rowBuckets.findIndex(b => b.tiles.some(t => t.el === el));
  }

  // Find an x (relative to grid) that lies in a column gap of every intermediate row.
  // Falls back to just outside the grid edge if no common gap exists.
  function findPassX(interRows, preferX) {
    if (!interRows.length) return preferX;
    const freeSets = interRows.map(row => {
      const occ = row.tiles.map(t => [t.rect.left - gr.left, t.rect.right - gr.left])
        .sort((a, b) => a[0] - b[0]);
      const free = [];
      let cur = 0;
      occ.forEach(([l, r]) => { if (l > cur + 2) free.push([cur, l]); cur = Math.max(cur, r); });
      if (cur < gw - 2) free.push([cur, gw]);
      return free;
    });
    // Intersect all free sets
    let common = freeSets[0];
    for (let i = 1; i < freeSets.length && common.length; i++) {
      const out = [];
      common.forEach(([a1, a2]) => freeSets[i].forEach(([b1, b2]) => {
        const l = Math.max(a1, b1), r = Math.min(a2, b2);
        if (r > l + 2) out.push([l, r]);
      }));
      common = out;
    }
    if (!common.length) return preferX < gw / 2 ? -14 : gw + 14;
    // Midpoint of the interval closest to preferX
    let best = (common[0][0] + common[0][1]) / 2;
    common.forEach(([l, r]) => { const m = (l + r) / 2; if (Math.abs(m - preferX) < Math.abs(best - preferX)) best = m; });
    return best;
  }

  // ── Gather thread pairs ───────────────────────────────────────────────────
  const groups = {};
  grid.querySelectorAll('[data-thread]').forEach(el => {
    const k = el.dataset.thread;
    if (!groups[k]) groups[k] = [];
    groups[k].push(el);
  });

  svg.innerHTML = '';

  const threads = [];
  Object.entries(groups).forEach(([threadKey, tiles]) => {
    if (tiles.length < 2) return;
    const color = tiles[0].dataset.threadColor;
    for (let i = 0; i < tiles.length - 1; i++) {
      for (let j = i + 1; j < tiles.length; j++) {
        const rA = tiles[i].getBoundingClientRect();
        const rB = tiles[j].getBoundingClientRect();
        const rowA = getRowIdx(tiles[i]);
        const rowB = getRowIdx(tiles[j]);
        const sameRow = Math.abs(rA.top - rB.top) < 4;
        const topRowIdx = Math.min(rowA, rowB);
        const botRowIdx = Math.max(rowA, rowB);
        // Road key for lane assignment
        const roadKey = sameRow ? `sr-${topRowIdx}` : `gap-${topRowIdx}-${botRowIdx}`;
        threads.push({ rA, rB, color, sameRow, rowA, rowB, topRowIdx, botRowIdx, roadKey, threadKey });
      }
    }
  });

  // Assign lanes so parallel threads don't overlap
  const byRoad = {};
  threads.forEach(t => { (byRoad[t.roadKey] = byRoad[t.roadKey] || []).push(t); });
  Object.values(byRoad).forEach(lane => lane.forEach((t, i) => { t.lane = i; t.laneCount = lane.length; }));

  const LANE_GAP = 3;

  threads.forEach(({ rA, rB, color, sameRow, rowA, rowB, topRowIdx, botRowIdx, lane, laneCount, threadKey }) => {
    let d, dotA, dotB;
    const lo = (lane - (laneCount - 1) / 2) * LANE_GAP;

    if (sameRow) {
      // Route above both tiles
      const leftR  = rA.left <= rB.left ? rA : rB;
      const rightR = rA.left <= rB.left ? rB : rA;
      const lx1 = leftR.left  + leftR.width  / 2 - gr.left;
      const ly1 = leftR.top   - gr.top;
      const lx2 = rightR.left + rightR.width / 2 - gr.left;
      const ly2 = rightR.top  - gr.top;
      const ry = ly1 - 5 - lane * LANE_GAP;
      d = `M ${lx1} ${ly1} L ${lx1} ${ry} L ${lx2} ${ry} L ${lx2} ${ly2}`;
      dotA = [lx1, ly1]; dotB = [lx2, ly2];
    } else {
      // Top/bottom tile geometry
      const topIsA = rowA <= rowB;
      const tR = topIsA ? rA : rB;
      const bR = topIsA ? rB : rA;
      const tx = tR.left + tR.width / 2 - gr.left;
      const ty = tR.bottom - gr.top;
      const bx = bR.left + bR.width / 2 - gr.left;
      const by = bR.top  - gr.top;
      dotA = [tx, ty]; dotB = [bx, by];

      if (botRowIdx === topRowIdx + 1) {
        // Adjacent rows — single horizontal highway through the row gap
        const gy = rowGapY[topRowIdx] - gr.top + lo;
        d = `M ${tx} ${ty} L ${tx} ${gy} L ${bx} ${gy} L ${bx} ${by}`;
      } else {
        // Multi-row span — route through column gaps of intermediate rows
        const interRows = rowBuckets.slice(topRowIdx + 1, botRowIdx);
        const passX = findPassX(interRows, (tx + bx) / 2) + lo;
        const topGY = rowGapY[topRowIdx]     - gr.top + lo;
        const botGY = rowGapY[botRowIdx - 1] - gr.top + lo;
        d = `M ${tx} ${ty} L ${tx} ${topGY} L ${passX} ${topGY} L ${passX} ${botGY} L ${bx} ${botGY} L ${bx} ${by}`;
      }
    }

    // Visible dashed path
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '1');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke-linecap', 'square');
    path.setAttribute('stroke-linejoin', 'miter');
    path.setAttribute('stroke-dasharray', '5 3');
    path.setAttribute('opacity', '0.6');
    path.classList.add('thread-path');
    path.dataset.threadKey = threadKey;
    path.style.animation = 'thread-march 1.2s linear infinite';
    path.style.transition = 'opacity .15s, stroke-width .15s';
    svg.appendChild(path);

    // Invisible wider hit-target path for click/hover
    const hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    hit.setAttribute('d', d);
    hit.setAttribute('stroke', 'transparent');
    hit.setAttribute('stroke-width', '10');
    hit.setAttribute('fill', 'none');
    hit.classList.add('thread-hit');
    // Store thread key on the element so click handler can look up positions
    hit.dataset.threadKey = threadKey;
    hit.addEventListener('mouseenter', () => { path.style.opacity = '1'; path.setAttribute('stroke-width', '2'); });
    hit.addEventListener('mouseleave', () => { path.style.opacity = '0.6'; path.setAttribute('stroke-width', '1'); });
    // Single click → hedge popup immediately; double-click → focus thread
    hit.addEventListener('click', e => {
      e.stopPropagation();
      onThreadClick(hit.dataset.threadKey, e.clientX, e.clientY);
    });
    hit.addEventListener('dblclick', e => {
      e.stopPropagation();
      // Hide popup that single-click may have just opened, then focus
      hideHedgePopup(true);
      focusThread(hit.dataset.threadKey);
    });
    svg.appendChild(hit);

    for (const [px, py] of [dotA, dotB]) {
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', px); dot.setAttribute('cy', py);
      dot.setAttribute('r', '2.8'); dot.setAttribute('fill', color);
      dot.setAttribute('opacity', '0.85');
      dot.dataset.threadKey = threadKey;
      svg.appendChild(dot);
    }
  });
}
