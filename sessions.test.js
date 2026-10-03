import test from 'node:test';
import assert from 'node:assert/strict';
import * as s from './sessions.js';

const utc = (m, d, h, min = 0) => Date.UTC(2026, m - 1, d, h, min);

test('a summer weekday walks Asia → Europe → overlap → US → off-hours (UTC)', () => {
  const day = h => s.sessionOf(utc(7, 15, h));
  assert.deepEqual([0, 6, 7, 11, 12, 15, 16, 20, 21, 23].map(day),
    ['Asia', 'Asia', 'Europe', 'Europe', 'Europe + US', 'Europe + US', 'US', 'US', 'Off-hours', 'Off-hours']);
});

test('daylight saving moves the sessions: London on 25 Oct, New York a week later', () => {
  assert.equal(s.sessionOf(utc(10, 23, 7, 30)), 'Europe', 'London summer time: open at 07:00 UTC');
  assert.equal(s.sessionOf(utc(10, 27, 7, 30)), 'Asia', 'London winter time: open at 08:00 UTC');
  assert.equal(s.sessionOf(utc(10, 27, 12, 30)), 'Europe + US', 'only London moved: the overlap starts at 12:00 UTC');
  assert.equal(s.sessionOf(utc(10, 27, 16, 30)), 'Europe + US', 'London closes at 17:00 UTC in winter');
  assert.equal(s.sessionOf(utc(10, 27, 17, 30)), 'US');
  assert.equal(s.sessionOf(utc(11, 3, 12, 30)), 'Europe', 'New York winter time: opens at 13:00 UTC');
  assert.equal(s.sessionOf(utc(11, 3, 21, 30)), 'US', 'and closes at 22:00 UTC');
});

test('the weekend runs from New York\'s Friday close to Tokyo\'s Monday open', () => {
  assert.equal(s.sessionOf(utc(10, 2, 20, 59)), 'US', 'Friday 16:59 in New York (summer time)');
  assert.equal(s.sessionOf(utc(10, 2, 21, 0)), 'Weekend', 'Friday 17:00 in New York');
  assert.equal(s.sessionOf(utc(11, 6, 21, 30)), 'US', 'winter time: New York still open at 21:30 UTC');
  assert.equal(s.sessionOf(utc(11, 6, 22, 0)), 'Weekend', 'and closes for the weekend at 22:00 UTC');
  assert.equal(s.sessionOf(utc(10, 3, 10)), 'Weekend', 'a Saturday');
  assert.equal(s.sessionOf(utc(10, 4, 23, 30)), 'Weekend', 'Sunday night UTC is not yet Monday in Tokyo');
  assert.equal(s.sessionOf(utc(10, 5, 0, 30)), 'Asia', 'Monday 09:30 in Tokyo');
  assert.equal(s.sessionOf(utc(10, 6, 23)), 'Off-hours', 'a weeknight gap stays off-hours');
});

test('the clock names the next change and each market\'s next open or close', () => {
  const c = s.clockAt(utc(7, 15, 10, 20));
  assert.equal(c.session, 'Europe');
  assert.deepEqual(c.next, { at: utc(7, 15, 12), session: 'Europe + US' });
  const london = c.markets.find(m => m.name === 'London');
  assert.deepEqual([london.open, london.closesAt], [true, utc(7, 15, 16)]);
  assert.equal(c.markets.find(m => m.name === 'New York').opensAt, utc(7, 15, 12));
  const friday = s.clockAt(utc(7, 17, 22));
  assert.deepEqual([friday.session, friday.next.at, friday.next.session], ['Weekend', utc(7, 20, 0), 'Asia'],
    'Friday night waits for Monday in Tokyo');
});
