import { config } from './env.js';
import { logger } from '../utils/logger.js';
import { redact } from '../utils/redact.js';

const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * HTTP headers must be ByteString (code points <= 255).
 * Render env values sometimes contain smart punctuation (e.g. bullet • = 8226).
 */
function toHeaderValue(raw) {
  const s = String(raw ?? '');
  // Strip characters outside printable ASCII so fetch() does not throw.
  const cleaned = s.replace(/[^\x20-\x7E]/g, '').trim();
  return cleaned;
}


/** @type {{ fetchedAt: number, source: string, models: Array<{id:string,name:string,openCodeModelId:string,openCodeRef:string}>, error: string|null, providerId: string }} */
let cache = {
  fetchedAt: 0,
  source: 'none',
  models: [],
  error: null,
  providerId: 'custom',
};

/**
 * Sanitize an opaque upstream model id into an OpenCode-safe model key.
 * Spaces and control chars are not allowed in providerID/modelID splits.
 */
export function sanitizeModelKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return 'model';
  return s.replace(/\s+/g, '-').replace(/[^\w./:@+-]/g, '_') || 'model';
}

export function getProviderId() {
  return sanitizeModelKey(process.env.CUSTOM_AI_PROVIDER || config.customAI?.provider || 'custom');
}

/**
 * Build the OpenCode model ref "providerId/modelKey" for a discovered model.
 */
export function toOpenCodeRef(upstreamId) {
  const providerId = getProviderId();
  const key = sanitizeModelKey(upstreamId);
  return `${providerId}/${key}`;
}

function modelsUrl() {
  const base = (process.env.CUSTOM_AI_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  // CUSTOM_AI_BASE_URL is expected to include /v1 (e.g. https://host/v1)
  return `${base}/models`;
}

/**
 * Fetch models from the custom OpenAI-compatible endpoint.
 * Never logs or returns the API key.
 */
export async function fetchCustomModels({ force = false } = {}) {
  const baseURL = toHeaderValue(process.env.CUSTOM_AI_BASE_URL || '');
  const rawKey = process.env.CUSTOM_AI_API_KEY || '';
  const apiKey = toHeaderValue(rawKey);
  if (rawKey && apiKey !== rawKey.trim()) {
    logger.warn('[custom-models] CUSTOM_AI_API_KEY contained non-ASCII characters; stripped for HTTP headers');
  }
  const providerId = getProviderId();

  if (!baseURL) {
    cache = { fetchedAt: Date.now(), source: 'none', models: [], error: null, providerId };
    return cache;
  }

  if (!force && cache.fetchedAt && Date.now() - cache.fetchedAt < CACHE_TTL_MS && cache.models.length) {
    return cache;
  }

  const url = modelsUrl();
  if (!url) {
    cache = { fetchedAt: Date.now(), source: 'none', models: [], error: 'CUSTOM_AI_BASE_URL missing', providerId };
    return cache;
  }

  if (!apiKey) {
    logger.warn('[custom-models] CUSTOM_AI_API_KEY missing; cannot list models from endpoint');
    return applyFallback('CUSTOM_AI_API_KEY missing');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      const status = res.status;
      logger.warn(`[custom-models] GET /models failed with HTTP ${status}`);
      return applyFallback(`endpoint returned HTTP ${status}`);
    }

    const data = await res.json();
    const list = Array.isArray(data?.data) ? data.data
      : Array.isArray(data?.models) ? data.models
      : Array.isArray(data) ? data
      : [];

    const models = [];
    const seen = new Set();
    for (const item of list) {
      const id = typeof item === 'string' ? item : (item?.id || item?.model || item?.name);
      if (!id || typeof id !== 'string') continue;
      const key = sanitizeModelKey(id);
      if (seen.has(key)) continue;
      seen.add(key);
      const name = (typeof item === 'object' && (item.name || item.id)) || id;
      models.push({
        id, // opaque upstream id
        name: String(name),
        openCodeModelId: key,
        openCodeRef: `${providerId}/${key}`,
      });
    }

    if (!models.length) {
      logger.warn('[custom-models] Endpoint returned no models; using fallback');
      return applyFallback('endpoint returned empty model list');
    }

    cache = {
      fetchedAt: Date.now(),
      source: 'live',
      models,
      error: null,
      providerId,
    };
    logger.info(`[custom-models] Discovered ${models.length} model(s) from custom endpoint (provider=${providerId})`);
    return cache;
  } catch (err) {
    const msg = err.name === 'AbortError' ? 'request timed out' : (err.message || 'fetch failed');
    logger.warn(`[custom-models] Discovery failed: ${redact(msg)}`);
    return applyFallback(msg);
  } finally {
    clearTimeout(timer);
  }
}

function applyFallback(reason) {
  const providerId = getProviderId();
  const raw = (process.env.CUSTOM_AI_MODEL || config.customAI?.model || '').trim();
  const models = [];
  if (raw) {
    const key = sanitizeModelKey(raw);
    models.push({
      id: raw,
      name: process.env.CUSTOM_AI_MODEL_NAME || raw,
      openCodeModelId: key,
      openCodeRef: `${providerId}/${key}`,
    });
  }
  cache = {
    fetchedAt: Date.now(),
    source: 'fallback',
    models,
    error: reason,
    providerId,
  };
  if (models.length) {
    logger.info(`[custom-models] Fallback to CUSTOM_AI_MODEL (${models[0].openCodeRef}); reason: ${reason}`);
  } else {
    logger.warn(`[custom-models] No models available (${reason})`);
  }
  return cache;
}

