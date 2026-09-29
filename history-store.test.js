import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as store from './history-store.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
}

test('appendNdjson writes rows and reads them back', () => {
  const dir = tmp(), file = path.join(dir, 'a.ndjson');
  const r = store.appendNdjson(file, [{ id: 1, v: 'a' }, { id: 2, v: 'b' }], x => x.id);
  assert.deepEqual(r, { added: 2, skipped: 0 });
  assert.deepEqual(store.readNdjson(file).map(x => x.v), ['a', 'b']);
});

test('a re-run adds nothing — the whole point of the cursor design', () => {
  const dir = tmp(), file = path.join(dir, 'a.ndjson');
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
  store.appendNdjson(file, rows, x => x.id);
  const again = store.appendNdjson(file, rows, x => x.id);
  assert.deepEqual(again, { added: 0, skipped: 3 });
  assert.equal(store.readNdjson(file).length, 3);

  const overlap = store.appendNdjson(file, [{ id: 3 }, { id: 4 }], x => x.id);
  assert.deepEqual(overlap, { added: 1, skipped: 1 });
  assert.equal(store.readNdjson(file).length, 4);
});

test('duplicates inside a single batch are collapsed', () => {
  const dir = tmp(), file = path.join(dir, 'a.ndjson');
  const r = store.appendNdjson(file, [{ id: 7 }, { id: 7 }, { id: 8 }], x => x.id);
  assert.deepEqual(r, { added: 2, skipped: 1 });
});

test('rows without a key are dropped rather than duplicated forever', () => {
  const dir = tmp(), file = path.join(dir, 'a.ndjson');
  const r = store.appendNdjson(file, [{ id: null }, { id: 1 }], x => x.id);
  assert.equal(r.added, 1);
});

test('a torn final line does not poison the read', () => {
  const dir = tmp(), file = path.join(dir, 'a.ndjson');
  store.appendNdjson(file, [{ id: 1 }], x => x.id);
  fs.appendFileSync(file, '{"id":2,"broke');          // simulates a kill mid-write
  const rows = store.readNdjson(file);
  assert.equal(rows.length, 1, 'the good rows still load');
  assert.equal(store.appendNdjson(file, [{ id: 2 }], x => x.id).added, 1, 'and it can be repaired');
});

test('missing files read as empty, not as an error', () => {
  assert.deepEqual(store.readNdjson(path.join(tmp(), 'nope.ndjson')), []);
  assert.deepEqual(store.readJson(path.join(tmp(), 'nope.json'), { a: 1 }), { a: 1 });
});

test('corrupt meta falls back instead of throwing', () => {
  const dir = tmp(), file = path.join(dir, 'meta.json');
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(store.readJson(file, { cursors: {} }), { cursors: {} });
});

test('meta round-trips', () => {
  const dir = tmp(), file = path.join(dir, 'meta.json');
  store.writeJson(file, { lastIncomeTime: 123, trades: { ETHUSDT: 99 } });
  assert.equal(store.readJson(file).trades.ETHUSDT, 99);
});

test('tradesFile cannot escape the data directory', () => {
  const dir = '/tmp/data';
  assert.equal(store.tradesFile(dir, 'ETHUSDT'), '/tmp/data/trades-ETHUSDT.ndjson');
  assert.equal(store.tradesFile(dir, '../../etc/passwd'), '/tmp/data/trades-etcpasswd.ndjson');
  assert.ok(!store.tradesFile(dir, '../x').includes('..'));
});

test('storeStats counts what is on disk', () => {
  const dir = tmp();
  store.appendNdjson(store.tradesFile(dir, 'ETHUSDT'), [{ id: 1 }], x => x.id);
  store.appendNdjson(store.tradesFile(dir, 'BTCUSDT'), [{ id: 1 }], x => x.id);
  store.appendNdjson(path.join(dir, 'income.ndjson'), [{ id: 1 }], x => x.id);
  const s = store.storeStats(dir);
  assert.equal(s.files, 3);
  assert.deepEqual(s.symbols, ['BTCUSDT', 'ETHUSDT']);
  assert.ok(s.bytes > 0);
  assert.deepEqual(store.storeStats(path.join(dir, 'nope')), { files: 0, bytes: 0, symbols: [] });
});

test('a torn last line does not swallow the next appended row', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-torn-'));
  const file = path.join(dir, 'x.ndjson');
  fs.writeFileSync(file, '{"id":1}\n{"id":2');
  store.appendNdjson(file, [{ id: 3 }, { id: 4 }], r => r.id);
  assert.deepEqual(store.readNdjson(file).map(r => r.id), [1, 3, 4]);
});
