// venues.js — which exchanges the server may call. A venue that is off costs nothing: its
// account reads return an empty book and its request functions refuse outright, so a
// forgotten call path fails loudly instead of spending quota. Saved in data/settings.json.

import fs from 'fs';
import path from 'path';
import { BINANCE_API_KEY, DATA_DIR, HL_WALLET } from './config.js';

export const VENUES = ['binance', 'hyperliquid'];
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const configured = { binance: !!BINANCE_API_KEY, hyperliquid: !!HL_WALLET };

function readSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return {}; }
}

const saved = readSettings().venues || {};
const enabled = Object.fromEntries(VENUES.map(v => [v, configured[v] && saved[v] !== false]));

export const isConfigured = venue => configured[venue];
export const isEnabled = venue => enabled[venue] === true;

/** Switches a venue and saves the choice; a venue without credentials cannot be switched on. */
export function setEnabled(venue, on) {
  if (on && !configured[venue]) throw new Error(`${venue} has no credentials in .env`);
  enabled[venue] = on;
  const settings = readSettings();
  settings.venues = { ...settings.venues, [venue]: on };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

export function assertVenueEnabled(venue, what) {
  if (!isEnabled(venue)) throw new Error(`${venue} is switched off (${what} skipped)`);
}

export const venueOffBody = venue => ({ ok: false, disabled: true, venue, error: `${venue} is switched off` });
