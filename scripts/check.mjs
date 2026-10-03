// check.mjs — zero-dependency static checks, run by `npm run check` and `npm run verify`
//
// Syntax of every module and of the page's scripts, assets the page references, the route
// table in the docs against the routes the server registers, and guards for bugs that have
// already shipped once.

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const fail = msg => failures.push(msg);
const rel = f => path.relative(ROOT, f);

function walk(dir, keep) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return ['node_modules', 'data', '.git'].includes(e.name) ? [] : walk(full, keep);
    return keep(e.name) ? [full] : [];
  });
}

const run = promisify(execFile);
const jsFiles = walk(ROOT, n => /\.(m?js)$/.test(n));
await Promise.all(jsFiles.map(file => run(process.execPath, ['--check', file])
  .catch(err => fail(`syntax: ${rel(file)}\n${String(err.stderr).trim()}`))));

const htmlPath = path.join(ROOT, 'public', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
for (const [, inline] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
  try { new vm.Script(inline, { filename: 'index.html <script>' }); } catch (err) { fail(`syntax: index.html inline script — ${err.message}`); }
}
for (const [, ref] of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="(\/?[^"]+)"/g)) {
  if (/^https?:/.test(ref)) continue;
  if (!fs.existsSync(path.join(ROOT, 'public', ref))) fail(`index.html references missing file ${ref}`);
}

const serverSources = [path.join(ROOT, 'server.js'), ...walk(path.join(ROOT, 'routes'), n => n.endsWith('.js'))];
const registered = new Set(serverSources.flatMap(f =>
  [...fs.readFileSync(f, 'utf8').matchAll(/app\.(get|post|put|delete)\(\s*'([^']+)'/g)].map(([, m, p]) => `${m.toUpperCase()} ${p}`)));
const docPath = [path.join(ROOT, 'docs', 'api.md'), path.join(ROOT, 'CLAUDE.md')].find(fs.existsSync);
const documented = new Set([...fs.readFileSync(docPath, 'utf8').matchAll(/^\|\s*`(GET|POST|PUT|DELETE) ([^`?\s]+)/gm)]
  .map(([, m, p]) => `${m} ${p}`));
for (const r of registered) if (!documented.has(r)) fail(`route ${r} is not in the route table of ${rel(docPath)}`);
for (const r of documented) if (!registered.has(r)) fail(`${rel(docPath)} documents ${r}, which the server does not register`);

const interpolatedError = /\$\{(?!esc\()[^}]*\.(?:error|message)\b[^}]*\}/;
const concatenatedError = /\+\s*[\w$?.]+\.(?:error|message)\b|[\w$?.]+\.(?:error|message)\s*\+\s*['"`]/;
const rendersRawError = line => !/\.textContent\s*=/.test(line) && (interpolatedError.test(line) || concatenatedError.test(line));

const pageSources = [htmlPath, ...walk(path.join(ROOT, 'public', 'js'), n => n.endsWith('.js'))];
const handlerString = /\son(?:click|change|input|keydown)="[^"]*'\$\{/;
const rawExchangeText = /\$\{(?!esc\()[\w?.]+\.(?:pair|symbol|asset|coin)\}/;
for (const file of pageSources) {
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const at = `${rel(file)}:${i + 1}`;
    if (rendersRawError(line)) fail(`${at} renders an error message without esc()`);
    if (handlerString.test(line)) fail(`${at} passes a value to an inline handler inside quotes — use \${jsArg(value)}`);
    if (rawExchangeText.test(line) && !/textContent|getElementById|querySelector|`\$\{p\.exchange\}:/.test(line)) fail(`${at} puts exchange text into markup without esc()`);
  });
}

const serverFiles = [...serverSources, ...walk(path.join(ROOT, 'lib'), n => n.endsWith('.js')),
                     ...fs.readdirSync(ROOT).filter(n => n.endsWith('.js') && !n.endsWith('.test.js')).map(n => path.join(ROOT, n))];
for (const file of [...new Set([...serverFiles, ...pageSources])]) {
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (/fundingRate[^;\n]*\*\s*3\b/.test(line)) fail(`${rel(file)}:${i + 1} multiplies funding by 3 — use the symbol's own interval`);
  });
}

// Each guard below is a rule in CLAUDE.md that a shipped bug taught.
const SERIAL_AWAIT_ALLOWED = new Set(['lib/history-sync.js', 'lib/trip-enrichment.js']);
const loopOverBook = /\bfor\s*\((?:const|let)\s+[^)]*\bof\s+[^)]*\b(positions|legs|assets|symbols|pools|groups)\b/;
for (const file of serverFiles) {
  if (SERIAL_AWAIT_ALLOWED.has(rel(file))) continue;
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (!loopOverBook.test(line)) return;
    let depth = 0;
    for (let j = i; j < lines.length; j++) {
      depth += (lines[j].match(/\{/g) || []).length - (lines[j].match(/\}/g) || []).length;
      if (/\bawait\b/.test(lines[j]) && !/async\s*(\(|\w+\s*=>)/.test(lines[j])) {
        fail(`${rel(file)}:${j + 1} awaits inside a loop over the book — fan out with Promise.all`);
        break;
      }
      if (depth <= 0 && j > i) break;
    }
  });
  lines.forEach((line, i) => {
    if (/\b[A-Z_a-z]\w*\[(?:req\.)?(?:query|body|params)\??\.\w+\]/.test(line) && !/Object\.hasOwn/.test(line)) {
      fail(`${rel(file)}:${i + 1} looks up a request value as an object key — check Object.hasOwn first`);
    }
    if (/\bequity\s*[:=]\s*[^,;\n]*\b(?:totalWalletBalance|walletBalance)\b/.test(line) && rel(file) !== 'lib/binance-account.js') {
      fail(`${rel(file)}:${i + 1} reads equity from the wallet — equity is the margin balance`);
    }
  });
}

const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
for (const [, link] of claude.matchAll(/\]\((docs\/[^)#]+)\)/g)) {
  if (!fs.existsSync(path.join(ROOT, link))) fail(`CLAUDE.md links to missing ${link}`);
}
const architecture = fs.readFileSync(path.join(ROOT, 'docs', 'architecture.md'), 'utf8');
for (const file of serverFiles.filter(f => !rel(f).startsWith('routes/') && rel(f) !== 'server.js')) {
  if (!architecture.includes(path.basename(file))) fail(`docs/architecture.md does not mention ${rel(file)}`);
}
const scriptOrder = [...html.matchAll(/<script src="\/js\/([\w-]+)\.js"/g)].map(m => m[1]);
const archOrder = (architecture.match(/`core → [^`]+`/)?.[0] ?? '').replace(/`/g, '').split(/\s*→\s*/).map(s => s.trim());
if (archOrder.join() !== scriptOrder.join()) fail(`docs/architecture.md load order differs from index.html: ${scriptOrder.join(' → ')}`);
const frontendDoc = fs.readFileSync(path.join(ROOT, 'docs', 'frontend.md'), 'utf8');
const tableOrder = [...frontendDoc.matchAll(/^\| \w+ \| `([\w-]+)\.js` \|/gm)].map(m => m[1]);
if (tableOrder.join() !== scriptOrder.join()) fail(`docs/frontend.md script table differs from index.html: ${scriptOrder.join(', ')}`);

if (failures.length) {
  console.error(`check: ${failures.length} problem${failures.length > 1 ? 's' : ''}\n\n${failures.join('\n\n')}`);
  process.exit(1);
}
console.log(`check: ${jsFiles.length} modules, page scripts, assets, ${registered.size} routes and guards — ok`);
