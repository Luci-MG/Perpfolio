// sessions.js — trading sessions by each market's own clock, daylight saving included: Tokyo,
// London and New York hours on their weekdays. One label per moment for analytics, and the
// opens, closes and next change the session clock shows. Served to the browser at /sessions.js.

const MARKETS = [
  { id: 'asia',   name: 'Tokyo',    zone: 'Asia/Tokyo',       open: 9, close: 18 },
  { id: 'europe', name: 'London',   zone: 'Europe/London',    open: 8, close: 17 },
  { id: 'us',     name: 'New York', zone: 'America/New_York', open: 8, close: 17 }
];
export const SESSIONS = ['Asia', 'Europe', 'Europe + US', 'US', 'Off-hours', 'Weekend'];

const STEP_MS = 15 * 60_000;
const HORIZON_MS = 4 * 86_400_000;
const formatters = new Map();
const WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
const NEW_YORK = 'America/New_York';
const FRIDAY_CLOSE_HOUR = 17;

function localClock(ts, zone) {
  if (!formatters.has(zone)) {
    formatters.set(zone, new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', hour: '2-digit',
                                                            minute: '2-digit', hourCycle: 'h23' }));
  }
  const parts = Object.fromEntries(formatters.get(zone).formatToParts(ts).map(p => [p.type, p.value]));
  return { weekday: parts.weekday, hour: +parts.hour + +parts.minute / 60 };
}

function isOpen(market, ts) {
  const { weekday, hour } = localClock(ts, market.zone);
  return WEEKDAYS.has(weekday) && hour >= market.open && hour < market.close;
}

function marketsOpen(ts) {
  return MARKETS.filter(m => isOpen(m, ts));
}

function isWeekend(ts) {
  const { weekday, hour } = localClock(ts, NEW_YORK);
  return weekday === 'Sat' || weekday === 'Sun' || (weekday === 'Fri' && hour >= FRIDAY_CLOSE_HOUR);
}

/**
 * The one session label for `ts`: London takes over from Tokyo at its open, the London–New York
 * overlap is its own, and with no market open it is Weekend from New York's Friday close to
 * Tokyo's Monday open, else Off-hours.
 */
export function sessionOf(ts) {
  const open = new Set(marketsOpen(ts).map(m => m.id));
  if (open.has('europe') && open.has('us')) return 'Europe + US';
  if (open.has('us')) return 'US';
  if (open.has('europe')) return 'Europe';
  if (open.has('asia')) return 'Asia';
  return isWeekend(ts) ? 'Weekend' : 'Off-hours';
}

function nextFlip(now, read) {
  const current = read(now);
  for (let t = Math.floor(now / STEP_MS) * STEP_MS + STEP_MS; t <= now + HORIZON_MS; t += STEP_MS) {
    if (read(t) !== current) return t;
  }
  return null;
}

/** What the clock shows at `now`: the session, the next change, and each market's next open or close. */
export function clockAt(now) {
  const changeAt = nextFlip(now, sessionOf);
  return {
    session: sessionOf(now),
    next: changeAt && { at: changeAt, session: sessionOf(changeAt) },
    markets: MARKETS.map(m => {
      const open = isOpen(m, now);
      return { name: m.name, open, [open ? 'closesAt' : 'opensAt']: nextFlip(now, t => isOpen(m, t)) };
    })
  };
}
