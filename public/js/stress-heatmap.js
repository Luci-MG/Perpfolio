// stress-heatmap.js — Stress's "Two coins at once": pool used across joint moves of two coins,
// with the liquidation and free-margin edges, the BTC-beta path and the current scenario.

const HEAT_STEPS = 41;
const HEAT_SIZE  = 300;
const HEAT_PAD   = { l: 50, t: 8, r: 18, b: 30 };

let heatAxes  = {};
let heatGrids = {};

function heatDefaultAxes(P) {
  const assets = (P.baseline || []).map(b => b.asset).filter(a => P.marks[a] > 0);
  return { x: assets[0], y: assets[1] };
}

function heatAxesFor(P) {
  const live = Object.keys(P.marks).filter(a => P.marks[a] > 0);
  const chosen = heatAxes[P.marginAsset];
  if (chosen && live.includes(chosen.x) && live.includes(chosen.y) && chosen.x !== chosen.y) return chosen;
  return heatDefaultAxes(P);
}

function setHeatAxis(poolIdx, axis, asset) {
  const P = riskBook.pools[poolIdx];
  const cur = { ...heatAxesFor(P) };
  const other = axis === 'x' ? 'y' : 'x';
  if (cur[other] === asset) cur[other] = cur[axis];
  cur[axis] = asset;
  heatAxes[P.marginAsset] = cur;
  refreshHeat(poolIdx);
}

function heatGridFor(P, poolIdx) {
  const { x, y } = heatAxesFor(P);
  const grid = riskEngine.marginGrid(P.pool, P.marks, stressPrices(P), x, y,
    { ...P.opts, honorStops: riskHonorStops, range: riskRange, steps: HEAT_STEPS });
  heatGrids[poolIdx] = grid;
  return grid;
}

const heatLo = () => Math.max(-99, -riskRange);
const heatClampPct = v => Math.max(heatLo(), Math.min(riskRange, v || 0));
const heatPx = pct => HEAT_PAD.l + (pct - heatLo()) / (riskRange - heatLo()) * HEAT_SIZE;
const heatPy = pct => HEAT_PAD.t + (1 - (pct - heatLo()) / (riskRange - heatLo())) * HEAT_SIZE;

function heatContour(grid, key) {
  const { xs, ys, cells } = grid;
  const v = (i, j) => cells[j][i][key];
  const lerp = (a, b, va, vb) => a + (b - a) * (va / (va - vb));
  const segs = [];
  for (let j = 0; j < ys.length - 1; j++) {
    for (let i = 0; i < xs.length - 1; i++) {
      const corners = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
      const hits = [];
      for (let k = 0; k < 4; k++) {
        const [ai, aj] = corners[k], [bi, bj] = corners[(k + 1) % 4];
        const va = v(ai, aj), vb = v(bi, bj);
        if ((va > 0) === (vb > 0)) continue;
        hits.push([heatPx(lerp(xs[ai], xs[bi], va, vb)), heatPy(lerp(ys[aj], ys[bj], va, vb))]);
      }
      for (let k = 0; k + 1 < hits.length; k += 2) segs.push(`M${hits[k][0].toFixed(1)} ${hits[k][1].toFixed(1)}L${hits[k + 1][0].toFixed(1)} ${hits[k + 1][1].toFixed(1)}`);
    }
  }
  return segs.join('');
}

function heatBetaPath(grid) {
  const bx = betaOf(grid.assetX), by = betaOf(grid.assetY);
  const reach = 2 * Math.max(riskRange, 99) / Math.max(Math.abs(bx), Math.abs(by), 1e-9);
  return `M${heatPx(-reach * bx).toFixed(1)} ${heatPy(-reach * by).toFixed(1)}L${heatPx(reach * bx).toFixed(1)} ${heatPy(reach * by).toFixed(1)}`;
}

