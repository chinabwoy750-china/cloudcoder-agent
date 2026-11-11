import { oc } from '../agent/client.js';
import { isOpenCodeReady } from '../agent/opencode.js';
import { logger } from '../utils/logger.js';

const CACHE_TTL_MS = 2 * 60 * 1000;

/** @type {{ fetchedAt: number, models: Array<object>, error: string|null }} */
let cache = { fetchedAt: 0, models: [], error: null };

/**
 * Extract variant ids from OpenCode model metadata.
 * Sources (in order): variants map/array, capabilities.reasoning.effort,
 * reasoning_options effort values. Never hardcodes a fixed list.
 */
export function extractVariants(modelMeta) {
  if (!modelMeta || typeof modelMeta !== 'object') return [];
  const out = [];
  const seen = new Set();
  const push = (v) => {
    const id = String(v || '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };

  const variants = modelMeta.variants;
  if (variants && typeof variants === 'object' && !Array.isArray(variants)) {
    for (const key of Object.keys(variants)) {
      const entry = variants[key];
      if (entry && entry.disabled === true) continue;
      push(key);
    }
  } else if (Array.isArray(variants)) {
    for (const v of variants) {
      if (typeof v === 'string') push(v);
      else if (v && typeof v === 'object') {
        if (v.disabled === true) continue;
        push(v.id || v.name || v.variant);
      }
    }
  }

  const effort =
    modelMeta.capabilities?.reasoning?.effort ||
    modelMeta.capabilities?.reasoning?.efforts ||
    modelMeta.reasoning?.effort ||
    modelMeta.reasoningEffort ||
    null;
  if (Array.isArray(effort)) {
    for (const e of effort) push(e);
  }

  const opts = modelMeta.reasoning_options || modelMeta.reasoningOptions || [];
  if (Array.isArray(opts)) {
    for (const o of opts) {
      if (o && typeof o === 'object' && Array.isArray(o.values)) {
        for (const v of o.values) push(v);
      }
    }
  }

  return out;
}

function normalizeProviderList(data) {
  if (!data) return [];
  if (Array.isArray(data.providers)) return data.providers;
  if (Array.isArray(data.all)) return data.all;
  if (data.providers && typeof data.providers === 'object') {
    return Object.entries(data.providers).map(([id, p]) => ({ id, ...(p || {}) }));
  }
  return [];
}

/**
 * Fetch models currently visible to the running OpenCode server
 * (includes built-in free opencode/* models when available).
 */
export async function fetchOpenCodeModels({ force = false } = {}) {
  if (!force && cache.fetchedAt && Date.now() - cache.fetchedAt < CACHE_TTL_MS && cache.models.length) {
    return cache;
  }

  if (!isOpenCodeReady()) {
    cache = { fetchedAt: Date.now(), models: cache.models || [], error: 'OpenCode not ready' };
    return cache;
  }

  try {
    let data;
    try {
      data = await oc('GET', '/config/providers', { timeoutMs: 12000 });
    } catch {
      data = await oc('GET', '/provider', { timeoutMs: 12000 });
    }

    const providers = normalizeProviderList(data);
    const models = [];
    const seen = new Set();

    for (const p of providers) {
      const providerId = String(p.id || p.providerID || p.name || '').trim();
      if (!providerId) continue;
      const rawModels = p.models
        ? (Array.isArray(p.models) ? p.models : Object.entries(p.models).map(([id, meta]) => (
            typeof meta === 'object' && meta !== null ? { id, ...meta } : { id }
          )))
        : [];

      for (const m of rawModels) {
        const modelId = typeof m === 'string'
          ? m
          : String(m.id || m.modelID || m.name || '').trim();
        if (!modelId) continue;
        const openCodeRef = `${providerId}/${modelId}`;
        if (seen.has(openCodeRef)) continue;
        seen.add(openCodeRef);

        const name = typeof m === 'object'
          ? String(m.name || m.displayName || modelId)
          : modelId;
        const variants = typeof m === 'object' ? extractVariants(m) : [];
        const free = typeof m === 'object'
          ? Boolean(
              m.free === true ||
              m.cost?.input === 0 ||
              m.cost?.output === 0 ||
              /free/i.test(name) ||
              /free$/i.test(modelId)
            )
          : /free/i.test(modelId);

        models.push({
          id: modelId,
          name,
          providerId,
          openCodeRef,
          source: 'opencode',
          free,
          variants,
          reasoning: Boolean(
            (typeof m === 'object' && (m.reasoning === true || m.capabilities?.reasoning?.supported)) ||
            variants.length
          ),
        });
      }
    }

    cache = { fetchedAt: Date.now(), models, error: null };
    logger.info(`[opencode-models] Discovered ${models.length} model(s) from OpenCode providers`);
    return cache;
  } catch (err) {
    const msg = err?.message || 'failed to list OpenCode providers';
    logger.warn(`[opencode-models] ${msg}`);
    cache = { fetchedAt: Date.now(), models: cache.models || [], error: msg };
    return cache;
  }
}

export function getCachedOpenCodeModels() {
  return cache;
}

export function _resetOpenCodeModelsCacheForTests() {
  cache = { fetchedAt: 0, models: [], error: null };
}
