import { Router } from 'express';
import { setSessionCookie, clearSessionCookie, requireAuth, parseCookies, verifySession } from '../../auth/session.js';
import { checkCredentials } from '../../auth/basic.js';
import { config } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { rateLimitMiddleware } from '../../utils/ratelimit.js';

export function authRouter() {
  const router = Router();

  router.post(
    '/login',
    rateLimitMiddleware({ windowMs: 15 * 60 * 1000, max: 20 }),
    (req, res) => {
      const { username, password } = req.body || {};
      if (!username || !password || !checkCredentials(username, password)) {
        logger.warn(`Login failed from ${req.ip}`);
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      setSessionCookie(res, username);
      res.json({ ok: true, user: username });
    }
  );

  router.post('/logout', (req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => {
    const cookies = parseCookies(req);
    const session = verifySession(cookies[config.session.cookieName]);
    if (!session) return res.status(401).json({ error: 'Not authenticated' });
    res.json({ user: session.user });
  });

  return router;
}
