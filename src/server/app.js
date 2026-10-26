import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireAuth, csrfGuard } from '../auth/session.js';
import { healthHandler } from './health.js';
import { opencodeProxy } from './proxy.js';
import { securityHeaders, corsGuard } from './security.js';
import { authRouter } from './routes/auth.js';
import { agentRouter } from './routes/agent.js';
import { githubRouter } from './routes/github.js';
import { filesRouter } from './routes/files.js';
import { modelsRouter } from './routes/models.js';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { rateLimitMiddleware } from '../utils/ratelimit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIR = path.join(__dirname, '..', 'ui');

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(securityHeaders);
  app.use(corsGuard);
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  app.use((req, _res, next) => { logger.debug(`${req.method} ${req.path}`); next(); });

  // Public health check
  app.get('/health', healthHandler);

  // Global rate limit on the authenticated surface
  app.use(rateLimitMiddleware({ windowMs: 60000, max: 600 }));

  // Login / logout / me
  app.use('/api/auth', authRouter());

  // Static UI (login page is public; the app itself fetches /api/auth/me)
  app.use('/', express.static(UI_DIR, { index: 'index.html', dotfiles: 'deny' }));

  // Everything below requires auth
  app.use('/api', requireAuth, csrfGuard);

  app.get('/api/status', async (req, res) => {
    const { isOpenCodeReady } = await import('../agent/opencode.js');
    const { resolveDefaultModelRef, getCachedModels } = await import('../config/custom-models.js');
    const cache = getCachedModels();
    res.json({
      ok: true,
      user: req.authUser,
      method: req.authMethod,
      phase: 'complete',
      defaultModel: resolveDefaultModelRef() || config.agent.defaultModel || null,
      customModel: config.customAI.model
        ? `${config.customAI.provider}/${config.customAI.model}`
        : null,
      openCodeReady: isOpenCodeReady(),
      modelCount: cache.models?.length || 0,
    });
  });

  app.use('/api/agent', agentRouter());
  app.use('/api/models', modelsRouter());
  app.use('/api/github', githubRouter());
  app.use('/api', filesRouter());

  // Raw OpenCode API, still behind auth
  app.use('/opencode', requireAuth, opencodeProxy);

  app.use((req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    let status = err.status || err.statusCode || 500;
    if (!err.status && err.code && ['PATH_ESCAPE','FORBIDDEN_FILE','CONFIRM_REQUIRED','TOO_LARGE'].includes(err.code)) {
      status = 400;
    }
    if (err.code === 'OPENCODE_NOT_READY') status = 503;
    logger.error(`Request error ${req.method} ${req.path}: ${err.message}`);
    if (res.headersSent) return;
    if (status === 400 || status === 403 || status === 409 || status === 413 || status === 404) {
      return res.status(status).json({ error: err.message, code: err.code });
    }
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}
