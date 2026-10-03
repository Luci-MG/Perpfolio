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

async function syncHistory() {
  await fetch(`${base}/api/history/sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  for (let i = 0; i < 200 && (await (await fetch(`${base}/api/history/sync`)).json()).state.running; i++) {
    await new Promise(r => setTimeout(r, 25));
  }
}

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
  await settle('volStopData && riskBook && perfData && cfData && !cfLoading', 'every tab fetch');

  const bad = [];
  for (const v of VIEWS) {
    run(`posView = '${v}'; riskForceRender = true; render(lastData)`);
    for (const hit of strayValues(markup.get('content') + markup.get('sidebar'))) bad.push(`${v}: …${hit}…`);
  }
  assert.equal(run('JSON.stringify(loadErrors)'), '{}', 'every tab loaded');
  assert.deepEqual(bad, []);
});

test('the Trades table sorts, filters, pages and exports what it shows', async () => {
  const { markup, run, settle } = await bootPage();
  await syncHistory();
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
    volStopData.positions = ['none', 'hedged', 'unknown', 'tight', 'wide', 'breakeven', 'locks', 'ok'].map(verdict => ({ ...base, verdict,
      ratio: verdict === 'locks' ? null : 0.8, lockedPct: verdict === 'locks' ? 1.5 : null,
      yourStop: ['none', 'hedged', 'unknown'].includes(verdict) ? null
        : { price: 95, distancePct: 1.2, atrMultiple: 1.4, hit: { rate: 0.41, windows: 176, independent: 7, days: 8.3 } } }));
    riskForceRender = true; render(lastData)`);
  const html = markup.get('content');
  for (const label of ['No stop', 'Hedged', 'Too tight', 'Too wide', 'Breakeven', 'Locks profit', 'OK']) assert.match(html, new RegExp(label));
  assert.match(html, /hit within 24h in 41% of windows/);
  assert.match(html, /1 stop unknown · 1 without a stop · 1 too tight · 1 too wide/);
  assert.match(html, /stop orders could not be read/);
  assert.deepEqual(strayValues(html), []);

  run(`setView('tiles')`);
  assert.equal((markup.get('content').match(/class="sl-alert"/g) || []).length, 3,
    'ETH, ENA and SOL have no stop and no hedge; the BTC legs are a hedge and the long has a stop');

  run(`lastData = { ...lastData, binance: { ...lastData.binance,
    positions: lastData.binance.positions.map(p => ({ ...p, stop: null, hasStop: null, stopKnown: false })) } }; render(lastData)`);
  const unknown = markup.get('content');
  assert.equal((unknown.match(/class="stop-mark unknown"/g) || []).length, 4, 'every Binance leg reads unknown');
  assert.equal((unknown.match(/class="sl-alert"/g) || []).length, 1, 'only the Hyperliquid leg, whose orders were read, says no stop');
});

