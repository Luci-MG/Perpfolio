import test from 'node:test';
import assert from 'node:assert/strict';
import { clockFor, localDate, localDayStart, localMidnight, nextLocalDay, offsetAt, wallTime } from './local-time.js';
import { periodStarts } from './trade-analytics.js';

const HOUR = 3_600_000;
const madrid = clockFor('Europe/Madrid');

test('a zone clock follows daylight saving; a fixed offset never moves', () => {
  assert.equal(madrid.offsetAt(Date.UTC(2026, 0, 15)), 60);
  assert.equal(madrid.offsetAt(Date.UTC(2026, 6, 15)), 120);
  assert.equal(offsetAt(90, Date.UTC(2026, 6, 15)), 90);
});

test('an unknown or missing zone falls back to the fixed offset', () => {
  assert.equal(clockFor('Mars/Olympus', 30).offsetAt(0), 30);
  assert.equal(clockFor(undefined, -300).zone, null);
});

test('a trade at the same UTC hour lands on different local hours either side of the change', () => {
  const winter = Date.UTC(2026, 2, 28, 22), summer = Date.UTC(2026, 2, 29, 22);
  assert.deepEqual([wallTime(winter, madrid).getUTCHours(), wallTime(summer, madrid).getUTCHours()], [23, 0]);
  assert.equal(localDate(summer, madrid), '2026-03-30');
});

test('local days start at local midnight, and the day of the change is 23 hours long', () => {
  const day = localDayStart(Date.UTC(2026, 2, 29, 12), madrid);
  assert.equal(day, Date.UTC(2026, 2, 28, 23));
  assert.equal(nextLocalDay(day, madrid) - day, 23 * HOUR);
  assert.equal(nextLocalDay(localDayStart(Date.UTC(2026, 9, 25, 12), madrid), madrid) - localDayStart(Date.UTC(2026, 9, 25, 12), madrid), 25 * HOUR);
});

test('a month that spans the change starts at its own local midnight', () => {
  const p = periodStarts(Date.UTC(2026, 3, 2, 12), madrid);
  assert.equal(p.month, Date.UTC(2026, 2, 31, 22), 'April 1st 00:00 in summer time');
  assert.equal(p.week, Date.UTC(2026, 2, 29, 22), 'Monday 30 March 00:00, the day after the change');
});

test('a half-hour zone reads the right offset either side of its change, whichever instant is asked first', () => {
  const change = Date.UTC(2026, 9, 3, 16, 30);
  const asked = clockFor('Australia/Adelaide');
  assert.equal(asked.offsetAt(change - 15 * 60_000), 570);
  assert.equal(asked.offsetAt(change + 15 * 60_000), 630);
  const reversed = clockFor('Australia/Adelaide');
  assert.equal(reversed.offsetAt(change + 15 * 60_000), 630);
  assert.equal(reversed.offsetAt(change - 15 * 60_000), 570);
});

test('where the clock skips midnight, the day starts when it resumes, not on the day before', () => {
  const santiago = clockFor('America/Santiago');
  const start = localMidnight(2026, 8, 6, santiago);
  assert.equal(start, Date.UTC(2026, 8, 6, 4));
  assert.equal(localDate(start, santiago), '2026-09-06');
  assert.equal(localDayStart(Date.UTC(2026, 8, 6, 12), santiago), start);
});
