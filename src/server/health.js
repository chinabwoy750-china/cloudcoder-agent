import { isOpenCodeReady } from '../agent/opencode.js';
import { config } from '../config/env.js';
import { postgresHealth } from '../storage/postgres.js';
import { objectStorageHealth } from '../storage/objects.js';
import { isolationMode } from '../worker/runner.js';

export async function healthHandler(req, res) {
  const db = await postgresHealth();
  const objects = await objectStorageHealth();
  const ok = isOpenCodeReady() && (!db.configured || db.ready) && objects.ready;
  res.status(ok ? 200 : 503).json({
    status: ok ? 'healthy' : 'starting',
    service: 'cloudcoder-agent',
    version: '1.0.0',
    opencode: isOpenCodeReady() ? 'ready' : 'not-ready',
    database: db.configured ? (db.ready ? 'ready' : 'not-ready') : 'not-configured',
    isolation: isolationMode(),
    objects: {
      mode: objects.mode,
      ready: objects.ready,
      configured: objects.configured,
    },
    features: {
      github: !!config.github.token,
      telegram: !!config.telegram.token,
    },
    timestamp: new Date().toISOString(),
  });
}
