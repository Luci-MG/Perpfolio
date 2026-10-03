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
  const elements = new Map();
  const element = id => elements.get(id) || elements.set(id, fakeElement(markup, id)).get(id);
  const document = {
    hidden: false, body: fakeElement(markup, 'body'), documentElement: fakeElement(markup, 'html'),
    getElementById: id => /-mounted$/.test(id) ? null : element(id),
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
    __importEngine: file => import(path.join(ROOT, file))
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
    vm.runInContext(code.replace(/import\('\/([\w-]+\.js)'\)/g, "__importEngine('$1')"), ctx, { filename: name });
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

test('the calculators fill from a picked position, and its liquidation matches Stress and Binance', async () => {
  const { markup, run, settle } = await bootPage();
  const value = id => run(`document.getElementById('${id}').value`);
  const text = id => run(`document.getElementById('${id}').textContent`);

  run(`ctxPosition = lastData.binance.positions.find(p => p.symbol === 'ENAUSDC'); openCalc('liq')`);
  await settle('calcEngine && riskBook?.pools && document.getElementById("liqAccPrice").textContent', 'the account-aware liq');
  const P = 'riskBook.pools.find(P => P.marginAsset === "USDC")';
  const stress = run(`riskEngine.liquidationDetail(${P}.pool, 'ENA', ${P}.marks, ${P}.opts).price`);
  const reported = run(`${P}.liqCheck.find(x => x.key === 'ENAUSDC:LONG').reportedLiqPrice`);
  assert.equal(text('liqAccPrice'), run(`fmtPrice(${stress})`));
  assert.equal(text('liqAccReported'), run(`fmtPrice(${reported})`));
  assert.ok(Math.abs(stress - reported) / reported < 1e-6, `${stress} vs ${reported}`);
  assert.equal(value('liqEntry'), 0.27);
  assert.equal(value('pnlLev'), 3);
  assert.ok(value('liqMmr') > 0, 'the maintenance rate comes from the tier');

  run(`document.getElementById('liqAddUsd').value = 500; calcLiq()`);
  const after = parseFloat(text('liqAddPrice2').replace(/[$,]/g, ''));
  assert.ok(after > stress, 'adding to the long moves its liquidation up');

  run(`document.getElementById('avgTarget').value = 0.26; switchCalcTab('avg')`);
  assert.match(text('avgLiq'), /^\$[\d.]+ \(−[\d.]+%\)$/);

  run(`switchCalcTab('pnl')`);
  assert.equal((run(`document.getElementById('pnlLadder').innerHTML`).match(/<tr>/g) || []).length, 7, 'header + six steps');

  run(`switchCalcTab('size')`);
  assert.ok(value('sizeEquity') > 0 && value('sizeLev') === 3);
  run(`document.getElementById('sizeRisk').value = 1; document.getElementById('sizeStop').value = 0.24; calcSize()`);
  assert.match(text('sizeRiskUsd'), /^\$[\d,.]+$/);
  run(`document.getElementById('sizeStop').value = 0.3; calcSize()`);
  assert.match(run(`document.getElementById('sizeWarn').innerHTML`), /wrong side/);

  run(`switchCalcTab('be')`);
  assert.equal(value('beInterval'), 4, 'ENA settles every 4h');
  assert.equal(value('beFeeIn'), 0.05, "the account's taker rate");
  assert.match(text('beExit'), /^\$0\.27\d*$/);

  run(`pickCalcPosition(''); switchCalcTab('liq'); document.getElementById('liqEntry').value = 100;
       document.getElementById('liqLev').value = 10; calcLiq()`);
  assert.equal(run(`document.getElementById('liqManual').style.display`), '');
  assert.match(run(`document.getElementById('liqPrice').innerHTML`), /\$90\.50/);
  for (const id of ['liqAccPrice', 'liqAccDist', 'liqAddPrice2', 'avgLiq', 'pnlPnl', 'liqPrice', 'pnlLadder',
                    'sizeQty', 'sizeMargin', 'beExit', 'beMove', 'beFees', 'beFundingUsd']) {
    assert.doesNotMatch(String(text(id) ?? '') + run(`document.getElementById('${id}').innerHTML`), /undefined|NaN/, id);
  }
});

test('every Journal sub-tab renders, with and without equity snapshots', async () => {
  const { markup, run, settle } = await bootPage();
  await fetch(`${base}/api/history/sync?start=true`);
  for (let i = 0; i < 200 && (await (await fetch(`${base}/api/history/sync`)).json()).state.running; i++) {
    await new Promise(r => setTimeout(r, 25));
  }
  run(`setView('journal')`);
  await settle('perfData && !perfLoading && perfData.periods', 'the journal');

  const tabs = ['overview', 'performance', 'behaviour', 'timing', 'symbols', 'costs'];
  const renderAll = () => tabs.map(tab => {
    run(`jrTab = '${tab}'; riskForceRender = true; render(lastData)`);
    return [tab, markup.get('content')];
  });
  for (const [tab, html] of renderAll()) assert.deepEqual(strayValues(html), [], tab);

  const overview = renderAll()[0][1];
  assert.match(overview, /Today[\s\S]*This week[\s\S]*This month/);
  assert.match(overview, /account —/, 'no snapshots yet');
  assert.match(renderAll()[2][1], /What your habits cost[\s\S]*Added while underwater/);

  run(`perfData.accountCurve = [0, 1, 2].map(i => ({ t: Date.now() - (3 - i) * 9e5, accountValue: 1000 + i * 10 }));
       perfData.periods.today.account = { change: 20, since: Date.now() - 27e5, partial: true }`);
  const withSnaps = renderAll()[0][1];
  assert.match(withSnaps, /class="ov-account"/);
  assert.match(withSnaps, /account \$20\.00 since/);
  assert.deepEqual(strayValues(withSnaps), []);
});

test('the Confluence verdict leads, reads for every lean, and the matrix opens on demand', async () => {
  const { markup, run, settle } = await bootPage();
  run(`cfShowAll = false; setView('confluence')`);
  await settle('cfData && !cfLoading', 'the confluence');
  run(`riskForceRender = true; render(lastData)`);
  let html = markup.get('content');
  assert.match(html, /class="cf-verdict"[\s\S]*Can you trust it\?/);
  assert.doesNotMatch(html, /class="cf-table"/, 'the matrix starts collapsed');
  assert.deepEqual(strayValues(html), []);

  for (const [direction, state, label] of [[1, 'bull', 'Leaning long'], [-1, 'bear', 'Leaning short'], [0, 'neutral', 'No clear lean']]) {
    run(`cfData.verdict = { ...cfData.verdict, direction: ${direction}, state: '${state}',
      against: ${direction} ? cfData.verdict.reasons[0] : null }; riskForceRender = true; render(lastData)`);
    html = markup.get('content');
    assert.match(html, new RegExp(label));
    assert.deepEqual(strayValues(html), [], label);
  }

  for (const [edge, stability, text] of [[0.05, 'holds', /held up/], [-0.07, 'holds', /ran below chance/],
                                         [0.05, 'fades', /changed direction/], [0.05, 'thin', /too few recent bars/]]) {
    run(`cfData.verdict.trust = { ...cfData.verdict.trust, stability: '${stability}',
      record: { ...cfData.verdict.trust.record, edge: ${edge} } }; riskForceRender = true; render(lastData)`);
    assert.match(markup.get('content'), text, `${stability} at edge ${edge}`);
  }

  run(`toggleCfDetail()`);
  assert.match(markup.get('content'), /class="cf-table"/);
  run(`toggleCfDetail()`);
});

test('only a stop that cannot lose reads safe; a risking stop is grey, width turns it amber, a moved stop drops it', async () => {
  const { markup, run, settle } = await bootPage();
  const marks = () => [...markup.get('content').matchAll(/class="(stop-mark (?:safe|caution|risk)|sl-alert)"[^>]*title="([^"]*)"/g)]
    .map(m => [m[1], m[2]]);
  const btcLong = `lastData.binance.positions.find(p => p.symbol === 'BTCUSDT' && p.side === 'Long')`;

  run(`setView('tiles')`);
  let tiles = marks();
  assert.equal(tiles.filter(([c]) => c === 'stop-mark risk').length, 1, 'the BTC long: stop below entry');
  assert.equal(tiles.filter(([c]) => c === 'stop-mark safe').length, 0);
  assert.equal(tiles.filter(([c]) => c === 'sl-alert').length, 3, 'ETH, ENA, SOL; the hedged BTC short shows nothing');
  assert.match(tiles.find(([c]) => c === 'stop-mark risk')[1], /still risks a loss[\s\S]*about −\$[\d,.]+ if hit/);

  run(`Object.assign(${btcLong}.stop, { price: ${btcLong}.entry, verdict: 'breakeven' }); render(lastData)`);
  tiles = marks();
  assert.equal(tiles.filter(([c]) => c === 'stop-mark safe').length, 1, 'a stop at entry reads safe');
  assert.match(tiles.find(([c]) => c === 'stop-mark safe')[1], /Safe · stop at entry/);

  run(`Object.assign(${btcLong}.stop, { price: 90000, verdict: 'set' }); setView('stops')`);
  await settle('volStopData && !volLoading', 'the stops');
  run(`const v = volStopData.positions.find(p => p.pair === 'BTC/USDT' && p.side === 'Long');
       v.verdict = 'tight'; v.ratio = 0.4; setView('tiles')`);
  tiles = marks();
  assert.equal(tiles.filter(([c]) => c === 'stop-mark caution').length, 1);
  assert.match(tiles.find(([c]) => c === 'stop-mark caution')[1], /Stop too tight[\s\S]*0\.40× suggested[\s\S]*judged on the Stops tab/);

  run(`${btcLong}.stop.price = 91000; render(lastData)`);
  assert.equal(marks().filter(([c]) => c === 'stop-mark caution').length, 0, 'judged against a stop that has since moved');

  run(`setView('list')`);
  const list = markup.get('content');
  assert.equal((list.match(/class="stop-mark risk"/g) || []).length, 1);
  assert.equal((list.match(/class="sl-alert"/g) || []).length, 3);
  assert.deepEqual(strayValues(list), []);
});

test('the session clock reads, and a chosen session narrows Journal, Trades and Confluence but says where it does not apply', async () => {
  const { markup, run, settle } = await bootPage();
  await settle('sessionsModule', 'the session clock');
  assert.equal(run('JSON.stringify(SESSION_CHOICES)'), JSON.stringify(['All', ...run('sessionsModule.SESSIONS')]),
    'the menu offers exactly the sessions the module defines');
  run(`render(lastData)`);
  const clock = markup.get('content').match(/id="sessionClock">([\s\S]*?)<\/span>\s*<div class="view-tabs">/)[1];
  assert.match(clock, /(Asia|Europe|Europe \+ US|US|Off-hours|Weekend) · /);
  assert.match(clock, /next: .+ in \d+(h \d{2})?m/);
  assert.deepEqual(strayValues(clock), []);

  await fetch(`${base}/api/history/sync?start=true`);
  for (let i = 0; i < 200 && (await (await fetch(`${base}/api/history/sync`)).json()).state.running; i++) {
    await new Promise(r => setTimeout(r, 25));
  }
  run(`setView('journal'); setJrTab('trades')`);
  await settle('perfData && !perfLoading && tripsData && !tripsLoading', 'the journal');
  const session = run('tripsData.trips[0].session');
  run(`setSession(${JSON.stringify(session)})`);
  await settle('perfData && !perfLoading', 'the journal in one session');
  assert.equal(run('perfData.session'), session);
  run(`jrTab = 'trades'; riskForceRender = true; render(lastData)`);
  const inIt = run(`tripsData.trips.filter(t => t.session === ${JSON.stringify(session)}).length`);
  assert.match(markup.get('content'), new RegExp(`${session.replace('+', '\\+')} · \\d+ trips · ${inIt} match`));
  run(`jrTab = 'overview'; riskForceRender = true; render(lastData)`);
  assert.match(markup.get('content'), /Overview is the whole account/);

  run(`setView('stops')`);
  await settle('volStopData && !volLoading', 'the stops');
  assert.match(markup.get('content'), /does not apply here: each hit rate counts 24h windows/);

  run(`setView('confluence')`);
  await settle('cfData && !cfLoading', 'the confluence');
  run(`riskForceRender = true; render(lastData)`);
  assert.match(markup.get('content'), new RegExp(`In ${session.replace('+', '\\+')}`));
  assert.deepEqual(strayValues(markup.get('content')), []);
  run(`setSession('All')`);
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

test('Goals: empty state suggests, rows order and render every state, the drawer previews and saves', async () => {
  const { markup, run, settle } = await bootPage();
  await fetch(`${base}/api/history/sync?start=true`);
  for (let i = 0; i < 200 && (await (await fetch(`${base}/api/history/sync`)).json()).state.running; i++) {
    await new Promise(r => setTimeout(r, 25));
  }
  run(`setView('journal')`);
  await settle('perfData && !perfLoading && goalsData && !goalsLoading', 'the journal and goals');
  const show = tab => { run(`jrTab = '${tab}'; riskForceRender = true; render(lastData)`); return markup.get('content'); };

  const empty = show('goals');
  assert.match(empty, /No goals yet\. From your history:[\s\S]*gl-suggest/);
  assert.doesNotMatch(show('overview'), /gl-overview/, 'no Overview line without goals');

  run(`openGoalDrawer(null, 0)`);
  await run('loadGoalPreview()');
  const drawer = () => markup.get('goalDrawerBody');
  assert.match(markup.get('goalPreview'), /On your last \d+ trades this would have been/);
  run(`setGoalType('maxTradesPerDay')`);
  assert.match(drawer(), /value="6"/);
  run(`setGoalParam('max', '2')`);
  await run('loadGoalPreview()');
  assert.match(markup.get('goalPreview'), /trading days this would have been/);
  run(`setGoalScope('Europe')`);
  await run('saveGoal()');
  assert.equal(run('goalDraft'), null, 'drawer closed on save');
  assert.equal(run('goalsData.goals[0].label'), 'Max 2 trades a day · Europe');

  run(`openGoalDrawer()`);
  run(`setGoalParam('max', '0')`);
  await run('saveGoal()');
  assert.match(drawer(), /class="dn gl-line">Max must be 1–125/);
  run(`closeGoalDrawerForce()`);

  run(`const g = goalsData.goals[0];
       goalsData.goals = ['broken', 'progress', 'kept', 'idle', 'paused'].map((status, i) => ({ ...g, id: 'g' + i, status,
         today: { trips: 2, broken: 1, limit: 2 }, waiting: status === 'idle', pausedAt: status === 'paused' ? Date.now() : null,
         breaches: [{ symbol: 'ETHUSDT', side: 'Long', openTime: Date.now() - 36e5, closeTime: Date.now(), net: -4.2, what: 'trade 3 of the day' }],
         breachCount: 1, brokenTrips: 1, keptTrips: 3, avgBroken: -4.2, avgKept: 2, cost: -6.2, thin: true }));
       goalsData.today = { scored: 2, kept: 1, broken: [g.label], offTrack: [] };
       goalOpen = 'g0'`);
  const board = show('goals');
  assert.deepEqual([...board.matchAll(/class="gl-mark (\w+)"/g)].map(m => m[1]), ['broken', 'progress', 'kept', 'idle', 'paused']);
  assert.match(board, /broke today[\s\S]*2\/2 today[\s\S]*starts with the next captured entry[\s\S]*paused/);
  assert.match(board, /est\. cost <b class="dn">−\$6\.20<\/b>/);
  assert.deepEqual(strayValues(board), []);
  assert.match(show('overview'), /gl-overview[\s\S]*today 1 of 2 kept · <span class="dn">✗ Max 2 trades a day · Europe/);

  run(`openGoalBreach('ETHUSDT', Date.now() - 36e5)`);
  await settle('tripsData && !tripsLoading', 'the trips');
  assert.equal(run('jrTab'), 'trades');
  assert.equal(run('filteredTrips().every(t => t.symbol === "ETHUSDT")'), true);
  assert.match(show('trades'), /onclick="filterTrades\('day', null\)"/);
});

test('Milestones: a block under the rules, every state renders, the chart projects, the drawer takes a date', async () => {
  const { markup, run, settle } = await bootPage();
  await fetch(`${base}/api/history/sync?start=true`);
  for (let i = 0; i < 200 && (await (await fetch(`${base}/api/history/sync`)).json()).state.running; i++) {
    await new Promise(r => setTimeout(r, 25));
  }
  run(`setView('journal')`);
  await settle('perfData && !perfLoading && goalsData && !goalsLoading', 'the journal and goals');
  const show = tab => { run(`jrTab = '${tab}'; riskForceRender = true; render(lastData)`); return markup.get('content'); };
  const now = Date.now(), day = 864e5;
  run(`const base = { type: 'accountTarget', unit: 'milestone', params: { target: 2e6, by: null }, setAt: ${now - 20 * day}, pausedAt: null,
         start: 1000, current: 1500, asOf: ${now}, target: 2e6, progress: 0.0005, paceFraction: null, deadline: null, days: 20, perDay: 25,
         eta: ${now + 900 * day}, reachedAt: null,
         chart: [0, 1, 2].map(i => ({ t: ${now} - (2 - i) * ${day}, value: 1000 + i * 250 })),
         projection: [{ t: ${now}, value: 1500 }, { t: ${now + 30 * day}, value: 2250 }] };
       goalsData.goals = ['open', 'onpace', 'late', 'early', 'reached', 'missed', 'paused'].map((status, i) => ({ ...base, id: 'm' + i, status,
         label: 'Account ≥ $' + (i + 1) + '00k', deadline: ['onpace', 'late', 'missed'].includes(status) ? ${now + 10 * day} : null,
         paceFraction: status === 'late' ? 0.6 : null, pausedAt: status === 'paused' ? ${now} : null }));
       goalsData.goals.push({ id: 'dd', type: 'monthlyDrawdown', unit: 'milestone', label: 'Monthly drawdown under 10%', params: { maxPct: 10 },
         setAt: ${now - 40 * day}, status: 'progress', n: 1, adherence: 1, streak: 1, pausedAt: null,
         month: { ddPct: -3.2, limit: 10, approx: false }, before: { n: 2, adherence: 0.5, worst: -14.1, approx: true },
         strip: Array.from({ length: 12 }, (_, i) => ({ day: ${now} - (11 - i) * 30 * ${day}, state: i === 11 ? 'progress' : i > 9 ? 'kept' : 'unset', ddPct: i > 9 ? -2 : null, approx: false })) });
       goalsData.today = { scored: 0, kept: 0, broken: [], offTrack: [{ label: 'Account ≥ $250k', status: 'late' }] };
       goalOpen = 'm0'`);
  const board = show('goals');
  assert.match(board, /No goals yet[\s\S]*section-label gl-block">Milestones/, 'rule suggestions still offered above the milestones');
  assert.deepEqual([...board.matchAll(/gl-mark (\w+)">/g)].map(m => m[1]),
    ['open', 'onpace', 'late', 'early', 'reached', 'missed', 'paused', 'progress']);
  assert.match(board, /class="gl-proj"[^>]*stroke-dasharray/);
  assert.match(board, /target \$2,000,000\.00 is off the chart/);
  assert.match(board, /not enough history · 20\.0 of 7 days|on pace for/);
  assert.match(board, /−3\.2% of −10% this month/);
  assert.deepEqual(strayValues(board), []);
  run(`goalOpen = 'dd'`);
  assert.match(show('goals'), /Before you set it: 50% of 2 months kept · worst −14\.1% ≈ wallet/);
  assert.match(show('overview'), /gl-late">◔ Account ≥ \$250k late/);

  run(`openGoalDrawer(); setGoalType('accountTarget')`);
  assert.match(markup.get('goalDrawerBody'), /type="date"[\s\S]*optional/);
  assert.doesNotMatch(markup.get('goalDrawerBody'), /Applies/);
  run(`setGoalParam('target', '2000000')`);
  await run('loadGoalPreview()');
  assert.match(markup.get('goalPreview'), /Now \$[\d,.]+( ≈ wallet)? · needs \+\$/);
  run(`setGoalType('monthlyDrawdown')`);
  await run('loadGoalPreview()');
  assert.deepEqual(strayValues(markup.get('goalPreview')), []);
});
