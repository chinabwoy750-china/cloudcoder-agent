import { isOpenCodeReady } from '../agent/opencode.js';
import { config } from '../config/env.js';
import { postgresHealth } from '../storage/postgres.js';

export async function healthHandler(req, res) {
  const db = await postgresHealth();
  const ok = isOpenCodeReady() && (!db.configured || db.ready);
  res.status(ok ? 200 : 503).json({
    status: ok ? 'healthy' : 'starting',
    service: 'cloudcoder-agent',
    version: '1.0.0',
    opencode: isOpenCodeReady() ? 'ready' : 'not-ready',
    database: db.configured ? (db.ready ? 'ready' : 'not-ready') : 'not-configured',
    features: {
      github: !!config.github.token,
      telegram: !!config.telegram.token,
    },
    timestamp: new Date().toISOString(),
  });
}
