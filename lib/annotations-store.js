// annotations-store.js — your own note and tags on a round trip, in data/annotations.json,
// keyed by the trip key with the opening order id kept as a fallback match. Written to a temp
// file then renamed, so a crash never leaves half a file.

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';

const ANNOTATIONS_FILE = path.join(DATA_DIR, 'annotations.json');
export const NOTE_MAX = 500;
export const TAGS_MAX = 5;
const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;

export function readAnnotations() {
  try {
    const all = JSON.parse(fs.readFileSync(ANNOTATIONS_FILE, 'utf8'));
    return all && typeof all === 'object' && !Array.isArray(all) ? all : {};
  } catch {
    return {};
  }
}

function writeAnnotations(all) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${ANNOTATIONS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n');
  fs.renameSync(tmp, ANNOTATIONS_FILE);
}

const slug = tag => String(tag).trim().toLowerCase().replace(/\s+/g, '-');

/** A note and tags checked and normalised; throws a readable Error otherwise. */
export function cleanAnnotation({ note = '', tags = [] } = {}) {
  if (typeof note !== 'string') throw new Error('note must be text');
  if (note.length > NOTE_MAX) throw new Error(`note is limited to ${NOTE_MAX} characters`);
  if (!Array.isArray(tags)) throw new Error('tags must be a list');
  const clean = [...new Set(tags.map(slug).filter(Boolean))];
  if (clean.length > TAGS_MAX) throw new Error(`at most ${TAGS_MAX} tags`);
  const bad = clean.find(t => !TAG_PATTERN.test(t));
  if (bad) throw new Error(`tag "${bad}" must be letters, digits and dashes, up to 24`);
  return { note: note.trim(), tags: clean };
}

/** Saves the note and tags on `trip`; an empty note with no tags removes them. */
export function saveAnnotation(trip, body, now = Date.now()) {
  const { note, tags } = cleanAnnotation(body);
  const all = readAnnotations();
  if (!note && !tags.length) delete all[trip.key];
  else all[trip.key] = { note, tags, openOrderId: trip.openOrderId ?? null, updatedAt: now };
  writeAnnotations(all);
  return all[trip.key] ?? null;
}

/** Each trip's annotation by key, else by opening order id, and how many match no trip. */
export function annotationsFor(trips, all = readAnnotations()) {
  const byOrder = new Map(Object.values(all).filter(a => a.openOrderId != null).map(a => [a.openOrderId, a]));
  const used = new Set();
  const matched = new Map(trips.map(t => {
    const a = all[t.key] ?? (t.openOrderId != null ? byOrder.get(t.openOrderId) : undefined);
    if (a) used.add(a);
    return [t.key, a ?? null];
  }));
  return { matched, orphans: Object.values(all).filter(a => !used.has(a)).length };
}
