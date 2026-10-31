import { Router } from 'express';
import { rateLimitMiddleware } from '../../utils/ratelimit.js';
import { listMediaCapabilities, safeGenerate } from '../../media/adapters.js';

export function mediaRouter() {
  const router = Router();

  router.get('/capabilities', (req, res) => {
    res.json(listMediaCapabilities());
  });

  router.post(
    '/generate/:kind',
    rateLimitMiddleware({ windowMs: 60_000, max: 10 }),
    async (req, res) => {
      const kind = String(req.params.kind || '').toLowerCase();
      if (!['image', 'video', 'audio'].includes(kind)) {
        return res.status(400).json({ error: 'kind must be image, video, or audio' });
      }
      const payload = { ...(req.body || {}), workspaceId: req.body?.workspaceId || null };
      const out = await safeGenerate(kind, payload);
      if (!out.ok) return res.status(out.status || 502).json(out);
      res.json(out);
    }
  );

  return router;
}