test('a venue that failed to read shows as unavailable, and a banner says the totals leave it out', async () => {
  const { markup, run } = await bootPage();
  run(`const data = { ...lastData, summary: { ...lastData.summary, partial: ['hyperliquid'] },
    hyperliquid: { ...lastData.hyperliquid, error: 'HL → 500', equity: '0.00', positions: [] } };
  render(data); showPartialBanner(document.getElementById('errBanner'), data)`);
  assert.match(markup.get('content'), /Hyperliquid[\s\S]*unavailable/);
  assert.equal(run(`document.getElementById('errBanner').textContent`), 'Hyperliquid unavailable (HL → 500) — totals exclude it');
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

  run(`ctxPosition = lastData.binance.positions.find(p => p.symbol === 'BTCUSDT' && p.side === 'Long'); openCalc('pnl')`);
  await settle('document.getElementById("pnlInvested").value', 'the sized field');
  assert.match(String(value('pnlInvested')), /^\d{4,}(\.\d+)?$/, 'a number input takes no thousands separator');
  run(`ctxPosition = lastData.binance.positions.find(p => p.symbol === 'ENAUSDC'); openCalc('liq')`);
  await settle('document.getElementById("liqAccPrice").textContent', 'the account-aware liq');

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
  await syncHistory();
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
  assert.doesNotMatch(overview, /account [+−$]/, 'no snapshots yet');
  assert.match(overview, /vs yesterday by now[\s\S]*vs last week by now[\s\S]*vs last month by now/);
  assert.match(overview, /class="ov-pair"[\s\S]*Next milestone[\s\S]*Recent trades/);
  const [, [, performance], [, behaviour]] = renderAll();
  assert.match(performance, /Return[\s\S]*Drawdown[\s\S]*Win rate[\s\S]*Expectancy[\s\S]*Payoff[\s\S]*Sharpe/);
  assert.match(performance, /Sharpe[\s\S]*± [\d.]+[\s\S]*chance above 0: \d+%/);
  assert.match(performance, /\d+ units \(\d+ legs\)/);
  assert.match(performance, /Longest losing streak[\s\S]*reshuffling the same results/);
  assert.match(behaviour, /Added to a losing position[\s\S]*Set a rule[\s\S]*Position size at open/);
  assert.doesNotMatch(performance + behaviour, /BOTH|both|\$—/);

  run(`perfData.account = { ...perfData.account, ratios: { n: 12, needs: 48 } }`);
  assert.match(renderAll()[1][1], /needs 48 more days of returns \(12 of 60\)/);
  run(`perfData.units = { ...perfData.units, units: 0 }`);
  const [, [, emptyPerformance], [, emptyBehaviour]] = renderAll();
  assert.match(emptyPerformance, /No trips in this window/);
  assert.match(emptyBehaviour, /No trips in this window/);
  assert.deepEqual(strayValues(emptyPerformance + emptyBehaviour), []);
  run(`fetchPerformance()`);
  await settle('perfData && !perfLoading && perfData.units.units', 'the journal again');

  run(`perfData.accountCurve = [0, 1, 2].map(i => ({ t: Date.now() - (3 - i) * 9e5, accountValue: 1000 + i * 10 }));
       perfData.periods.today.account = { change: 20, since: Date.now() - 27e5, partial: true }`);
  const withSnaps = renderAll()[0][1];
  assert.match(withSnaps, /class="ov-account"/);
  assert.match(withSnaps, /account \+\$20\.00 \(partial\)/);
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

  await syncHistory();
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
  for (const [tab, note] of [['timing', /trips only: the calendar is their net/], ['symbols', /trips only\./], ['costs', /trips only, except the wallet ledger/]]) {
    run(`jrTab = '${tab}'; riskForceRender = true; render(lastData)`);
    assert.match(markup.get('content'), note, tab);
    assert.deepEqual(strayValues(markup.get('content')), [], tab);
  }

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

test('Timing, Symbols and Costs: calendar days and symbols open their trades, averages wait for enough trades, costs read in basis points', async () => {
  const { markup, run, settle } = await bootPage();
  await syncHistory();
  run(`setView('journal')`);
  await settle('perfData && !perfLoading && perfData.timing', 'the journal');
  const show = tab => { run(`jrTab = '${tab}'; riskForceRender = true; render(lastData)`); return markup.get('content'); };

  const timing = show('timing');
  assert.match(timing, /<button class="jr-cal-cell cal-(gain|loss)-\d"[^>]*aria-label="[^"]+: [+−]\$[\d,.]+, \d+ trades? closed"/);
  assert.match(timing, /orange is a loss, blue a gain/);
  assert.match(timing, /Day of the week opened[\s\S]*average after \d+ more[\s\S]*Hour opened[\s\S]*When you open positions/);
  assert.ok(timing.split('<div class="sb-row').filter(r => r.startsWith(' needs')).every(r => !r.split('</div>')[0].includes('sb-dot')), 'no estimate is drawn below the minimum');
  const day = run('perfData.timing.calendar.weeks.flatMap(w => w.days).find(d => d.trips).date');
  run(`openTradesFor({ closeDay: '${day}' })`);
  await settle('tripsData && !tripsLoading', 'the trips');
  assert.equal(run('jrTab'), 'trades');
  assert.ok(run('filteredTrips().length') > 0 && run(`filteredTrips().every(t => browserDate(t.closeTime) === '${day}')`));
  assert.match(markup.get('content'), new RegExp(`closed ${day} ✕`));

  const symbols = show('symbols');
  assert.match(symbols, /carry \d+% of the book's gross profit and loss ·\s+by notional you trade like [\d.]+ equal-sized symbols/);
  assert.match(symbols, /<td><span class="(up|dn)">[+−]\$[\d.]+<\/span> <span class="gl-n" title="90% interval">/);
  run(`sortSymbols('symbol')`);
  assert.equal(run('sortedSymbolRows(perfData.symbols.rows)[0].symbol'), 'BTCUSDT');
  run(`openTradesFor({ symbol: 'BTCUSDT', exact: true })`);
  assert.ok(run(`filteredTrips().every(t => t.symbol === 'BTCUSDT')`));

  const costs = show('costs');
  assert.match(costs, /Fees<\/div><div class="v ">[\d.]+ bp/);
  assert.match(costs, /your rates \(maker 2\.0 bp, taker 5\.0 bp\)[\s\S]*BNB fee discount on[\s\S]*BNB of fees ≈ \$/);
  assert.match(costs, /Slippage: not measured/);
  assert.match(costs, /Costs by week[\s\S]*Funding paid by symbol[\s\S]*Funding received by symbol/);
  for (const html of [timing, symbols, costs]) assert.deepEqual(strayValues(html), []);
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
  await syncHistory();
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
  assert.match(show('overview'), /class="ov-attention"[\s\S]*class="ov-attn dn" onclick="setJrTab\('goals'\)">✗ Max 2 trades a day · Europe broke today ›[\s\S]*Goals today: 1 of 2 kept/);

  run(`openGoalBreach('ETHUSDT', Date.now() - 36e5)`);
  await settle('tripsData && !tripsLoading', 'the trips');
  assert.equal(run('jrTab'), 'trades');
  assert.equal(run('filteredTrips().every(t => t.symbol === "ETHUSDT")'), true);
  assert.match(show('trades'), /onclick="filterTrades\('day', null\)"/);
});

test('Milestones: a block under the rules, every state renders, the chart projects, the drawer takes a date', async () => {
  const { markup, run, settle } = await bootPage();
  await syncHistory();
  run(`setView('journal')`);
  await settle('perfData && !perfLoading && goalsData && !goalsLoading', 'the journal and goals');
  const show = tab => { run(`jrTab = '${tab}'; riskForceRender = true; render(lastData)`); return markup.get('content'); };
  const now = Date.now(), day = 864e5;
  run(`const base = { type: 'accountTarget', unit: 'milestone', params: { target: 2e6, by: null }, setAt: ${now - 20 * day}, pausedAt: null,
         start: 1000, current: 1500, asOf: ${now}, target: 2e6, progress: 0.0005, paceFraction: null, deadline: null, days: 20, perDay: 25,
         eta: ${now + 900 * day}, reachedAt: null,
         chart: [0, 1, 2].map(i => ({ t: ${now} - (2 - i) * ${day}, value: 1000 + i * 250 })),
         projection: [{ t: ${now}, value: 1500 }, { t: ${now + 30 * day}, value: 2250 }] };
       goalsData.goals = ['open', 'onpace', 'late', 'early', 'reached', 'reachedLate', 'missed', 'paused'].map((status, i) => ({ ...base, id: 'm' + i, status,
         label: 'Account ≥ $' + (i + 1) + '00k', deadline: ['onpace', 'late', 'missed', 'reachedLate'].includes(status) ? ${now + 10 * day} : null,
         reachedAt: status === 'reachedLate' ? ${now + 13 * day} : base.reachedAt,
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
    ['open', 'onpace', 'late', 'early', 'reached', 'reachedLate', 'missed', 'paused', 'progress']);
  assert.match(board, /reached [^·<]+, 3 days after the date/);
  assert.match(board, /class="gl-proj"[^>]*stroke-dasharray/);
  assert.match(board, /target \$2,000,000\.00 is off the chart/);
  assert.match(board, /not enough history · 20\.0 of 7 days|on pace for/);
  assert.match(board, /−3\.2% of −10% this month/);
  assert.deepEqual(strayValues(board), []);
  run(`goalOpen = 'dd'`);
  assert.match(show('goals'), /Before you set it: 50% of 2 months kept · worst −14\.1% ≈ wallet/);
  const overview = show('overview');
  assert.match(overview, /class="ov-attn dn"[^>]*>✗ Account ≥ \$700k missed ›[\s\S]*class="ov-attn gl-late"[^>]*>◔ Account ≥ \$300k late ›/, 'missed ranks above late');
  assert.match(overview, /Next milestone[\s\S]*Account ≥ \$100k[\s\S]*more after it/, 'the lowest open target leads');

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

test('Factors: verdict first, the board on demand, waiting factors named, a goal from a losing factor', async () => {
  const { markup, run, settle } = await bootPage();
  await syncHistory();
  run(`setView('journal')`);
  await settle('perfData && !perfLoading && goalsData && !goalsLoading', 'the journal');
  run(`setJrTab('factors')`);
  await settle('factorsData && !factorsLoading', 'the factors');
  const show = () => { run(`jrTab = 'factors'; riskForceRender = true; render(lastData)`); return markup.get('content'); };
  assert.match(show(), /\d+ comparisons · \d+ trips over \d+ days · exploratory/);
  assert.deepEqual(strayValues(show()), []);

  run(`const b = { bucket: 'Weekend', label: 'Weekday or weekend', n: 31, days: 11, thin: true, avgNet: -12.5, restAvgNet: 4, diff: -16.5,
         ci: { lo: -30.1, hi: -3.2 }, p: 0.004, medianDiff: 2, medianDisagrees: true, winRate: 0.29, winCi: { lo: 0.17, hi: 0.44 },
         restWinRate: 0.55, net: -387.5, share: 0.4, stability: 'holds', signFlip: true, standsOut: true,
         goal: { type: 'noSessions', params: { sessions: ['Weekend'] } } };
       factorsData = { ...factorsData, comparisons: 27, worse: [{ ...b, factor: 'weekend' }], better: [{ ...b, bucket: 'Asia', label: 'Session', diff: 9, ci: { lo: 1, hi: 17 }, goal: null }],
         waiting: ['Confluence at entry', 'Leverage at entry'], entryCaptured: 0,
         factors: [{ id: 'weekend', label: 'Weekday or weekend', buckets: [b], hiddenBuckets: 1 }],
         during: [{ id: 'adds', label: 'Added while underwater', buckets: [{ ...b, bucket: 'Added underwater', standsOut: false }], hiddenBuckets: 0 }] }`);
  const verdict = show();
  assert.match(verdict, /✗[\s\S]*Weekend[\s\S]*−\$16\.50\/trip[\s\S]*\[−\$30\.10, −\$3\.20\][\s\S]*holds recently[\s\S]*⚑[\s\S]*≠ median[\s\S]*set a goal ›/);
  assert.match(verdict, /✓[\s\S]*Asia[\s\S]*\+\$9\.00\/trip/);
  assert.match(verdict, /Confluence at entry, Leverage at entry: waiting for captured entries \(0 so far\)/);
  assert.doesNotMatch(verdict, /During the trade/);

  run(`toggleFactorsShowAll()`);
  const board = show();
  assert.match(board, /class="fx-ci dn"/);
  assert.match(board, /1 bucket under 20 trips or 8 days/);
  assert.match(board, /During the trade[\s\S]*Added underwater/);
  assert.deepEqual(strayValues(board), []);

  run(`openFactorGoal(0)`);
  assert.deepEqual(JSON.parse(run('JSON.stringify(goalDraft)')), { id: null, type: 'noSessions', params: { sessions: ['Weekend'] }, session: null });
});

test('a failed load keeps each tab\'s controls with Retry, escapes the message, and a failed refresh keeps the last good data', async () => {
  const { markup, run, settle } = await bootPage();
  await syncHistory();
  run(`setView('stress')`);
  await settle('riskBook && !riskLoading', 'the risk book');
  const view = v => { run(`posView = '${v}'; riskForceRender = true; render(lastData)`); return markup.get('content'); };
  const failing = () => run(`realFetch = realFetch || fetch; fetch = () => Promise.reject(new Error('<b>down</b>'))`);
  const working = () => run('fetch = realFetch');
  run('var realFetch = null');
  const failed = (html, controls, retry, what) => {
    assert.match(html, controls, `${what}: controls kept`);
    assert.match(html, new RegExp(`Couldn’t load</span> · &lt;b&gt;down&lt;/b&gt;[\\s\\S]*onclick="${retry}">Retry`), `${what}: escaped error with Retry`);
    assert.doesNotMatch(html, /<b>down/, `${what}: never raw`);
  };

  failing();
  await run(`riskBook = null; fetchRiskBook(true)`);
  failed(view('stress'), /Refresh marks/, 'fetchRiskBook\\(true\\)', 'stress');
  failed(view('unwind'), />Plan</, 'fetchRiskBook\\(true\\)', 'unwind');
  await run(`volStopData = null; fetchVolStops()`);
  failed(view('stops'), /vol-|Risk/, 'fetchVolStops\\(\\)', 'stops');
  await run(`cfData = null; fetchConfluence()`);
  failed(view('confluence'), /cf-sym/, 'fetchConfluence\\(\\)', 'confluence');
  await run(`perfData = null; fetchPerformance()`);
  failed(view('journal'), /Sync recent[\s\S]*Full rebuild/, 'fetchPerformance\\(\\)', 'journal');
  await run(`hlData = null; openHlDrawer()`);
  failed(markup.get('hlDrawerBody'), /./, 'openHlDrawer\\(\\)', 'hedge ledger');

  working();
  await run('fetchRiskBook(true)');
  await run('fetchPerformance()');
  await settle('perfData && !perfLoading', 'the journal');
  assert.equal(run('loadErrors.risk ?? null'), null, 'a good load clears the error');
  for (const [tab, reset, fetcher, retry] of [['trades', 'tripsData', 'fetchTrips()', 'fetchTrips\\(\\)'],
    ['goals', 'goalsData', 'fetchGoals()', 'fetchGoals\\(\\)'], ['factors', 'factorsData', 'fetchFactors()', 'fetchFactors\\(\\)']]) {
    failing();
    await run(`${reset} = null; ${fetcher}`);
    run(`jrTab = '${tab}'`);
    failed(view('journal'), /jr-subtab/, retry, tab);
    working();
  }

  failing();
  await run('fetchPerformance()');
  for (const [tab, kept] of [['performance', /Win rate/], ['behaviour', /Added to a losing position/]]) {
    run(`jrTab = '${tab}'`);
    const html = view('journal');
    assert.match(html, /Couldn’t refresh<\/span> · &lt;b&gt;down&lt;\/b&gt;[\s\S]*showing the last good data/, tab);
    assert.match(html, kept, `${tab}: the last good data is kept`);
  }
  working();

  failing();
  await run('fetchRiskBook(true)');
  const stale = view('stress');
  assert.match(stale, /Couldn’t refresh<\/span> · &lt;b&gt;down&lt;\/b&gt;[\s\S]*showing the last good data/);
  assert.match(stale, /Refresh marks/);
  assert.ok(run('riskBook.pools.length') > 0, 'the last good book is kept');
  assert.deepEqual(strayValues(stale), []);
  working();
});

test('notes and tags: the inline editor saves and cancels, chips and the tag filter work, and a note renders escaped', async () => {
  const { markup, run, settle } = await bootPage();
  await syncHistory();
  run(`setView('journal')`);
  await settle('perfData && !perfLoading', 'the journal');
  run(`setJrTab('trades')`);
  await settle('tripsData && !tripsLoading', 'the trips');
  const show = () => { run(`jrTab = 'trades'; riskForceRender = true; render(lastData)`); return markup.get('content'); };
  const table = () => markup.get('jt-table');
  show();
  const key = run('sortedTrips(filteredTrips())[0].key');

  run(`editTripNote('${key}')`);
  assert.match(table(), /class="jt-edit"[\s\S]*id="jt-note-text"[\s\S]*Save/);
  run(`cancelTripNote()`);
  assert.doesNotMatch(table(), /jt-edit/);

  run(`editTripNote('${key}')`);
  run(`document.getElementById('jt-note-text').value = '<b>chased</b> it'; document.getElementById('jt-note-tags').value = 'Revenge, late-entry'`);
  await run(`saveTripNote('${key}')`);
  assert.equal(run('noteEditing'), null);
  assert.match(table(), /title="&lt;b&gt;chased&lt;\/b&gt; it"[\s\S]*jt-tag">revenge[\s\S]*jt-tag">late-entry/);
  assert.doesNotMatch(table(), /<b>chased/);

  run(`filterTrades('tag', 'revenge')`);
  assert.equal(run('filteredTrips().length'), 1);
  assert.match(show(), /<option value="revenge" selected>revenge<\/option>/);
  assert.match(run('tradesCsv()').split('\n')[0], /,note,tags/);

  run(`editTripNote('${key}')`);
  run(`document.getElementById('jt-note-tags').value = 'a, b, c, d, e, f'`);
  await run(`saveTripNote('${key}')`);
  assert.match(table(), /class="dn">at most 5 tags/);
  run(`document.getElementById('jt-note-text').value = ''; document.getElementById('jt-note-tags').value = ''`);
  await run(`saveTripNote('${key}')`);
  run(`filterTrades('tag', 'all')`);
  assert.deepEqual(strayValues(show()), []);
});

test('funding: the widget counts down to the next settlement, the drawer nets hedges and flags a leg near its cap', async () => {
  const { markup, run } = await bootPage();
  run(`lastData.binance.positions.forEach(p => { p.nextFundingTime = Date.now() + 36e5; }); riskForceRender = true; render(lastData)`);
  assert.match(markup.get('sidebar'), /Daily funding[\s\S]*\/day est\.[\s\S]*next in <span data-until="\d+">1h 00m/);
  assert.match(markup.get('sidebar'), /fw-row"><span>HL[\s\S]*fw-row"><span>BN/, 'both venue rows');
  run(`const hlLegs = lastData.hyperliquid.positions; lastData.hyperliquid.positions = []; riskForceRender = true; render(lastData); lastData.hyperliquid.positions = hlLegs`);
  assert.match(markup.get('sidebar'), /fw-row"><span>HL<\/span><span class="sb-num ">\$0\.00/, 'a venue with no positions still shows, at zero');

  await run('openFundDrawer()');
  const body = () => markup.get('fundDrawerBody');
  assert.match(body(), /Est\. net \/ day[\s\S]*Realised 7d[\s\S]*Of equity[\s\S]*On gross/);
  assert.match(body(), /BTC hedge[\s\S]*long [−+]\$[\d,.]+ · short [−+]\$[\d,.]+ a day/);
  assert.match(body(), /ETH <span class="gl-n">long<\/span>[\s\S]*\/4h/);
  run(`fundData.rows[0].usual = { avgPct: 0.004, points: [0.002, 0.004, 0.006], lastCharged: { at: Date.now() - 36e5, ratePct: 0.006 } }; renderFundBody()`);
  assert.match(body(), /class="fd-spark"[\s\S]*its 7d avg[\s\S]*title="charged at the last settlement">\+0\.0060%/);
  assert.match(body(), /Funding by symbol over time ›/);
  assert.deepEqual(strayValues(body()), []);

  run(`fundData.realised.differsFromEstimate = null; renderFundBody()`);
  assert.match(body(), /Sync history to compare realised funding with the estimate/);
  run(`fundData.realised = { ...fundData.realised, differsFromEstimate: true, coveredDays: 7, perDay7d: -9, estimatePerDay: -3 }; renderFundBody()`);
  assert.match(body(), /Binance funding realised over the 7 days to the last sync averaged −\$9\.00 a day against −\$3\.00 estimated/);
  run(`fundData.rows[0].nearCap = { share: 0.62, receiving: false }; renderFundBody()`);
  assert.match(body(), /class="fd-flag dn">⚠ 62% of its cap — may switch to 1h settlements</);

  run(`realFetch = fetch; fetch = () => Promise.reject(new Error('down'))`);
  await run('fetchFunding()');
  assert.match(body(), /Couldn’t refresh<\/span> · down[\s\S]*showing the last good data[\s\S]*BTC hedge/);
  run(`fetch = realFetch; fundData = null`);
  run(`fetch = () => Promise.reject(new Error('down'))`);
  await run('fetchFunding()');
  assert.match(body(), /Couldn’t load<\/span> · down[\s\S]*onclick="fetchFunding\(\)">Retry/);
  run('fetch = realFetch');

  run(`closeFundDrawerForce(); openFundingHistory()`);
  assert.equal(run('jrTab'), 'costs');
  const source = fs.readFileSync(path.join(ROOT, 'public', 'js', 'funding-view.js'), 'utf8');
  assert.doesNotMatch(source, /rgba\(|#[0-9a-f]{6}/i, 'funding uses theme tokens only');
});

test('Overview: attention is ranked and capped, calm says so, recent trades open Trades, the reconciliation sits under Costs', async () => {
  const { markup, run, settle } = await bootPage();
  await syncHistory();
  run(`setView('journal')`);
  await settle('perfData && !perfLoading && goalsData && !goalsLoading', 'the journal');
  const show = tab => { run(`jrTab = '${tab}'; riskForceRender = true; render(lastData)`); return markup.get('content'); };

  run(`goalsData = { ...goalsData, goals: [], today: { scored: 0, kept: 0, broken: [], offTrack: [] } }; fundData = null; factorsData = null`);
  assert.match(show('overview'), /class="ov-calm">nothing needs attention/);

  run(`goalsData.goals = [{ id: 'r', unit: 'trip', status: 'kept', label: 'No adds underwater' }];
       goalsData.today = { scored: 2, kept: 2, broken: [], offTrack: [] }`);
  assert.match(show('overview'), /class="ov-calm">Goals today: 2 of 2 kept · nothing needs attention/);

  run(`goalsData.goals = [
         { id: 'a', unit: 'trip', status: 'broken', label: 'No adds underwater' },
         { id: 'b', unit: 'milestone', type: 'accountTarget', status: 'late', label: 'Account ≥ $50k', params: { target: 5e4 } },
         { id: 'c', unit: 'milestone', type: 'accountTarget', status: 'missed', label: 'Account ≥ $40k', params: { target: 4e4 } }];
       goalsData.today = { scored: 1, kept: 0, broken: ['No adds underwater'], offTrack: [] };
       fundData = { realised: { differsFromEstimate: true, perDay7d: -9, estimatePerDay: -3 }, totals: { perDay: -3 } };
       factorsData = { worse: [{ bucket: 'Weekend', diff: -16.5 }] }`);
  const busy = show('overview');
  assert.deepEqual([...busy.matchAll(/class="ov-attn [^"]+" onclick="[^"]+">([^›]+) ›/g)].map(m => m[1].trim()),
    ['✗ No adds underwater broke today', '✗ Account ≥ $40k missed', '◔ Account ≥ $50k late']);
  assert.match(busy, /\+2 more/);
  assert.match(busy, /Next milestone[\s\S]*Account ≥ \$50k/, 'the missed target is not next; the open one is');

  const recent = run('perfData.recentTrips.length');
  assert.ok(recent > 0 && recent <= 5);
  assert.equal([...busy.matchAll(/class="ov-trip"/g)].length, recent);
  assert.match(busy, /How the wallet got here ›/);
  assert.doesNotMatch(busy, /Open right now|Where the account stands|Activity</);
  assert.deepEqual(strayValues(busy), []);

  const first = JSON.parse(run('JSON.stringify(perfData.recentTrips[0])'));
  run(`openGoalBreach('${first.symbol}', ${first.openTime})`);
  await settle('tripsData && !tripsLoading', 'the trips');
  assert.equal(run('jrTab'), 'trades');
  assert.ok(run(`filteredTrips().some(t => t.key === '${first.key}')`));

  assert.match(show('costs'), /How the wallet got here[\s\S]*wallet on [\s\S]*commission rebate[\s\S]*wallet at the last sync[\s\S]*Checks: [\s\S]*Fees/);
});

test('Stress: a row fires the other assets\' crossed stops like the header, a weak beta moves alone, and no shift passes −99%', async () => {
  const { markup, run, settle } = await bootPage();
  run(`setView('stress')`);
  await settle('riskBook && riskEngine && !riskLoading', 'the risk book');
  const i = run(`riskBook.pools.findIndex(P => P.marginAsset === 'USDT')`);
  run(`riskHonorStops = true; Object.keys(riskShift).forEach(a => { riskShift[a] = 0; riskLink[a] = false; });
    riskShift.BTC = -15; riskForceRender = true; render(lastData); updateStress()`);
  const expected = run(`(() => { const P = riskBook.pools[${i}], prices = stressPrices(P), base = { ...prices, ETH: P.marks.ETH };
    const fired = riskEngine.applyStops(P.pool, P.marks, base);
    const worst = pool => \`none · worst \${fmtUsd(riskEngine.killPricesBoth(pool, 'ETH', base, stressOpts(P)).buffer.minBufferDown)}\`;
    return { fired: fired.fired.length, withStop: worst(fired.pool), without: worst(P.pool) }; })()`);
  assert.equal(expected.fired, 1, 'the BTC long stop at 90,000 is crossed at −15%');
  assert.notEqual(expected.withStop, expected.without);
  assert.equal(run(`document.getElementById('st-killdn-${i}-ETH').textContent`), expected.withStop);
  assert.match(markup.get('content'), /vs Binance<\/span><span class="v"><span class="up"[^>]*>exact/);

  run(`riskLink.BTC = true; riskLink.ETH = true; riskBeta.ETH = 0.05; riskShift.BTC = 0; setStressShift('ETH', -10)`);
  assert.equal(run('JSON.stringify([riskShift.BTC, riskShift.ETH])'), '[0,-10]', 'a β of 0.05 cannot drive the group');
  run(`riskForceRender = true; render(lastData)`);
  assert.match(markup.get('content'), /β too small to move the others/);
  run(`riskBeta.ETH = 1; setStressShift('BTC', -150)`);
  assert.ok(run('Object.values(riskShift).every(v => v >= -99)'));
});

test('Unwind plans, loads the plan into Build, keeps the slider being dragged, and switches pools', async () => {
  const { markup, run, settle } = await bootPage();
  run(`setView('unwind')`);
  await settle('riskBook && riskEngine && !riskLoading', 'the risk book');
  run(`riskForceRender = true; render(lastData)`);
  const content = () => markup.get('content');
  assert.match(content(), /Book from (just now|\d+m ago)/);
  assert.match(content(), />USDT pool</);
  assert.match(content(), />USDC pool</);
  assert.match(content(), /After the plan/);
  assert.match(content(), /in BTC terms, by beta/);
  assert.deepEqual(strayValues(content()), []);

  run(`setUw('target', '1000000')`);
  const planned = JSON.parse(run('JSON.stringify(uwLastPlan.closes)'));
  assert.ok(planned.length > 0, 'the fake book has hedges to close');
  run(`uwEditPlan()`);
  assert.equal(run('uwMode'), 'build');
  assert.match(content(), /Loaded from the plan/);
  assert.match(content(), /If you close that/);
  assert.equal(run('Object.keys(uwSel).length'), new Set(planned.map(c => c.key)).size);

  run(`setDrawerPool('USDT', uwPoolChanged); uwToggle('BTCUSDT:LONG')`);
  const built = content(), before = markup.get('uwOut');
  run(`uwSetPct('BTCUSDT:LONG', 50)`);
  assert.equal(content(), built, 'dragging rebuilds only the readout, so the slider survives');
  assert.notEqual(markup.get('uwOut'), before, 'the readout follows the drag');
  run(`uwSetPct('BTCUSDT:LONG', 50, true)`);
  assert.match(content(), /value="50"/);

  const moved = markup.get('uwMoveOut');
  run(`setUwMove(-20)`);
  assert.notEqual(markup.get('uwMoveOut'), moved);
  run(`toggleUwMoveBeta()`);
  assert.match(markup.get('uwOut'), /st-btn on"[^>]*>by beta to BTC/);

  await run(`fetchRiskBook(true)`);
  assert.equal(run('uwSel["BTCUSDT:LONG"]'), 50, 'a refreshed book keeps the selection');

  run(`setDrawerPool('USDC', uwPoolChanged)`);
  assert.match(content(), /ENA/);
  assert.equal(run('Object.keys(uwSel).length'), 0);
});

const shownText = html => [...html.matchAll(/>([^<]+)</g)].map(m => m[1]).join(' ');

test('exchange text with a quote or a tag renders as text everywhere, and handler arguments survive it', async () => {
  const { markup, run, settle } = await bootPage();
  const evil = `X'<b>Y</b>`;
  run(`lastData.binance.positions[0] = { ...lastData.binance.positions[0], pair: ${JSON.stringify(evil + '/USDT')} };
       lastData.binance.orders[0] = { ...lastData.binance.orders[0], pair: ${JSON.stringify(evil + '/USDT')}, type: ${JSON.stringify(evil)} }`);
  for (const v of ['tiles', 'list', 'orders']) {
    run(`posView = '${v}'; riskForceRender = true; render(lastData)`);
    assert.doesNotMatch(markup.get('content'), /<b>Y/, v);
  }
  assert.match(run('jsArg(' + JSON.stringify(evil) + ')'), /^&quot;X&#39;&lt;b&gt;Y&lt;\/b&gt;&quot;$/,
    'an attribute decodes this back to the JSON string literal');
  run(`setView('journal')`);
  await settle('perfData && !perfLoading', 'the journal');
  run(`perfData.symbols.rows[0] = { ...perfData.symbols.rows[0], symbol: ${JSON.stringify(evil)} };
       perfData.symbols.shown = [${JSON.stringify(evil)}]; jrTab = 'symbols'; riskForceRender = true; render(lastData)`);
  assert.doesNotMatch(markup.get('content'), /<b>Y/);
  assert.match(markup.get('content'), /onclick="openTradesFor\(\{ symbol: &quot;X&#39;&lt;b&gt;Y&lt;\/b&gt;&quot;, exact: true \}\)"/);
});

test('every negative figure on screen carries a minus glyph, never an ASCII hyphen', async () => {
  const { markup, run, settle } = await bootPage();
  run(`lastData.binance.positions.forEach(p => { p.upnl = -Math.abs(p.upnl || 5); })`);
  for (const v of VIEWS) run(`setView('${v}')`);
  await settle('volStopData && riskBook && perfData && cfData && !cfLoading', 'every tab fetch');
  const bad = [];
  for (const v of VIEWS) {
    run(`posView = '${v}'; riskForceRender = true; render(lastData)`);
    for (const html of [markup.get('content'), markup.get('sidebar')]) {
      for (const hit of shownText(html).matchAll(/(?:^|[\s(↓])(-\$?\d[\d,.]*%?)/g)) bad.push(`${v}: ${hit[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('a tile hands the calculator and the hedge popup the full position', async () => {
  const { markup, run } = await bootPage();
  const long = `lastData.binance.positions.find(p => p.symbol === 'BTCUSDT' && p.side === 'Long')`;
  const short = `lastData.binance.positions.find(p => p.symbol === 'BTCUSDT' && p.side === 'Short')`;
  assert.equal(run(`positionById(posId(${long})) === ${long}`), true);
  run(`showCtxMenu({ preventDefault() {}, clientX: 0, clientY: 0 }, positionById(posId(${long})))`);
  await run(`openCalc('liq')`);
  assert.equal(run('calcKeyOf(calcPick)'), 'binance:BTCUSDT:LONG:Long', 'the picker knows the leg');
  const popup = run(`buildHedgePopup(positionById(posId(${long})), positionById(posId(${short})))`);
  assert.match(popup, new RegExp(run(`fmtPlusUsd(fundingPerDay(${long}) + fundingPerDay(${short}))`).replace(/[$+.]/g, '\\$&')));
  assert.doesNotMatch(markup.get('content') || '', /data-pos='/);
});

test('a slower response never overwrites a newer one, and a rebuild waits while you type', async () => {
  const { markup, run, settle } = await bootPage();
  run(`setView('journal')`);
  await settle('perfData && !perfLoading', 'the journal');
  run(`const quick = fetch; fetch = (url, opts) => (String(url).includes('days=7')
         ? new Promise(r => setTimeout(r, 150)).then(() => quick(url, opts)) : quick(url, opts))`);
  run('setPerfDays(7); setPerfDays(30)');
  await new Promise(r => setTimeout(r, 400));
  assert.match(run('perfQuery'), /days=30/, 'the 7-day response arrived last and was dropped');

  run(`setJrTab('trades')`);
  await settle('tripsData && !tripsLoading', 'the trades');
  const before = markup.get('content');
  run(`document.getElementById('content').contains = () => true; document.activeElement = { tagName: 'TEXTAREA' }; rerenderStress()`);
  assert.equal(markup.get('content'), before, 'nothing rebuilt under the note being typed');
  run(`jrTab = 'overview'; rerenderStress()`);
  assert.equal(markup.get('content'), before);
  run(`document.activeElement = null; resumeContent()`);
  assert.notEqual(markup.get('content'), before, 'the deferred rebuild runs once typing ends');
});

test('small things read right: stops after a venue goes off, margin health, the live account line, locked hedges, a stale tag filter', async () => {
  const { markup, run, settle } = await bootPage();
  run(`exchFilter = new Set(['hyperliquid']); setView('stops')`);
  await settle('volStopData && !volLoading', 'the stops');
  run(`lastData = { ...lastData, venues: { binance: true, hyperliquid: false } }; riskForceRender = true; render(lastData)`);
  assert.doesNotMatch(markup.get('content'), /No open positions for selected exchanges/);
  assert.match(markup.get('sidebar'), /Margin health[\s\S]*class="b-val nu"[^>]*>off</);

  run(`setView('journal')`);
  await settle('perfData && !perfLoading', 'the journal');
  run(`jrTab = 'overview'; riskForceRender = true; render(lastData)`);
  run(`lastData = { ...lastData, lastUpdated: new Date(Date.UTC(2026, 0, 1, 9, 41)).toISOString(), binance: { ...lastData.binance, equity: '123456.00' } }; render(lastData)`);
  assert.match(run('ovAccountLine()'), /\$123,456\.00[\s\S]*as of/, 'the line the poll patches in');
  assert.match(markup.get('content'), /id="ov-account"[\s\S]*hedges locked <span class="(up|dn|)">/);

  run(`tripsData = { trips: [{ key: 'k', symbol: 'BTCUSDT', side: 'Long', tags: [] }] }; tradesFilter = { ...tradesFilter, tag: 'gone' }`);
  assert.equal(run('filteredTrips().length'), 1, 'a tag that no trip carries any more resets to Any tag');
  assert.equal(run('tradesFilter.tag'), 'all');
  assert.match(run(`renderOrdersFor([{ ...lastData.binance.orders[0], price: 0.0000123, stopPrice: 0.0000456 }])`), /\$0\.000012[\s\S]*\$0\.000046/);
});
