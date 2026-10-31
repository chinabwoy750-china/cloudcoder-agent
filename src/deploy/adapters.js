/**
 * Deployment target adapters.
 * Users configure targets and credentials server-side; browser never receives secrets.
 * Deployments are never automatic — require explicit authorization.
 */
import { getPlatformSetting, setPlatformSetting } from '../db/platform-settings.js';
import { isPostgresConfigured } from '../storage/postgres.js';
import { logger } from '../utils/logger.js';

const KEY = 'deploy_targets';

const PROVIDERS = {
  render: {
    id: 'render',
    name: 'Render',
    fields: ['apiKey', 'serviceId'],
    docs: 'https://render.com/docs/api',
  },
  netlify: {
    id: 'netlify',
    name: 'Netlify',
    fields: ['token', 'siteId'],
    docs: 'https://docs.netlify.com/api/get-started/',
  },
  vercel: {
    id: 'vercel',
    name: 'Vercel',
    fields: ['token', 'projectId', 'teamId'],
    docs: 'https://vercel.com/docs/rest-api',
  },
};

export function listDeployProviders() {
  return Object.values(PROVIDERS).map(({ id, name, fields, docs }) => ({ id, name, fields, docs }));
}

export async function listDeployTargets() {
  if (!isPostgresConfigured()) return { targets: [], note: 'DATABASE_URL required to persist targets' };
  const value = await getPlatformSetting(KEY, { targets: [] });
  const targets = Array.isArray(value?.targets) ? value.targets : [];
  // Never return raw secrets to clients
  return {
    targets: targets.map((t) => ({
      id: t.id,
      name: t.name,
      provider: t.provider,
      hasCredentials: Boolean(t.credentials && Object.keys(t.credentials).length),
      lastDeployAt: t.lastDeployAt || null,
      lastStatus: t.lastStatus || null,
      lastUrl: t.lastUrl || null,
    })),
  };
}

export async function saveDeployTarget(input = {}) {
  if (!isPostgresConfigured()) {
    const err = new Error('DATABASE_URL required');
    err.status = 503;
    throw err;
  }
  const provider = PROVIDERS[input.provider];
  if (!provider) {
    const err = new Error('Unknown deploy provider');
    err.status = 400;
    throw err;
  }
  const value = await getPlatformSetting(KEY, { targets: [] });
  const targets = Array.isArray(value?.targets) ? value.targets : [];
  const id = String(input.id || `tgt_${Date.now().toString(36)}`).slice(0, 40);
  const credentials = {};
  for (const field of provider.fields) {
    if (input.credentials?.[field]) credentials[field] = String(input.credentials[field]).slice(0, 300);
  }
  const existing = targets.find((t) => t.id === id);
  const next = {
    id,
    name: String(input.name || provider.name).slice(0, 80),
    provider: provider.id,
    credentials: Object.keys(credentials).length ? credentials : (existing?.credentials || {}),
    lastDeployAt: existing?.lastDeployAt || null,
    lastStatus: existing?.lastStatus || null,
    lastUrl: existing?.lastUrl || null,
  };
  const out = targets.filter((t) => t.id !== id).concat([next]).slice(0, 20);
  await setPlatformSetting(KEY, { targets: out });
  return { id: next.id, name: next.name, provider: next.provider, hasCredentials: Boolean(Object.keys(next.credentials || {}).length) };
}

export async function deleteDeployTarget(id) {
  if (!isPostgresConfigured()) {
    const err = new Error('DATABASE_URL required');
    err.status = 503;
    throw err;
  }
  const value = await getPlatformSetting(KEY, { targets: [] });
  const targets = (Array.isArray(value?.targets) ? value.targets : []).filter((t) => t.id !== id);
  await setPlatformSetting(KEY, { targets });
  return { ok: true };
}

async function getRawTarget(id) {
  const value = await getPlatformSetting(KEY, { targets: [] });
  return (Array.isArray(value?.targets) ? value.targets : []).find((t) => t.id === id) || null;
}

/**
 * Trigger deploy only when authorizeDeploy === true on the request path.
 */
export async function triggerDeploy(targetId, { authorizeDeploy = false, clear = false } = {}) {
  if (!authorizeDeploy) {
    const err = new Error('Deployment requires explicit authorization (authorizeDeploy=true)');
    err.status = 403;
    err.code = 'DEPLOY_NOT_AUTHORIZED';
    throw err;
  }
  const target = await getRawTarget(targetId);
  if (!target) {
    const err = new Error('Deploy target not found');
    err.status = 404;
    throw err;
  }
  if (!target.credentials || !Object.keys(target.credentials).length) {
    const err = new Error('Deploy target has no credentials');
    err.status = 400;
    throw err;
  }

  let result;
  try {
    if (target.provider === 'render') result = await deployRender(target);
    else if (target.provider === 'netlify') result = await deployNetlify(target);
    else if (target.provider === 'vercel') result = await deployVercel(target);
    else {
      const err = new Error('Provider not implemented');
      err.status = 501;
      throw err;
    }
  } catch (err) {
    await updateTargetStatus(target.id, { lastStatus: 'failed', lastDeployAt: new Date().toISOString(), lastUrl: null, lastError: err.message });
    throw err;
  }
  await updateTargetStatus(target.id, {
    lastStatus: result.status || 'triggered',
    lastDeployAt: new Date().toISOString(),
    lastUrl: result.url || null,
    lastError: null,
  });
  logger.info(`[deploy] target=${target.id} provider=${target.provider} status=${result.status}`);
  return { ok: true, provider: target.provider, ...result };
}

async function updateTargetStatus(id, patch) {
  const value = await getPlatformSetting(KEY, { targets: [] });
  const targets = Array.isArray(value?.targets) ? value.targets : [];
  const next = targets.map((t) => (t.id === id ? { ...t, ...patch } : t));
  await setPlatformSetting(KEY, { targets: next });
}

async function deployRender(target) {
  const { apiKey, serviceId } = target.credentials;
  const res = await fetch(`https://api.render.com/v1/services/${encodeURIComponent(serviceId)}/deploys`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ clearCache: 'do_not_clear' }),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  if (!res.ok) {
    const err = new Error(`Render deploy failed (${res.status})`);
    err.status = res.status;
    err.details = text.slice(0, 1000);
    throw err;
  }
  const deploy = json?.deploy || json;
  return {
    status: deploy?.status || 'created',
    deployId: deploy?.id || null,
    url: null,
    logs: 'Triggered via Render API; check Render dashboard for build logs.',
  };
}

async function deployNetlify(target) {
  // Netlify site build hook / deploy requires site-specific setup; report not fully wired without build hook URL.
  const err = new Error('Netlify deploy requires a build hook URL in credentials.buildHookUrl (not set). Configure a build hook in Netlify UI.');
  err.status = 501;
  err.code = 'NETLIFY_BUILD_HOOK_REQUIRED';
  throw err;
}

async function deployVercel(target) {
  const err = new Error('Vercel deploy adapter is registered but requires project deployment hooks; use Vercel dashboard or supply deployment API details in a later patch.');
  err.status = 501;
  err.code = 'VERCEL_ADAPTER_GROUNDWORK';
  throw err;
}
