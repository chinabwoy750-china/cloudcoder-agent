import { Router } from 'express';
import {
  fetchCustomModels,
  getCachedModels,
  resolveDefaultModelRef,
  getProviderId,
} from '../../config/custom-models.js';
import { isOpenCodeReady } from '../../agent/opencode.js';

/**
 * Safe model list for UI / Telegram.
 * Never includes API keys or endpoint credentials.
 */
export function modelsRouter() {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const force = req.query.refresh === '1' || req.query.refresh === 'true';
      await fetchCustomModels({ force });
      const cache = getCachedModels();
      res.json({
        providerId: cache.providerId || getProviderId(),
        source: cache.source,
        error: cache.error,
        defaultModel: resolveDefaultModelRef() || null,
        openCodeReady: isOpenCodeReady(),
        models: (cache.models || []).map((m) => ({
          id: m.id,
          name: m.name,
          openCodeRef: m.openCodeRef,
        })),
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
