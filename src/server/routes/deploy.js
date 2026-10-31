import { Router } from 'express';
import { requireAuth, requireAdmin } from '../../auth/session.js';
import { listDeployProviders, listDeployTargets, saveDeployTarget, deleteDeployTarget, triggerDeploy } from '../../deploy/adapters.js';
import { writeAuditEvent } from '../../db/audit.js';
import { rateLimitMiddleware } from '../../utils/ratelimit.js';

export function deployRouter() {
  const router = Router();

  router.get('/providers', requireAuth, (req, res) => {
    res.json({ providers: listDeployProviders() });
  });

  router.get('/targets', requireAuth, requireAdmin, async (req, res, next) => {
    try { res.json(await listDeployTargets()); } catch (err) { next(err); }
  });

  router.post('/targets', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const target = await saveDeployTarget(req.body || {});
      await writeAuditEvent({ ownerUserId: req.authUserId, eventType: 'admin.deploy_target_save', details: { id: target.id, provider: target.provider } });
      res.status(201).json({ ok: true, target });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });

  router.delete('/targets/:id', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      await deleteDeployTarget(req.params.id);
      await writeAuditEvent({ ownerUserId: req.authUserId, eventType: 'admin.deploy_target_delete', details: { id: req.params.id } });
      res.json({ ok: true });
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });

  router.post(
    '/targets/:id/deploy',
    requireAuth,
    requireAdmin,
    rateLimitMiddleware({ windowMs: 60_000, max: 5 }),
    async (req, res, next) => {
      try {
        if (req.body?.authorizeDeploy !== true) {
          return res.status(403).json({ error: 'Set authorizeDeploy=true to confirm intentional deployment' });
        }
        const result = await triggerDeploy(req.params.id, { authorizeDeploy: true });
        await writeAuditEvent({
          ownerUserId: req.authUserId,
          eventType: 'admin.deploy_trigger',
          details: { id: req.params.id, status: result.status, provider: result.provider },
        });
        res.json(result);
      } catch (err) {
        if (err.status) return res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
        next(err);
      }
    }
  );

  return router;
}