export function getCachedModels() {
  return cache;
}

/**
 * Default model ref for agent tasks when user does not select one.
 */
export function resolveDefaultModelRef() {
  const providerId = getProviderId();
  const envDefault = (process.env.DEFAULT_MODEL || config.agent?.defaultModel || '').trim();
  if (envDefault) {
    if (envDefault.startsWith(`${providerId}/`)) {
      const rest = envDefault.slice(providerId.length + 1);
      return `${providerId}/${sanitizeModelKey(rest)}`;
    }
    // If DEFAULT_MODEL contains spaces under an unknown head, treat as custom model id
    if (envDefault.includes(' ') && process.env.CUSTOM_AI_BASE_URL) {
      return `${providerId}/${sanitizeModelKey(envDefault.includes('/') && !envDefault.startsWith(providerId + '/') ? envDefault.split('/').slice(1).join('/') || envDefault : envDefault)}`;
    }
    // e.g. DEFAULT_MODEL=custom/free way/gpt → already handled by startsWith
    // e.g. DEFAULT_MODEL=custom/free way/gpt-5.6-luna when provider is custom
    if (envDefault.includes(' ')) {
      const parts = envDefault.split('/');
      if (parts[0] === providerId || parts[0] === (process.env.CUSTOM_AI_PROVIDER || 'custom')) {
        return `${providerId}/${sanitizeModelKey(parts.slice(1).join('/'))}`;
      }
    }
    return envDefault;
  }

  const preferred = (process.env.CUSTOM_AI_MODEL || '').trim();
  if (preferred) return `${providerId}/${sanitizeModelKey(preferred)}`;

  if (cache.models.length) return cache.models[0].openCodeRef;
  return '';
}

/**
 * Validate a user-supplied model ref or bare upstream id against cache/fallback.
 * Returns openCodeRef or null.
 */
export function resolveUserModelSelection(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  const providerId = getProviderId();
  const knownBuiltin = new Set([
    'openai', 'anthropic', 'google', 'gemini', 'openrouter', 'groq',
    'cerebras', 'mistral', 'xai', 'cohere', 'bedrock', 'azure',
    'opencode', 'opencode-go', 'github-copilot', 'copilot',
  ]);

  // Strip optional #variant suffix for resolution; variant is handled separately.
  const baseRef = trimmed.includes('#') ? trimmed.split('#')[0] : trimmed;

  // Exact cache match on openCodeRef
  const exact = cache.models.find((m) => m.openCodeRef === baseRef || m.openCodeRef === trimmed);
  if (exact) return exact.openCodeRef;

  if (baseRef.includes('/')) {
    const [head, ...rest] = baseRef.split('/');
    const restJoined = rest.join('/');

    // provider/model under our custom provider
    if (head === providerId) {
      return `${providerId}/${sanitizeModelKey(restJoined)}`;
    }

    // Known built-in / OpenCode free provider — pass through as-is
    if (knownBuiltin.has(head.toLowerCase())) {
      return baseRef;
    }

    // Otherwise treat the whole string as an opaque upstream model id
    // (e.g. "free-way/gpt-5.6-luna" from the custom endpoint)
    if (process.env.CUSTOM_AI_BASE_URL) {
      const hit = cache.models.find(
        (m) => m.id === baseRef || m.openCodeModelId === sanitizeModelKey(baseRef)
      );
      if (hit) return hit.openCodeRef;
      return `${providerId}/${sanitizeModelKey(baseRef)}`;
    }
    return baseRef;
  }

  // Bare id
  const hit = cache.models.find(
    (m) => m.id === trimmed || m.openCodeModelId === sanitizeModelKey(trimmed)
  );
  if (hit) return hit.openCodeRef;

  if (process.env.CUSTOM_AI_BASE_URL) {
    return `${providerId}/${sanitizeModelKey(trimmed)}`;
  }
  return null;
}

/**
 * Map for OpenCode provider.models config object.
 * Keys are sanitized; optional id field preserves upstream wire name.
 */
export function modelsForOpenCodeConfig() {
  const out = {};
  for (const m of cache.models) {
    const entry = { name: m.name };
    if (m.openCodeModelId !== m.id) entry.id = m.id;
    out[m.openCodeModelId] = entry;
  }
  // Ensure configured default exists even if discovery missed it
  const preferred = (process.env.CUSTOM_AI_MODEL || '').trim();
  if (preferred) {
    const key = sanitizeModelKey(preferred);
    if (!out[key]) {
      out[key] = {
        name: process.env.CUSTOM_AI_MODEL_NAME || preferred,
        ...(key !== preferred ? { id: preferred } : {}),
      };
    }
  }
  return out;
}

/** Test helper */
export function _resetCacheForTests() {
  cache = { fetchedAt: 0, source: 'none', models: [], error: null, providerId: 'custom' };
}
