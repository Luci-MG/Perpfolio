// journal-symbols.js — the Journal's Symbols tab: the best and worst symbols by total net with the
// rest folded into one row, a shrunk average per unit where there are enough trades, what each
// costs, how concentrated the book is, and a way into each symbol's trades.

let symbolsShowAll = false;
let symbolsSort = { key: 'net', dir: -1 };

const SYMBOL_COLUMNS = [
  { key: 'symbol', label: 'symbol' }, { key: 'units', label: 'units' }, { key: 'net', label: 'net' },
  { key: 'shrunk', label: 'adjusted avg' }, { key: 'winRate', label: 'win' }, { key: 'costBp', label: 'fees' },
  { key: 'fundingPerHour', label: 'funding / h held' }
];

function sortSymbols(key) {
  symbolsSort = { key, dir: symbolsSort.key === key ? -symbolsSort.dir : key === 'symbol' ? 1 : -1 };
  rerenderStress();
}

function toggleAllSymbols() { symbolsShowAll = !symbolsShowAll; rerenderStress(); }

function symbolCell(r, key) {
  if (key === 'symbol') return `<button class="gl-link" onclick="openTradesFor({ symbol: ${jsArg(r.symbol)}, exact: true })" title="Trades on ${esc(r.symbol)}">${esc(jrSym(r.symbol))}</button>`;
  if (key === 'net') return `<span class="${ovTone(r.net)}">${fmtPlusUsd(r.net)}</span>`;
  if (key === 'units') return `${r.units}${r.legs > r.units ? ` <span class="gl-n">(${r.legs} legs)</span>` : ''}`;
  if (key === 'shrunk') return r.needs ? `<span class="gl-n">after ${r.needs} more</span>`
    : `<span class="${ovTone(r.shrunk)}">${fmtPlusUsd(r.shrunk)}</span> <span class="gl-n" title="90% interval">${fmtPlusUsd(r.ci.lo)} to ${fmtPlusUsd(r.ci.hi)}</span>`;
  if (key === 'winRate') return r.winRate == null ? '—' : `${fmt(r.winRate * 100, 0)}%`;
  if (key === 'costBp') return r.costBp == null ? '—' : `${fmt(r.costBp, 1)} bp`;
  return r.fundingPerHour == null ? '<span class="gl-n">—</span>' : `<span class="${ovTone(r.fundingPerHour)}">${fmtPlusUsd(r.fundingPerHour)}</span>`;
}

function sortedSymbolRows(rows) {
  const { key, dir } = symbolsSort;
  const value = r => (key === 'shrunk' && r.needs ? null : r[key]);
  return [...rows].sort((a, b) => {
    const x = value(a), y = value(b);
    if (x == null || y == null) return (x == null) - (y == null);
    return (x < y ? -1 : x > y ? 1 : 0) * dir;
  });
}

function symbolsTableHtml(s) {
  const shown = symbolsShowAll ? s.rows : s.rows.filter(r => s.shown.includes(r.symbol));
  const head = SYMBOL_COLUMNS.map(c => `<th><button onclick="sortSymbols('${c.key}')">${c.label}${symbolsSort.key === c.key ? (symbolsSort.dir > 0 ? ' ▲' : ' ▼') : ''}</button></th>`).join('');
  const rows = sortedSymbolRows(shown).map(r => `<tr class="${r.needs ? 'jr-thin' : ''}">${SYMBOL_COLUMNS.map(c => `<td>${symbolCell(r, c.key)}</td>`).join('')}</tr>`).join('');
  const rest = !symbolsShowAll && s.rest.symbols ? `<tr class="jr-thin"><td colspan="2">rest: ${s.rest.symbols} symbols, ${s.rest.units} units</td>
    <td class="${ovTone(s.rest.net)}">${fmtPlusUsd(s.rest.net)}</td><td colspan="4"></td></tr>` : '';
  const toggle = s.rows.length > s.shown.length ? `<button class="gl-link" onclick="toggleAllSymbols()">${symbolsShowAll ? 'Best and worst only' : `Show all ${s.rows.length}`} ›</button>` : '';
  return `<table class="jr-tbl sym-tbl"><tr>${head}</tr>${rows}${rest}</table>${toggle}`;
}

function concentrationLine(c) {
  if (!c.symbols) return '';
  const top = c.top.map(sym => esc(jrSym(sym))).join(', ');
  return `<p class="gl-line">${top} carry ${fmt(c.topShare * 100, 0)}% of the book's gross profit and loss ·
    by notional you trade like ${fmt(c.effectiveSymbols, 1)} equal-sized symbols out of ${c.symbols}</p>`;
}

function renderSymbolsTab() {
  const s = perfData.symbols;
  const note = perfData.session ? `<p class="jr-session-note">${esc(perfData.session)} trips only.</p>` : '';
  if (!s.rows.length) return `${note}<p class="gl-n">No trips in this window.</p>`;
  return `${note}${concentrationLine(s.concentration)}
    ${jrSection('By symbol', symbolsTableHtml(s),
      `Sorted by total net, a fact at any size. The adjusted average is per unit, pulled toward the book's ${fmtPlusUsd(s.overall)} in
       proportion to how few trades a symbol has, and appears from ${s.min} units; ${s.chance.shown} symbols have that many.
       Fees are in basis points of notional traded. Select a symbol for its trades.`)}`;
}
