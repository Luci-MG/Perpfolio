// local-time.js — the reader's calendar: days, weeks, months and hours in their own time zone,
// with each timestamp converted at the offset in force at that moment, so trades either side
// of a daylight-saving change land on the right day and hour. A `tz` is either a clock from
// clockFor() or a fixed offset in minutes ahead of UTC. Pure.

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function offsetFromParts(format, ts) {
  const p = Object.fromEntries(format.formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((local - Math.floor(ts / 1000) * 1000) / 60_000);
}

/**
 * A clock for the IANA time zone `zone` (e.g. 'Europe/Madrid'), or a fixed `fallbackOffsetMin`
 * when the zone is missing or unknown. `offsetAt(ts)` is the zone's offset from UTC in minutes
 * at that instant.
 */
export function clockFor(zone, fallbackOffsetMin = 0) {
  let format = null;
  try {
    if (typeof zone === 'string' && zone) {
      format = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric',
                                                  day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    }
  } catch {
    format = null;
  }
  if (!format) return { zone: null, offsetAt: () => fallbackOffsetMin };
  const byHour = new Map();
  return {
    zone,
    offsetAt(ts) {
      const hour = Math.floor(ts / HOUR_MS);
      if (!byHour.has(hour)) byHour.set(hour, offsetFromParts(format, ts));
      return byHour.get(hour);
    }
  };
}

/** Offset from UTC in minutes at `ts` for a clock or a fixed offset. */
export function offsetAt(tz, ts) {
  return typeof tz === 'number' ? tz : tz?.offsetAt(ts) ?? 0;
}

/** `ts` shifted to local wall time: read it with the getUTC* methods. */
export function wallTime(ts, tz) {
  return new Date(ts + offsetAt(tz, ts) * 60_000);
}

/** The instant local midnight starts on calendar date (y, m, d), m from 0; overflowing days roll over. */
export function localMidnight(y, m, d, tz) {
  const wall = Date.UTC(y, m, d);
  const guess = wall - offsetAt(tz, wall) * 60_000;
  return wall - offsetAt(tz, guess) * 60_000;
}

/** Start of the local day containing `ts`. */
export function localDayStart(ts, tz) {
  const w = wallTime(ts, tz);
  return localMidnight(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), tz);
}

/** Start of the local day after the one starting at `dayStart`; 23 or 25 hours on a clock change. */
export function nextLocalDay(dayStart, tz) {
  return localDayStart(dayStart + DAY_MS + 12 * HOUR_MS, tz);
}

/** The local calendar date (YYYY-MM-DD) of `ts`. */
export function localDate(ts, tz) {
  return wallTime(ts, tz).toISOString().slice(0, 10);
}

/** Start of the local week (Monday) containing `ts`. */
export function localWeekStart(ts, tz) {
  const w = wallTime(localDayStart(ts, tz), tz);
  return localMidnight(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate() - (w.getUTCDay() + 6) % 7, tz);
}
