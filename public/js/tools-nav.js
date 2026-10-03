// tools-nav.js — the Tools widgets in the sidebar (a strip above the content on narrow
// screens). TOOLS is the one list of tool views.

const TOOLS = [
  { view: 'stops',      label: 'Stops',      exchangeFilter: true },
  { view: 'stress',     label: 'Stress',     binanceOnly: true },
  { view: 'unwind',     label: 'Unwind',     binanceOnly: true },
  { view: 'journal',    label: 'Journal' },
  { view: 'confluence', label: 'Confluence' }
];

const TOOL_ICON = {
  stops:      '<circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  stress:     '<polyline points="22 12 18 12 15 20 9 4 6 12 2 12"/>',
  unwind:     '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  journal:    '<path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M9 9h5M9 13h5"/>',
  confluence: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>'
};

let lastPositionsView = loadPref('positionsView', 'tiles');

function isToolView(view) { return TOOLS.some(t => t.view === view); }

function toolFor(view) { return TOOLS.find(t => t.view === view) || null; }

function openTool(view) { setView(posView === view ? lastPositionsView : view); }

function rememberPositionsView(view) {
  lastPositionsView = view;
  savePref('positionsView', view);
}

function toolIcon(view) {
  return `<svg class="tool-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TOOL_ICON[view]}</svg>`;
}

function renderToolButton(tool, cls) {
  const active = posView === tool.view;
  const off = tool.binanceOnly && !venueOn('binance');
  const title = off ? `${tool.label} — Binance is switched off` : active ? `Back to ${lastPositionsView}` : tool.label;
  return `<button class="${cls}${active ? ' active' : ''}${off ? ' off' : ''}"${active ? ' aria-current="page"' : ''}
    onclick="openTool(${jsArg(tool.view)})" title="${title}">${toolIcon(tool.view)}<span>${tool.label}</span></button>`;
}

function renderToolsNav() {
  return `<nav class="tool-grid" aria-label="Tools">${TOOLS.map(t => renderToolButton(t, 'tool-tile')).join('')}</nav>`;
}

function renderToolsStrip() {
  return `<nav class="tools-strip" aria-label="Tools">${TOOLS.map(t => renderToolButton(t, 'tool-chip')).join('')}</nav>`;
}
