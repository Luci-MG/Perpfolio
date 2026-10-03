// config.js — environment, exchange base URLs and the project root. Loads .env first, so
// every module that imports it can read process.env at load time.

import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

export const PORT = process.env.PORT || 3000;
export const BINANCE_API_KEY    = process.env.BINANCE_API_KEY || '';
export const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET || '';
export const HL_WALLET          = process.env.HL_WALLET_ADDRESS || '';

export const BINANCE_BASE    = 'https://fapi.binance.com';
export const BINANCE_WS_BASE = 'wss://fstream.binance.com/private/ws';
export const HL_BASE         = 'https://api.hyperliquid.xyz/info';

export const FETCH_TIMEOUT_MS = 10_000;

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.DASHBOARD_DATA_DIR || path.join(ROOT_DIR, 'data');
