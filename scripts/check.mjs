// check.mjs — zero-dependency static checks, run by `npm run check` and `npm run verify`
//
// Syntax of every module and of the page's scripts, assets the page references, the route
// table in the docs against the routes the server registers, and guards for bugs that have
// already shipped once.

import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { execFileSync } from 'child_process';
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

const jsFiles = walk(ROOT, n => /\.(m?js)$/.test(n));
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    fail(`syntax: ${rel(file)}\n${String(err.stderr).trim()}`);
  }
}

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
for (const file of pageSources) {
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (/fundingRate[^;\n]*\*\s*3\b/.test(line)) fail(`${rel(file)}:${i + 1} multiplies funding by 3 — use fundingPerDay(p)`);
    if (rendersRawError(line)) fail(`${rel(file)}:${i + 1} renders an error message without esc()`);
  });
}

if (failures.length) {
  console.error(`check: ${failures.length} problem${failures.length > 1 ? 's' : ''}\n\n${failures.join('\n\n')}`);
  process.exit(1);
}
console.log(`check: ${jsFiles.length} modules, page scripts, assets, ${registered.size} routes and guards — ok`);
