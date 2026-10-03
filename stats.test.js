import test from 'node:test';
import assert from 'node:assert/strict';
import { shrunkMeans } from './stats.js';

const HITS_IN_45 = [18, 17, 16, 15, 14, 14, 13, 12, 11, 11, 10, 10, 10, 10, 10, 9, 8, 7];
const REST_OF_SEASON = [0.346, 0.298, 0.276, 0.222, 0.273, 0.270, 0.263, 0.210, 0.269, 0.230, 0.264, 0.256, 0.303, 0.264, 0.226, 0.285, 0.316, 0.200];
const atBats = hits => Array.from({ length: 45 }, (_, i) => (i < hits ? 1 : 0));

test('shrinkage beats raw averages on Efron and Morris\'s 1970 batting data', () => {
  const r = shrunkMeans(HITS_IN_45.map((h, i) => ({ key: i, values: atBats(h) })));
  const error = pick => r.groups.reduce((s, g, i) => s + (pick(g) - REST_OF_SEASON[i]) ** 2, 0);
  const raw = error(g => g.mean), shrunk = error(g => g.shrunk);
  assert.ok(shrunk < raw / 2.5, `total squared error ${shrunk.toFixed(4)} against ${raw.toFixed(4)} raw`);
  assert.ok(r.groups.every(g => g.ci.lo < g.shrunk && g.shrunk < g.ci.hi));
});

test('a thin group gets needs instead of an average, and chance says how many would clear by luck', () => {
  const r = shrunkMeans([{ key: 'a', values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }, { key: 'b', values: [100, 101] },
                         { key: 'c', values: [5, 6, 5, 6, 5, 6, 5, 6] }], { min: 8 });
  assert.deepEqual(r.groups.map(g => [g.key, g.n, g.needs]), [['a', 10, 0], ['b', 2, 6], ['c', 8, 0]]);
  assert.equal(r.groups[1].total, 201, 'a total is a fact, shown at any size');
  assert.deepEqual([r.chance.shown, r.chance.byChance], [2, 0]);
});

test('identical groups shrink all the way to the overall average, with an interval from its own uncertainty', () => {
  const r = shrunkMeans(['x', 'y'].map(key => ({ key, values: [1, 3, 1, 3, 1, 3, 1, 3] })));
  assert.equal(r.tau, 0);
  assert.ok(r.groups.every(g => g.shrunk === 2 && g.ci.hi > 2));
  assert.equal(shrunkMeans([]).overall, null);
});
