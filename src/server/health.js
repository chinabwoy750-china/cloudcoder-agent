import { isOpenCodeReady } from '../agent/opencode.js';
import { config } from '../config/env.js';

export function healthHandler(req, res) {
  const ok = isOpenCodeReady();
  res.status(ok ? 200 : 503).json({
    status: ok ? 'healthy' : 'starting',
    service: 'cloudcoder-agent',
    version: '1.0.0',
    opencode: ok ? 'ready' : 'not-ready',
    features: {
      github: !!config.github.token,
      telegram: !!config.telegram.token,
    },
    timestamp: new Date().toISOString(),
  });
}
