/**
 * External n8n integration (separate deployment).
 * Stores connection settings only; does not embed n8n.
 */
import { getPlatformSetting, setPlatformSetting } from '../db/platform-settings.js';
import { isPostgresConfigured } from '../storage/postgres.js';

const KEY = 'n8n_connection';

export async function getN8nConfig() {
  if (!isPostgresConfigured()) return { configured: false, baseUrl: null, hasApiKey: false };
  const value = await getPlatformSetting(KEY, {});
  return {
    configured: Boolean(value?.baseUrl),
    baseUrl: value?.baseUrl || null,
    hasApiKey: Boolean(value?.apiKey),
  };
}

export async function saveN8nConfig({ baseUrl, apiKey, clearApiKey = false }) {
  if (!isPostgresConfigured()) {
    const err = new Error('DATABASE_URL required');
    err.status = 503;
    throw err;
  }
  const current = await getPlatformSetting(KEY, {});
  const next = {
    baseUrl: baseUrl != null ? String(baseUrl).replace(/\/+$/, '').slice(0, 300) : current.baseUrl,
    apiKey: clearApiKey ? '' : (apiKey ? String(apiKey).slice(0, 200) : current.apiKey),
  };
  await setPlatformSetting(KEY, next);
  return { configured: Boolean(next.baseUrl), baseUrl: next.baseUrl || null, hasApiKey: Boolean(next.apiKey) };
}

export async function n8nHealth() {
  const cfg = await getN8nConfig();
  if (!cfg.configured) return { ok: false, reason: 'not-configured' };
  try {
    const res = await fetch(`${cfg.baseUrl}/healthz`, { signal: AbortSignal.timeout(5000) }).catch(() =>
      fetch(`${cfg.baseUrl}/`, { signal: AbortSignal.timeout(5000) })
    );
    return { ok: Boolean(res?.ok), status: res?.status || 0, baseUrl: cfg.baseUrl };
  } catch (err) {
    return { ok: false, reason: err.message, baseUrl: cfg.baseUrl };
  }
}
