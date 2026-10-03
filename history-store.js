// history-store.js — append-only NDJSON cache for account history (ESM)
//
// Binance serves income for three months and fills only through `fromId` paging, so the
// history has to be kept locally to be useful. One file per dataset, one JSON object per
// line, plus a cursor file so a resync fetches only what is new.
//
// Pure filesystem: no network here. The exchange side lives in server.js, per the rule that
// all exchange logic stays there.

import fs from 'fs';
import path from 'path';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readNdjson(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (_) { /* a torn last line is skipped */ }
  }
  return out;
}

// Appends only rows whose key is not already present, so a re-run is a no-op rather than a
// duplicate. Returns what it actually wrote.
const keyCache = new Map();

function fileStamp(file) {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return '-';
  }
}

function keysIn(file, keyOf) {
  const hit = keyCache.get(file);
  if (hit && hit.stamp === fileStamp(file) && hit.keyOf === String(keyOf)) return hit.seen;
  const seen = new Set(readNdjson(file).map(keyOf));
  keyCache.set(file, { stamp: fileStamp(file), keyOf: String(keyOf), seen });
  return seen;
}

export function appendNdjson(file, rows, keyOf) {
  if (!Array.isArray(rows) || !rows.length) return { added: 0, skipped: 0 };
  ensureDir(path.dirname(file));

  const seen = keysIn(file, keyOf);
  const fresh = [];
  for (const row of rows) {
    const key = keyOf(row);
    if (key == null || seen.has(key)) continue;
    seen.add(key);
    fresh.push(row);
  }

  if (!fresh.length) return { added: 0, skipped: rows.length };
  // A write killed mid-line leaves no trailing newline; appending straight onto it would glue
  // the first new row to the torn one, and both would then be skipped on every read.
  const torn = endsWithoutNewline(file);
  fs.appendFileSync(file, (torn ? '\n' : '') + fresh.map(r => JSON.stringify(r)).join('\n') + '\n');
  keyCache.get(file).stamp = fileStamp(file);
  return { added: fresh.length, skipped: rows.length - fresh.length };
}

function endsWithoutNewline(file) {
  if (!fs.existsSync(file)) return false;
  const { size } = fs.statSync(file);
  if (!size) return false;
  const fd = fs.openSync(file, 'r');
  try {
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}

export function readJson(file, fallback = {}) {
  if (!fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

/** Writes `value` to a temp file then renames it over `file`, so a crash never leaves half a file. */
export function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// A symbol can contain only characters that are already filesystem-safe, but the path is
// built rather than interpolated so a malformed symbol cannot escape the data directory.
export function tradesFile(dir, symbol) {
  const safe = String(symbol).replace(/[^A-Za-z0-9_-]/g, '');
  return path.join(dir, `trades-${safe}.ndjson`);
}

export function storeStats(dir) {
  if (!fs.existsSync(dir)) return { files: 0, bytes: 0, symbols: [] };
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.ndjson'));
  const bytes = files.reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);
  return {
    files: files.length,
    bytes,
    symbols: files.filter(f => f.startsWith('trades-')).map(f => f.slice(7, -7)).sort()
  };
}
