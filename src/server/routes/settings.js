import { Router } from 'express';
import { config } from '../../config/env.js';
import { fetchCustomModels, getCachedModels, resolveDefaultModelRef, sanitizeModelKey, getProviderId } from '../../config/custom-models.js';
import { getRuntimeSettings, saveRuntimeSettings } from '../../config/runtime-settings.js';
import { restartOpenCode, isOpenCodeReady } from '../../agent/opencode.js';
import { logger } from '../../utils/logger.js';
import crypto from 'node:crypto';
import { setRuntimeCredentials, clearRuntimePasswordOverride } from '../../auth/basic.js';

export function settingsRouter() {
  const router = Router();

  router.get('/', async (_req, res) => {
    const cache = getCachedModels();
    res.json({
      provider: {
        baseURL: process.env.CUSTOM_AI_BASE_URL || '',
        providerId: getProviderId(),
        providerName: process.env.CUSTOM_AI_PROVIDER_NAME || 'China-GPT',
        model: process.env.CUSTOM_AI_MODEL || '',
        modelName: process.env.CUSTOM_AI_MODEL_NAME || '',
        defaultModel: resolveDefaultModelRef() || '',
        hasApiKey: Boolean(process.env.CUSTOM_AI_API_KEY),
        models: (cache.models || []).map((m) => ({ id: m.id, name: m.name, openCodeRef: m.openCodeRef })),
        discovery: cache.source || 'none',
        error: cache.error || null,
      },
      account: { username: config.auth.username || '', passwordOverride: Boolean(getRuntimeSettings().passwordHash || getRuntimeSettings().password) },
      integrations: { hasGithubToken: Boolean(config.github.token) },
      openCodeReady: isOpenCodeReady(),
      modelRouting: getRuntimeSettings().modelRouting || {},
      persistence: 'runtime-file',
    });
  });

  router.get('/diagnostics', async (_req, res) => {
    const cache = getCachedModels();
    const settings = getRuntimeSettings();
    const diskPath = process.env.RUNTIME_SETTINGS_PATH || (process.env.RENDER === 'true' ? '/var/data' : '/tmp');
    let storage = { writable: false, persistentDiskLikely: diskPath.startsWith('/var/data') };
    try { const fs = await import('node:fs/promises'); await fs.access(diskPath); storage.writable = true; } catch {}
    res.json({
      generatedAt: new Date().toISOString(),
      services: { openCodeReady: isOpenCodeReady(), providerBaseConfigured: Boolean(process.env.CUSTOM_AI_BASE_URL), apiKeyConfigured: Boolean(process.env.CUSTOM_AI_API_KEY), modelCount: (cache.models || []).length, modelDiscovery: cache.source || 'none', modelDiscoveryError: cache.error || null },
      integrations: { githubConfigured: Boolean(config.github.token), telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN) },
      settings: { modelRoutingConfigured: Object.keys(settings.modelRouting || {}).filter((key) => Boolean(settings.modelRouting[key])), runtimeSettingsPathConfigured: Boolean(process.env.RUNTIME_SETTINGS_PATH) },
      storage,
      warnings: [
        ...(!storage.persistentDiskLikely ? ['Runtime settings/workspaces may be lost on redeploy unless a persistent disk is mounted.'] : []),
        ...(!isOpenCodeReady() ? ['OpenCode is not ready; coding tasks may fail until it recovers.'] : []),
        ...(!process.env.CUSTOM_AI_API_KEY ? ['Provider API key is not configured in the process environment.'] : []),
      ],
    });
  });

  router.post('/provider', async (req, res, next) => {
    try {
      const body = req.body || {};
      let baseURL = String(body.baseURL || '').trim().replace(/\/+$/, '');
      const provider = String(body.providerId || 'china-gpt').trim();
      const providerName = String(body.providerName || 'China-GPT').trim().slice(0, 80);
      const model = String(body.model || '').trim();
      const modelName = String(body.modelName || model).trim().slice(0, 120);
      if (!baseURL) return res.status(400).json({ error: 'Base URL is required' });
      let parsed;
      try { parsed = new URL(baseURL); } catch { return res.status(400).json({ error: 'Enter a valid provider URL' }); }
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname))) {
        return res.status(400).json({ error: 'Provider URL must use HTTPS' });
      }
      if (!/\/v1$/i.test(parsed.pathname)) { baseURL += '/v1'; parsed = new URL(baseURL); }
      if (!/^[a-zA-Z0-9._-]{1,64}$/.test(provider)) return res.status(400).json({ error: 'Provider ID may contain letters, numbers, dots, underscores and hyphens only' });
      if (!model) return res.status(400).json({ error: 'Choose or enter a model ID' });
      const key = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      if (!key && !process.env.CUSTOM_AI_API_KEY && !getRuntimeSettings().apiKey && body.clearApiKey !== true) {
        return res.status(400).json({ error: 'API key is required for this provider. Paste it in the API key field.' });
      }
      const saved = {
        baseURL,
        provider,
        providerName,
        model,
        modelName,
        defaultModel: `${provider}/${sanitizeModelKey(model)}`,
      };
      if (key) saved.apiKey = key;
      if (body.clearApiKey === true) saved.apiKey = '';
      await saveRuntimeSettings(saved);
      const cache = await fetchCustomModels({ force: true });
      logger.info(`[settings] Site provider saved (provider=${provider}, models=${cache.models.length}, keyConfigured=${Boolean(process.env.CUSTOM_AI_API_KEY)})`);
      await restartOpenCode(90000);
      res.json({ ok: true, message: 'Provider saved and OpenCode restarted.', provider: { providerId: provider, model, defaultModel: resolveDefaultModelRef(), hasApiKey: Boolean(process.env.CUSTOM_AI_API_KEY), modelCount: cache.models.length, discovery: cache.source, error: cache.error }, openCodeReady: isOpenCodeReady() });
    } catch (err) {
      next(err);
    }
  });

  router.post('/model-routing', async (req, res) => {
    const body = req.body || {};
    const keys = ['build', 'plan', 'image', 'video', 'audio'];
    const modelRouting = {};
    for (const key of keys) {
      const value = typeof body[key] === 'string' ? body[key].trim() : '';
      if (value.length > 200) return res.status(400).json({ error: `${key} model ID must be 200 characters or fewer` });
      modelRouting[key] = value;
    }
    await saveRuntimeSettings({ modelRouting });
    res.json({ ok: true, message: 'Model routing saved.', modelRouting });
  });

  router.post('/integrations', async (req, res) => {
    const token = typeof req.body?.githubToken === 'string' ? req.body.githubToken.trim() : '';
    const clear = req.body?.clearGithubToken === true;
    const update = {};
    if (token) update.githubToken = token;
    if (clear) update.githubToken = '';
    if (Object.keys(update).length) {
      await saveRuntimeSettings(update);
      const { resetOctokit } = await import('../../github/client.js');
      resetOctokit();
    }
    res.json({ ok: true, message: 'Integration settings saved.', hasGithubToken: Boolean(config.github.token) });
  });

  router.post('/account', async (req, res) => {
    const username = String(req.body?.username || '').trim();
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const useEnvPassword = req.body?.useEnvPassword === true;
    if (!username || username.length > 80) return res.status(400).json({ error: 'Username is required (maximum 80 characters)' });
    if (password && password.length < 12) return res.status(400).json({ error: 'New password must be at least 12 characters' });
    const update = { username };
    config.auth.username = username;
    if (useEnvPassword) {
      update.passwordSalt = null; update.passwordHash = null;
      config.auth.password = process.env.CLOUDCODER_PASSWORD;
    } else if (password) {
      const passwordSalt = crypto.randomBytes(16).toString('hex');
      const passwordHash = crypto.scryptSync(password, passwordSalt, 64).toString('hex');
      update.passwordSalt = passwordSalt; update.passwordHash = passwordHash;
      setRuntimeCredentials({ username, passwordSalt, passwordHash });
    }
    await saveRuntimeSettings(update);
    if (useEnvPassword) clearRuntimePasswordOverride();
    res.json({ ok: true, message: 'Account settings updated. Sign in again with the new credentials.', username, passwordChanged: Boolean(password) || useEnvPassword });
  });

  return router;
}