function heatSvg(grid, poolIdx) {
  const { xs, ys, cells } = grid;
  const cw = HEAT_SIZE / (xs.length - 1), ch = HEAT_SIZE / (ys.length - 1);
  const rects = cells.map((row, j) => row.map((c, i) => {
    const x = (heatPx(xs[i]) - cw / 2).toFixed(1), y = (heatPy(ys[j]) - ch / 2).toFixed(1);
    const size = `width="${(cw + 0.3).toFixed(1)}" height="${(ch + 0.3).toFixed(1)}"`;
    return c.liquidated
      ? `<rect x="${x}" y="${y}" ${size} fill="url(#st-hatch-${poolIdx})"/>`
      : `<rect x="${x}" y="${y}" ${size} fill="color-mix(in srgb, var(--bn) ${(4 + 86 * Math.min(100, Math.max(0, c.usedPct)) / 100).toFixed(0)}%, var(--surface))"/>`;
  }).join('')).join('');
  const ticks = [heatLo(), heatLo() / 2, 0, riskRange / 2, riskRange].filter((t, k, a) => a.indexOf(t) === k);
  const tickText = t => t === 0 ? 'mark' : fmtSignedPct(t, 0);
  const W = HEAT_PAD.l + HEAT_SIZE + HEAT_PAD.r, H = HEAT_PAD.t + HEAT_SIZE + HEAT_PAD.b;
  const box = `x="${HEAT_PAD.l}" y="${HEAT_PAD.t}" width="${HEAT_SIZE}" height="${HEAT_SIZE}"`;

  return `<svg class="st-heat" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="Pool used across moves in ${esc(grid.assetX)} and ${esc(grid.assetY)}"
      onmousemove="heatHover(event, ${poolIdx})" onmouseleave="heatHide(${poolIdx})" onclick="heatClick(event, ${poolIdx})">
    <defs>
      <pattern id="st-hatch-${poolIdx}" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="5" height="5" fill="var(--danger)" fill-opacity="0.35"/><line x1="0" y1="0" x2="0" y2="5" stroke="var(--danger)" stroke-width="2"/>
      </pattern>
      <clipPath id="st-clip-${poolIdx}"><rect ${box}/></clipPath>
    </defs>
    <g clip-path="url(#st-clip-${poolIdx})">${rects}
      <path d="${heatContour(grid, 'free')}" stroke="var(--text2)" stroke-width="1.5" stroke-dasharray="4 3" fill="none"/>
      <path d="${heatContour(grid, 'buffer')}" stroke="var(--danger)" stroke-width="2" fill="none"/>
      <path d="${heatBetaPath(grid)}" stroke="var(--text2)" stroke-width="1" stroke-dasharray="1.5 3" fill="none"/>
      <line x1="${heatPx(0)}" y1="${HEAT_PAD.t}" x2="${heatPx(0)}" y2="${HEAT_PAD.t + HEAT_SIZE}" stroke="var(--border2)" stroke-width="0.5"/>
      <line x1="${HEAT_PAD.l}" y1="${heatPy(0)}" x2="${HEAT_PAD.l + HEAT_SIZE}" y2="${heatPy(0)}" stroke="var(--border2)" stroke-width="0.5"/>
      <circle id="st-heat-dot-${poolIdx}" r="4.5" cx="${heatPx(heatClampPct(riskShift[grid.assetX])).toFixed(1)}"
        cy="${heatPy(heatClampPct(riskShift[grid.assetY])).toFixed(1)}" fill="var(--surface)" stroke="var(--text)" stroke-width="2"/>
    </g>
    <rect ${box} fill="none" stroke="var(--border2)" stroke-width="0.5"/>
    ${ticks.map(t => `<text x="${heatPx(t)}" y="${HEAT_PAD.t + HEAT_SIZE + 13}" text-anchor="middle" class="st-heat-tick">${tickText(t)}</text>
      <text x="${HEAT_PAD.l - 4}" y="${heatPy(t) + 3}" text-anchor="end" class="st-heat-tick">${tickText(t)}</text>`).join('')}
    <text x="${HEAT_PAD.l + HEAT_SIZE / 2}" y="${H - 3}" text-anchor="middle" class="st-heat-axis">${esc(grid.assetX)} move</text>
    <text transform="translate(10 ${HEAT_PAD.t + HEAT_SIZE / 2}) rotate(-90)" text-anchor="middle" class="st-heat-axis">${esc(grid.assetY)} move</text>
  </svg>`;
}

function heatNearestText(grid) {
  const n = grid.nearest;
  if (!n) return `No liquidation within ${fmtSignedPct(heatLo(), 0)} to ${fmtSignedPct(riskRange, 0)} on either coin.`;
  if (n.xPct === 0 && n.yPct === 0) return `<span class="dn">Already liquidated with both at their mark</span> under the scenario above.`;
  return `Closest joint move to liquidation: <b>${esc(grid.assetX)} ${fmtSignedPct(n.xPct, 1)}</b> with
    <b>${esc(grid.assetY)} ${fmtSignedPct(n.yPct, 1)}</b>.`;
}

function heatBodyHtml(P, poolIdx) {
  const grid = heatGridFor(P, poolIdx);
  return `<div class="st-heat-wrap">
      ${heatSvg(grid, poolIdx)}
      <div class="st-heat-tip" id="st-heat-tip-${poolIdx}" hidden></div>
    </div>
    <p class="st-note" style="margin:6px 0 0">${heatNearestText(grid)}</p>`;
}

