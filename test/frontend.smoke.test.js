import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { startTestServer } from './harness.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIEWS = ['tiles', 'list', 'orders', 'stops', 'stress', 'unwind', 'journal', 'confluence'];

// The page's scripts in the order the browser runs them: inline blocks and `src` files alike.
export function pageScripts() {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  return [...html.matchAll(/<script(?:\s+src="([^"]+)")?\s*>([\s\S]*?)<\/script>/g)].map(([, src, inline]) => ({
    name: src || 'inline',
    code: src ? fs.readFileSync(path.join(ROOT, 'public', src), 'utf8') : inline
  }));
}

function fakeElement(store, id) {
  const el = {
    id, style: {}, dataset: {}, children: [], childNodes: [], value: '', textContent: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild() {}, removeChild() {}, setAttribute() {}, getAttribute: () => null, remove() {},
    addEventListener() {}, removeEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }),
    focus() {}, contains: () => false, closest: () => null, scrollIntoView() {}
  };
  Object.defineProperty(el, 'innerHTML', {
    get: () => store.get(id) ?? '',
    set: v => store.set(id, String(v))
  });
  return el;
}

function browserContext(base, markup) {
  const document = {
    hidden: false, body: fakeElement(markup, 'body'), documentElement: fakeElement(markup, 'html'),
    getElementById: id => /-mounted$/.test(id) ? null : fakeElement(markup, id),
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {},
    createElement: tag => fakeElement(markup, `new:${tag}`), createElementNS: (_, tag) => fakeElement(markup, `new:${tag}`)
  };
  const ctx = {
    document, console, performance, URLSearchParams, Date, Math, JSON, Promise, Set, Map,
    window: { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), innerWidth: 1400 },
    navigator: {}, location: { href: base },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setInterval: () => 0, clearInterval() {}, setTimeout: () => 0, clearTimeout() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    fetch: (url, opts) => fetch(base + url, opts),
    __importEngine: () => import(path.join(ROOT, 'risk-engine.js'))
  };
  ctx.window.document = document;
  ctx.globalThis = ctx;
  return vm.createContext(ctx);
}

const { base, stop } = await startTestServer();
test.after(stop);

async function bootPage() {
  const markup = new Map();
  const ctx = browserContext(base, markup);
  for (const { name, code } of pageScripts()) {
    vm.runInContext(code.replaceAll("import('/risk-engine.js')", '__importEngine()'), ctx, { filename: name });
  }
  const run = js => vm.runInContext(js, ctx);
  const settle = async (check, what) => {
    for (let i = 0; i < 200; i++) {
      if (run(check)) return;
      await new Promise(r => setTimeout(r, 25));
    }
    assert.fail(`timed out waiting for ${what}`);
  };
  await settle('lastData != null', 'the dashboard poll');
  return { markup, run, settle };
}

const strayValues = html => [...html.matchAll(/(.{0,60}\b(?:undefined|NaN)\b.{0,20})/g)].map(([, hit]) => hit);

test('every view and drawer renders against live payloads without errors or NaN', async () => {
  const { markup, run, settle } = await bootPage();
  for (const v of VIEWS) run(`setView('${v}')`);
  await settle('volStopData && riskBook && unwindData && perfData && cfData && !cfLoading', 'every tab fetch');

  const bad = [];
  for (const v of VIEWS) {
    run(`posView = '${v}'; riskForceRender = true; render(lastData)`);
    for (const hit of strayValues(markup.get('content') + markup.get('sidebar'))) bad.push(`${v}: …${hit}…`);
  }
  for (const data of ['volStopData', 'riskBook', 'unwindData', 'perfData', 'cfData']) {
    assert.equal(run(`${data}?.error ?? null`), null, `${data} failed to load`);
  }
  for (const fn of ['buildFundingDrawerContent(lastData)']) run(fn);
  assert.deepEqual(bad, []);
});

