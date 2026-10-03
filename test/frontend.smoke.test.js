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