function renderHeatSection(P, poolIdx) {
  const live = Object.keys(P.marks).filter(a => P.marks[a] > 0);
  if (live.length < 2) return '';
  const { x, y } = heatAxesFor(P);
  const picker = (axis, current) => `<select class="st-btn" aria-label="${axis === 'x' ? 'Across' : 'Up'}"
      onchange="setHeatAxis(${poolIdx}, ${jsArg(axis)}, this.value)">
      ${live.map(a => `<option value="${esc(a)}"${a === current ? ' selected' : ''}>${esc(a)}</option>`).join('')}</select>`;
  const key = (swatch, label) => `<span class="st-heat-key">${swatch}${label}</span>`;
  return `<p class="section-label" style="margin:18px 0 6px">Two coins at once</p>
    <div class="st-controls">
      <label>Across ${picker('x', x)}</label>
      <label>Up ${picker('y', y)}</label>
      <span class="st-sep"></span>
      ${key('<i style="background:linear-gradient(90deg, var(--surface), var(--bn))"></i>', 'pool used')}
      ${key('<i class="line" style="border-top:2px solid var(--danger)"></i>', 'liquidation')}
      ${key('<i class="line" style="border-top:1.5px dashed var(--text2)"></i>', 'free margin gone')}
      ${key('<i class="line" style="border-top:1px dotted var(--text2)"></i>', 'BTC move, by beta')}
    </div>
    <div id="st-heat-${poolIdx}">${heatBodyHtml(P, poolIdx)}</div>
    <div class="st-note">Every other coin stays where the sliders above put it; margin follows the live engine,
      tiers moving with notional, as the rows above do. Click a cell to set both sliders there.</div>`;
}

function refreshHeat(poolIdx) {
  (riskBook?.pools || []).forEach((P, i) => {
    if (poolIdx != null && i !== poolIdx) return;
    const el = document.getElementById(`st-heat-${i}`);
    if (el) el.innerHTML = heatBodyHtml(P, i);
  });
  placeHeatDots();
}

function placeHeatDots() {
  Object.entries(heatGrids).forEach(([i, grid]) => {
    const dot = document.getElementById(`st-heat-dot-${i}`);
    if (!dot) return;
    dot.setAttribute('cx', heatPx(heatClampPct(riskShift[grid.assetX])).toFixed(1));
    dot.setAttribute('cy', heatPy(heatClampPct(riskShift[grid.assetY])).toFixed(1));
  });
}

function heatCellAt(event, poolIdx) {
  const grid = heatGrids[poolIdx];
  const rect = event.currentTarget.getBoundingClientRect();
  const W = HEAT_PAD.l + HEAT_SIZE + HEAT_PAD.r;
  const scale = W / rect.width;
  const px = (event.clientX - rect.left) * scale, py = (event.clientY - rect.top) * scale;
  const last = grid.xs.length - 1;
  const i = Math.round((px - HEAT_PAD.l) / HEAT_SIZE * last);
  const j = Math.round((1 - (py - HEAT_PAD.t) / HEAT_SIZE) * last);
  return i < 0 || j < 0 || i > last || j > last ? null : { i, j };
}

function heatShowCell(poolIdx, i, j) {
  const grid = heatGrids[poolIdx], tip = document.getElementById(`st-heat-tip-${poolIdx}`);
  const P = riskBook?.pools?.[poolIdx];
  if (!grid || !tip || !P) return;
  const c = grid.cells[j][i], x = grid.xs[i], y = grid.ys[j];
  const price = (a, pct) => fmt(P.marks[a] * (1 + pct / 100), priceDecimals(P.marks[a]));
  tip.innerHTML = `<b>${esc(grid.assetX)}</b> ${price(grid.assetX, x)} (${fmtSignedPct(x, 1)})<br>
    <b>${esc(grid.assetY)}</b> ${price(grid.assetY, y)} (${fmtSignedPct(y, 1)})<br>
    ${c.liquidated ? '<span class="dn">liquidated</span>' : `pool used ${fmt(c.usedPct, 1)}%`}<br>
    buffer ${fmtSignedUsd(c.buffer)} · free ${fmtSignedUsd(Math.max(0, c.free))}`;
  const across = heatPx(x) / (HEAT_PAD.l + HEAT_SIZE + HEAT_PAD.r);
  tip.style.left = `${across * 100}%`;
  tip.style.transform = across > 0.6 ? 'translate(calc(-100% - 10px), -50%)' : '';
  tip.style.top = `${heatPy(y) / (HEAT_PAD.t + HEAT_SIZE + HEAT_PAD.b) * 100}%`;
  tip.hidden = false;
}

function heatHover(event, poolIdx) {
  const cell = heatCellAt(event, poolIdx);
  if (cell) heatShowCell(poolIdx, cell.i, cell.j);
  else heatHide(poolIdx);
}

function heatHide(poolIdx) {
  const tip = document.getElementById(`st-heat-tip-${poolIdx}`);
  if (tip) tip.hidden = true;
}

function heatPick(poolIdx, i, j) {
  const grid = heatGrids[poolIdx];
  if (!grid) return;
  riskLink[grid.assetX] = false;
  riskLink[grid.assetY] = false;
  riskShift[grid.assetX] = grid.xs[i];
  riskShift[grid.assetY] = grid.ys[j];
  afterStressChange(true);
}

function heatClick(event, poolIdx) {
  const cell = heatCellAt(event, poolIdx);
  if (cell) heatPick(poolIdx, cell.i, cell.j);
}