test('the Trades table sorts, filters, pages and exports what it shows', async () => {
  const { markup, run, settle } = await bootPage();
  await fetch(`${base}/api/history/sync?start=true`);
  for (let i = 0; i < 200; i++) {
    if (!(await (await fetch(`${base}/api/history/sync`)).json()).state.running) break;
    await new Promise(r => setTimeout(r, 25));
  }
  run(`setView('journal')`);
  await settle('perfData && !perfLoading', 'the journal');
  run(`setJrTab('trades')`);
  await settle('tripsData && !tripsLoading', 'the trips');
  run(`riskForceRender = true; render(lastData)`);

  const table = () => markup.get('jt-table') ?? markup.get('content');
  const total = run('tripsData.trips.length');
  assert.match(markup.get('content'), new RegExp(`${total} trips · ${total} match`));
  assert.deepEqual(strayValues(markup.get('content')), []);

  run(`sortTrades('net')`);
  const nets = JSON.parse(run('JSON.stringify(sortedTrips(filteredTrips()).map(tripNet))'));
  assert.deepEqual(nets, [...nets].sort((a, b) => b - a));
  run(`filterTrades('symbol', 'eth')`);
  assert.equal(run('filteredTrips().every(t => t.symbol === "ETHUSDT")'), true);
  assert.match(table(), /trips · \d+ match/);

  run(`toggleTradeColumns()`);
  assert.match(markup.get('content'), /Entry → exit/);
  assert.deepEqual(strayValues(markup.get('content')), []);

  run(`sortedTrips(filteredTrips())[0].entry = { account: { equity: 1000, marginPct: 12.5, freeMargin: 800, leverage: 10 },
    confluence: { score: 0.42, state: 'bullish', aligned: true, byTf: {} },
    suggestedStop: { price: 95, distancePct: 2 }, yourStop: { price: 97, distancePct: 1.2 },
    stopVsSuggested: 0.6, stopLooked: true, errors: [] }; refreshTradesTable()`);
  assert.match(table(), /0\.60× sugg/);
  assert.deepEqual(strayValues(table()), []);

  const csv = run('tradesCsv()').split('\n');
  assert.equal(csv.length, run('filteredTrips().length') + 1);
  assert.match(csv[0], /^symbol,side,opened_utc,.*mae_pct,mfe_pct/);
  assert.ok(csv.slice(1).every(line => line.startsWith('ETHUSDT,Long,')));
});

test('every stop verdict renders on the Stops tab, and the tile badge follows hasStop', async () => {
  const { markup, run, settle } = await bootPage();
  run(`setView('stops')`);
  await settle('volStopData && !volLoading', 'the stops');
  run(`const base = volStopData.positions[0];
    volStopData.positions = ['none', 'hedged', 'tight', 'wide', 'breakeven', 'locks', 'ok'].map(verdict => ({ ...base, verdict,
      ratio: verdict === 'locks' ? null : 0.8, lockedPct: verdict === 'locks' ? 1.5 : null,
      yourStop: ['none', 'hedged'].includes(verdict) ? null
        : { price: 95, distancePct: 1.2, atrMultiple: 1.4, hit: { rate: 0.41, windows: 176, independent: 7, days: 8.3 } } }));
    riskForceRender = true; render(lastData)`);
  const html = markup.get('content');
  for (const label of ['No stop', 'Hedged', 'Too tight', 'Too wide', 'Breakeven', 'Locks profit', 'OK']) assert.match(html, new RegExp(label));
  assert.match(html, /hit within 24h in 41% of windows/);
  assert.match(html, /1 without a stop · 1 too tight · 1 too wide/);
  assert.deepEqual(strayValues(html), []);

  run(`setView('tiles')`);
  assert.equal((markup.get('content').match(/class="sl-alert"/g) || []).length, 3,
    'ETH, ENA and SOL have no stop and no hedge; the BTC legs are a hedge and the long has a stop');
});

test('the tool widgets open each tool and toggle back to the last positions view', async () => {
  const { markup, run } = await bootPage();
  assert.equal(run('TOOLS.every(t => VIEWS.includes(t.view))'), true);

  run(`setView('list')`);
  assert.equal(markup.get('sidebar').match(/class="tool-tile/g).length, 5);
  assert.match(markup.get('content'), /class="tools-strip"/);
  assert.doesNotMatch(markup.get('content'), /data-view="stress"/, 'tools left the tab strip');

  run(`openTool('confluence')`);
  assert.equal(run('posView'), 'confluence');
  assert.match(markup.get('sidebar'), /tool-tile active" aria-current="page"[\s\S]*?Confluence/);
  run(`openTool('confluence')`);
  assert.equal(run('posView'), 'list', 'opening the open tool returns to the last positions view');
});

test('switched-off venues render as off, and the popover lists both switches', async () => {
  const { markup, run } = await bootPage();
  const setVenue = (venue, enabled) => fetch(`${base}/api/venues`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ venue, enabled })
  });

  await setVenue('hyperliquid', false);
  await run('fetchData()');
  assert.match(run('bulbClass()'), /^status-dot partial\b/);
  for (const v of VIEWS) {
    run(`posView = '${v}'; riskForceRender = true; render(lastData)`);
    assert.deepEqual(strayValues(markup.get('content') + markup.get('sidebar')), [], v);
  }
  assert.match(markup.get('sidebar'), /<span class="b-label">HL<\/span><span class="b-val nu">off<\/span>/);
  await run('loadVenues()');
  assert.match(markup.get('venuePopover'), /Hyperliquid[\s\S]*off/);
  assert.match(markup.get('venuePopover'), /checked/);

  await setVenue('binance', false);
  await run('fetchData()');
  assert.match(run('bulbClass()'), /^status-dot off\b/);
  run(`posView = 'tiles'; render(lastData)`);
  assert.match(markup.get('content'), /Every exchange is switched off/);
  run(`posView = 'stress'; riskForceRender = true; render(lastData)`);
  assert.match(markup.get('content'), /Binance is switched off/);
  assert.match(markup.get('sidebar'), /tool-tile[^"]* off"[^>]*>[\s\S]*?Stress/);

  await setVenue('binance', true);
  await setVenue('hyperliquid', true);
});
