import { Router } from 'express';
import { requireAuth, requireAdmin } from '../../auth/session.js';
import { listMcpServers, saveMcpServers } from '../../integrations/mcp.js';
import { getN8nConfig, saveN8nConfig, n8nHealth } from '../../integrations/n8n.js';
import { getFigmaConfig, saveFigmaConfig } from '../../integrations/figma.js';
import { writeAuditEvent } from '../../db/audit.js';

export function integrationsRouter() {
  const router = Router();

  router.get('/mcp', requireAuth, requireAdmin, async (req, res, next) => {
    try { res.json(await listMcpServers()); } catch (err) { next(err); }
  });
  router.put('/mcp', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const result = await saveMcpServers(req.body?.servers || []);
      await writeAuditEvent({ ownerUserId: req.authUserId, eventType: 'admin.mcp_update', details: { count: result.servers.length } });
      res.json(result);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });

  router.get('/n8n', requireAuth, requireAdmin, async (req, res, next) => {
    try { res.json(await getN8nConfig()); } catch (err) { next(err); }
  });
  router.put('/n8n', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const result = await saveN8nConfig(req.body || {});
      await writeAuditEvent({ ownerUserId: req.authUserId, eventType: 'admin.n8n_update', details: { configured: result.configured } });
      res.json(result);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });
  router.get('/n8n/health', requireAuth, requireAdmin, async (req, res, next) => {
    try { res.json(await n8nHealth()); } catch (err) { next(err); }
  });

  router.get('/figma', requireAuth, requireAdmin, async (req, res, next) => {
    try { res.json(await getFigmaConfig()); } catch (err) { next(err); }
  });
  router.put('/figma', requireAuth, requireAdmin, async (req, res, next) => {
    try {
      const result = await saveFigmaConfig(req.body || {});
      await writeAuditEvent({ ownerUserId: req.authUserId, eventType: 'admin.figma_update', details: { configured: result.configured } });
      res.json(result);
    } catch (err) {
      if (err.status) return res.status(err.status).json({ error: err.message });
      next(err);
    }
  });

  return router;
}
