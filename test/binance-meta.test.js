import test from 'node:test';
import assert from 'node:assert/strict';
import { intervalAt } from '../lib/binance-meta.js';

const at = hour => Date.UTC(2026, 9, 3, hour);

test('a next settlement off the declared interval\'s hours reveals a shorter interval', () => {
  assert.deepEqual([intervalAt(8, at(16)), intervalAt(8, at(12)), intervalAt(8, at(2)), intervalAt(8, at(1))], [8, 4, 2, 1]);
  assert.deepEqual([intervalAt(4, at(20)), intervalAt(4, at(5)), intervalAt(1, at(7))], [4, 1, 1]);
  assert.equal(intervalAt(8, null), 8, 'no settlement time leaves the declared interval');
  assert.equal(intervalAt(8, at(3) + 30 * 60_000), 8, 'an off-hour time is not a settlement time');
});
