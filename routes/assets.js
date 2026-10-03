// assets.js — the engines the browser imports. The panels and the API run the same files,
// so they can never drift apart.

import path from 'path';
import { ROOT_DIR } from '../lib/config.js';

export function register(app) {
  const serve = file => (req, res) => res.type('application/javascript').sendFile(path.join(ROOT_DIR, file));
  app.get('/risk-engine.js', serve('risk-engine.js'));
  app.get('/calc-engine.js', serve('calc-engine.js'));
}
