// util.js — small shared helpers: delays, the shared snapshot, in-flight request dedupe, and the
// reader's clock from a request.

import { clockFor } from '../local-time.js';



// ── Utility ───────────────────────────────────────────────────────────────
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// Jitter: returns delay ± 20%
export function jitter(ms) {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

// One in-flight request and one recent result per account read, shared by every route and
// every open tab. Without it each tab polled both exchanges on its own, so the request quota
// scaled with the number of tabs rather than with use. Rejections are never cached.
const SNAPSHOT_TTL_MS = 10_000;

export function sharedSnapshot(fetcher, ttlMs = SNAPSHOT_TTL_MS) {
  let value = null, at = 0, pending = null;
  const read = ({ maxAgeMs = ttlMs } = {}) => {
    if (value && Date.now() - at < maxAgeMs) return Promise.resolve(value);
    pending ??= fetcher()
      .then(v => { value = v; at = Date.now(); return v; })
      .finally(() => { pending = null; });
    return pending;
  };
  read.ageMs = () => (value ? Date.now() - at : null);
  return read;
}

// Concurrent callers asking for the same series share one request: the two legs of a hedge
// are the same symbol, and fanned out in parallel they would otherwise both fetch.
const inflight = new Map();

export function once(key, fn) {
  if (!inflight.has(key)) inflight.set(key, fn().finally(() => inflight.delete(key)));
  return inflight.get(key);
}

/** The reader's clock from `?zone=` (IANA name), falling back to the fixed offset `?tz=` in minutes. */
export function readerClock(query) {
  return clockFor(query.zone, parseInt(query.tz, 10) || 0);
}
