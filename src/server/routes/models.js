import { Router } from 'express';
import {
  fetchCustomModels,
  getCachedModels,
  resolveDefaultModelRef,
  getProviderId,
} from '../../config/custom-models.js';
import { fetchOpenCodeModels } from '../../config/opencode-models.js';
import { isOpenCodeReady } from '../../agent/opencode.js';

/**
 * Safe model list for UI / Telegram.
 * Merges China-GPT (custom endpoint) models with OpenCode's own providers
 * (including free opencode/* models). Variants come from OpenCode metadata.
 */
export function modelsRouter() {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const force = req.query.refresh === '1' || req.query.refresh === 'true';
      await fetchCustomModels({ force });
      const cache = getCachedModels();
      const oc = await fetchOpenCodeModels({ force });

      const customModels = (cache.models || []).map((m) => ({
        id: m.id,
        name: m.name,
        openCodeRef: m.openCodeRef,
        providerId: cache.providerId || getProviderId(),
        source: 'custom',
        free: false,
        variants: Array.isArray(m.variants) ? m.variants : [],
        reasoning: Boolean(m.reasoning),
      }));

      // Prefer OpenCode catalog entries; skip duplicates of custom openCodeRef.
      const seen = new Set(customModels.map((m) => m.openCodeRef));
      const opencodeModels = [];
      for (const m of oc.models || []) {
        if (seen.has(m.openCodeRef)) continue;
        seen.add(m.openCodeRef);
        opencodeModels.push({
          id: m.id,
          name: m.name,
          openCodeRef: m.openCodeRef,
          providerId: m.providerId,
          source: m.source || 'opencode',
          free: Boolean(m.free),
          variants: Array.isArray(m.variants) ? m.variants : [],
          reasoning: Boolean(m.reasoning),
        });
      }

      // Free OpenCode models first among OpenCode group, then rest.
      opencodeModels.sort((a, b) => {
        if (a.free !== b.free) return a.free ? -1 : 1;
        return String(a.name).localeCompare(String(b.name));
      });

      const models = [...customModels, ...opencodeModels];

      res.json({
        providerId: cache.providerId || getProviderId(),
        source: cache.source,
        error: cache.error || oc.error || null,
        defaultModel: resolveDefaultModelRef() || null,
        openCodeReady: isOpenCodeReady(),
        models,
        groups: {
          custom: customModels.length,
          opencode: opencodeModels.length,
          free: opencodeModels.filter((m) => m.free).length,
        },
      });
    } catch (e) {
      next(e);
    }
  });

  return router;
}
