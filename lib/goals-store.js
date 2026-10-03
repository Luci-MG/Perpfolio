// goals-store.js — the goals you set, in data/goals.json. Every change is validated against
// GOAL_TYPES and written to a temp file then renamed, so a crash never leaves half a file.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { validateGoal } from '../goals.js';
import { DATA_DIR } from './config.js';

const GOALS_FILE = path.join(DATA_DIR, 'goals.json');

export function readGoals() {
  try {
    const goals = JSON.parse(fs.readFileSync(GOALS_FILE, 'utf8'));
    return Array.isArray(goals) ? goals : [];
  } catch {
    return [];
  }
}

function writeGoals(goals) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${GOALS_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(goals, null, 2) + '\n');
  fs.renameSync(tmp, GOALS_FILE);
}

function updateGoal(goals, id, change) {
  if (!goals.some(g => g.id === id)) throw new Error(`no goal ${id}`);
  return goals.map(g => (g.id === id ? change(g) : g)).filter(Boolean);
}

const isPaused = g => g.pauses.some(p => p.to == null);

const ACTIONS = {
  add: (goals, body, now) => [...goals, { id: crypto.randomUUID(), ...validateGoal(body), setAt: now, pauses: [], history: [] }],
  edit: (goals, body, now) => updateGoal(goals, body.id, g => ({
    ...g, ...validateGoal({ ...body, type: g.type }),
    history: [...g.history, { params: g.params, session: g.session, until: now }]
  })),
  pause: (goals, body, now) => updateGoal(goals, body.id, g => (isPaused(g) ? g : { ...g, pauses: [...g.pauses, { from: now, to: null }] })),
  resume: (goals, body, now) => updateGoal(goals, body.id, g => ({ ...g, pauses: g.pauses.map(p => (p.to == null ? { ...p, to: now } : p)) })),
  delete: (goals, body) => updateGoal(goals, body.id, () => null)
};

export const GOAL_ACTIONS = Object.keys(ACTIONS);

/**
 * Applies one change — `body.action` is one of GOAL_ACTIONS — and saves the result. Throws a
 * readable Error, saving nothing, when the change is invalid. Editing keeps the set date.
 */
export function changeGoals(body, now = Date.now()) {
  const apply = ACTIONS[body?.action];
  if (!apply) throw new Error(`action must be one of ${GOAL_ACTIONS.join(', ')}`);
  const goals = apply(readGoals(), body, now);
  writeGoals(goals);
  return goals;
}
