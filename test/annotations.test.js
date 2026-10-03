import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.DASHBOARD_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-notes-'));
const { annotationsFor, cleanAnnotation, readAnnotations, saveAnnotation } = await import('../lib/annotations-store.js');
test.after(() => fs.rmSync(process.env.DASHBOARD_DATA_DIR, { recursive: true, force: true }));

const trip = (key, openOrderId) => ({ key, openOrderId });

test('tags are normalised and limited, notes are limited', () => {
  assert.deepEqual(cleanAnnotation({ note: '  late entry ', tags: ['Breakout', 'breakout', ' News Day '] }),
    { note: 'late entry', tags: ['breakout', 'news-day'] });
  assert.throws(() => cleanAnnotation({ note: 'x'.repeat(501) }), /500/);
  assert.throws(() => cleanAnnotation({ tags: ['a', 'b', 'c', 'd', 'e', 'f'] }), /at most 5/);
  assert.throws(() => cleanAnnotation({ tags: ['<b>'] }), /letters, digits and dashes/);
  assert.throws(() => cleanAnnotation({ tags: ['x'.repeat(25)] }), /up to 24/);
  assert.throws(() => cleanAnnotation({ tags: 'breakout' }), /list/);
});

test('a note saves, matches by key or by opening order after a rebuild, and an empty one removes it', () => {
  saveAnnotation(trip('BTCUSDT:LONG:1', 11), { note: 'chased', tags: ['revenge'] }, 5);
  saveAnnotation(trip('ETHUSDT:LONG:2', 22), { note: 'fine', tags: [] }, 6);
  const rebuilt = [trip('BTCUSDT:LONG:1', 11), trip('ETHUSDT:LONG:9', 22)];
  const { matched, orphans } = annotationsFor(rebuilt);
  assert.equal(matched.get('BTCUSDT:LONG:1').note, 'chased');
  assert.equal(matched.get('ETHUSDT:LONG:9').note, 'fine', 'found by opening order id');
  assert.equal(orphans, 0);
  assert.equal(annotationsFor([trip('BTCUSDT:LONG:1', 11)]).orphans, 1);

  saveAnnotation(trip('BTCUSDT:LONG:1', 11), { note: '', tags: [] });
  assert.deepEqual(Object.keys(readAnnotations()), ['ETHUSDT:LONG:2']);
});

test('a note found by opening order is edited and cleared in place, leaving no orphan behind', () => {
  saveAnnotation(trip('SOLUSDT:LONG:3', 33), { note: 'first', tags: [] }, 7);
  const moved = trip('SOLUSDT:LONG:4', 33);
  saveAnnotation(moved, { note: 'second', tags: [] }, 8);
  assert.equal(annotationsFor([moved]).matched.get('SOLUSDT:LONG:4').note, 'second');
  assert.equal(Object.keys(readAnnotations()).filter(k => k.startsWith('SOLUSDT')).join(), 'SOLUSDT:LONG:4');
  saveAnnotation(trip('SOLUSDT:LONG:5', 33), { note: '', tags: [] });
  assert.deepEqual(Object.keys(readAnnotations()).filter(k => k.startsWith('SOLUSDT')), []);
});
