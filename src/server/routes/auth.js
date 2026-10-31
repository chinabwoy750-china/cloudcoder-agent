import { Router } from 'express';
import { checkCredentials } from '../../auth/basic.js';
import { setSessionCookie, clearSessionCookie, requireAuth, requireAdmin } from '../../auth/session.js';
import { rateLimitMiddleware } from '../../utils/ratelimit.js';
import { authenticateDbUser, createUser, listUsers, setUserDisabled, countUsers } from '../../db/users.js';
import { isPostgresConfigured } from '../../storage/postgres.js';
import { isRegistrationEnabled, setRegistrationEnabled } from '../../db/platform-settings.js';
import { writeAuditEvent } from '../../db/audit.js';
import { logger } from '../../utils/logger.js';

export function authRouter() {
  const router = Router();

  router.get('/me', requireAuth, async (req, res) => {
    let registrationEnabled = false;
    try { registrationEnabled = await isRegistrationEnabled(); } catch { /* ignore */ }
    res.json({
      user: req.authUser,
      userId: req.authUserId || null,
      role: req.authRole || 'user',
      method: req.authMethod,
      multiUser: isPostgresConfigured(),
      registrationEnabled,
    });
  });

  router.post(
    '/login',
    rateLimitMiddleware({ windowMs: 15 * 60 * 1000, max: 20 }),
    async (req, res, next) => {
      try {
        const { username, password } = req.body || {};
        if (!username || !password) return res.status(400).json({ error: 'username and password required' });

        if (isPostgresConfigured()) {
          const dbUser = await authenticateDbUser(username, password);
          if (dbUser) {
            setSessionCookie(res, dbUser);
            await writeAuditEvent({ ownerUserId: dbUser.id, eventType: 'auth.login', details: { method: 'db' } });
            return res.json({ ok: true, user: dbUser.username, userId: dbUser.id, role: dbUser.role });
          }
          // Fall through to legacy only when no DB users exist yet
          const n = await countUsers();
          if (n > 0) {
            logger.warn(`Failed DB login for user=${String(username).slice(0, 40)}`);
            return res.status(401).json({ error: 'Invalid credentials' });
          }
        }

        if (!checkCredentials(username, password)) {
          logger.warn(`Failed login attempt for user=${String(username).slice(0, 40)}`);
          return res.status(401).json({ error: 'Invalid credentials' });
        }
        setSessionCookie(res, { id: null, username, role: 'admin' });
        res.json({ ok: true, user: username, userId: null, role: 'admin' });
      } catch (err) {
        next(err);
      }
    }
  );

  router.post('/logout', (req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  // Controlled registration: disabled by default; admin can enable.
  router.post(
    '/register',
    rateLimitMiddleware({ windowMs: 15 * 60 * 1000, max: 10 }),
    async (req, res, next) => {
      try {
        if (!isPostgresConfigured()) {
          return res.status(503).json({ error: 'Multi-user registration requires DATABASE_URL' });
        }
        const enabled = await isRegistrationEnabled();
        if (!enabled) {
          return res.status(403).json({ error: 'Registration is disabled. Ask an administrator to enable it.' });
        }
        const { username, password } = req.body || {};
        const user = await createUser({ username, password, role: 'user' });
        await writeAuditEvent({ ownerUserId: user.id, eventType: 'auth.register', details: { username: user.username } });
        setSessionCookie(res, { id: user.id, username: user.username, role: user.role });
        res.status(201).json({ ok: true, user: user.username, userId: user.id, role: user.role });
      } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message });
        next(err);
      }
    }
  );

  // Admin: list users
  router.get('/users', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      if (!isPostgresConfigured()) return res.json({ users: [], multiUser: false });
      const users = await listUsers({ limit: req.query.limit, offset: req.query.offset });
      res.json({ users, multiUser: true });
    } catch (err) { next(err); }
  });

  // Admin: create user (does not require public registration)
  router.post('/users', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      if (!isPostgresConfigured()) return res.status(503).json({ error: 'DATABASE_URL required' });
      const role = req.body?.role === 'admin' ? 'admin' : 'user';
      const user = await createUser({ username: req.body?.username, password: req.body?.password, role });
      await writeAuditEvent({
        ownerUserId: req.authUserId,
        eventType: 'admin.user_create',
        details: { targetUserId: user.id, username: user.username, role: user.role },
      });
      res.status(201).json({ ok: true, user });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });

  // Admin: disable/enable user
  router.patch('/users/:id', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      if (!isPostgresConfigured()) return res.status(503).json({ error: 'DATABASE_URL required' });
      if (req.authUserId && req.params.id === req.authUserId && req.body?.disabled === true) {
        return res.status(400).json({ error: 'Cannot disable your own account' });
      }
      const user = await setUserDisabled(req.params.id, req.body?.disabled === true);
      if (!user) return res.status(404).json({ error: 'User not found' });
      await writeAuditEvent({
        ownerUserId: req.authUserId,
        eventType: 'admin.user_disable',
        details: { targetUserId: user.id, disabled: user.disabled },
      });
      res.json({ ok: true, user });
    } catch (err) { next(err); }
  });

  // Admin: registration toggle
  router.get('/registration', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      res.json({ enabled: await isRegistrationEnabled(), multiUser: isPostgresConfigured() });
    } catch (err) { next(err); }
  });

  router.post('/registration', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      if (!isPostgresConfigured()) return res.status(503).json({ error: 'DATABASE_URL required' });
      const enabled = req.body?.enabled === true;
      await setRegistrationEnabled(enabled);
      await writeAuditEvent({
        ownerUserId: req.authUserId,
        eventType: 'admin.registration_toggle',
        details: { enabled },
      });
      res.json({ ok: true, enabled });
    } catch (err) { next(err); }
  });

  return router;
}
