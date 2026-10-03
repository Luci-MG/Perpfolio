// core.js — preferences, shared view state and the formatting helpers every panel uses.
// Loads first: later files call loadPref() and the fmt*/esc helpers at load time.

function loadPref(key, fallback) {
  try { const v = localStorage.getItem(`dash:${key}`); return v == null ? fallback : JSON.parse(v); }
  catch (_) { return fallback; }
}
function savePref(key, value) {
  try { localStorage.setItem(`dash:${key}`, JSON.stringify(value)); } catch (_) {}
}

let autoRefresh;
let lastData = null;
let posView = 'tiles';
let exchFilter = new Set(['hyperliquid', 'binance']);
let tileOrder = [];

// Dynamic Stop Width state
let volStopData = null;        // last /api/volstops response
let volRiskPct = 1.0;          // user risk % (UI input)
let volK = 1.5;                // user stop multiplier k
let volLoading = false;

function posId(p) { return `${p.exchange}:${p.pair}:${p.side}`; }

function fmt(n, decimals=2) {
  const num = parseFloat(n);
  if (isNaN(num)) return '—';
  return num.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function clockParam() {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `tz=${-new Date().getTimezoneOffset()}${zone ? `&zone=${encodeURIComponent(zone)}` : ''}`;
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtUsd(n) { return '$' + fmt(n); }

// A failed load keeps the panel's last good data; the failure is held here, apart from it.
const loadErrors = {};
function noteLoadError(key, err) { loadErrors[key] = { message: err?.message || String(err), at: Date.now() }; }
function clearLoadError(key) { delete loadErrors[key]; }
function loadErrorHtml(key, retryCall, hasData) {
  const e = loadErrors[key];
  if (!e) return '';
  const when = new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `<p class="load-error"><span class="dn">${hasData ? 'Couldn’t refresh' : 'Couldn’t load'}</span> · ${esc(e.message)} · ${when}${
    hasData ? ' · showing the last good data' : ''}<button class="st-btn" onclick="${retryCall}">Retry</button></p>`;
}
// a negative dollar figure reads as "$-13,040" through fmtUsd; the sign belongs outside
function fmtSignedUsd(n) {
  const num = parseFloat(n);
  if (isNaN(num)) return '—';
  return (num < 0 ? '−' : '') + fmtUsd(Math.abs(num));
}
function fmtPrice(n) {
  const num = parseFloat(n);
  if (isNaN(num)) return '—';
  const abs = Math.abs(num);
  return '$' + fmt(num, abs >= 1000 ? 2 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6);
}
function fmtPnl(n) {
  const num = parseFloat(n);
  if (isNaN(num)) return '—';
  const cls = num >= 0 ? 'up' : 'dn';
  const sign = num >= 0 ? '+' : '';
  return `<span class="${cls}">${sign}$${fmt(Math.abs(num))}</span>`;
}
// Funding per day in USD, positive when received. Symbols settle every 8h, 4h or 1h
// (Hyperliquid hourly), so the daily multiple comes from the position's own interval.
function fundingIntervalOf(p) {
  return p.fundingIntervalHours > 0 ? p.fundingIntervalHours : 8;
}
function fundingPerDay(p) {
  return (p.side === 'Long' ? -1 : 1) * ((p.fundingRate || 0) / 100) * (p.sizeUsd || 0) * (24 / fundingIntervalOf(p));
}
function badge(text, cls) { return `<span class="badge ${cls}">${text}</span>`; }
function sideBadge(side) { return badge(side, side === 'Long' || side === 'Buy' ? 'b-long' : 'b-short'); }
function liqDist(p) {
  return (p.mark > 0 && p.liqPrice > 0) ? Math.abs(p.mark - p.liqPrice) / p.mark * 100 : 999;
}

const THREAD_PALETTE = [
  '#c87c6a', '#6a8fc8', '#6ac87e', '#c8b46a', '#976ac8', '#6ac8be', '#c86aa2', '#a8c86a'
];

function normalizePairKey(pair) {
  return pair.replace(/-PERP$/i, '').replace(/\/(USDT?|USD)$/i, '').toUpperCase();
}
