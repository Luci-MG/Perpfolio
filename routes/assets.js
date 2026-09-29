import path from 'path';
import { ROOT_DIR } from '../lib/config.js';

export function register(app) {
  // The stress engine runs in the browser too — same file, so the panel and the API
  // can never drift apart.
  app.get('/risk-engine.js', (req, res) => {
    res.type('application/javascript').sendFile(path.join(ROOT_DIR, 'risk-engine.js'));
  });
}
