import { Router } from 'express';
import { config } from '../../config/env.js';
import { fetchCustomModels, getCachedModels, resolveDefaultModelRef, sanitizeModelKey, getProviderId } from '../../config/custom-models.js';
import { getRuntimeSettings, getSettingsPersistence, saveRuntimeSettings } from '../../config/runtime-settings.js';
import { restartOpenCode, isOpenCodeReady } from '../../agent/opencode.js';
import { logger } from '../../utils/logger.js';
import crypto from 'node:crypto';
import { setRuntimeCredentials, clearRuntimePasswordOverride } from '../../auth/basic.js';

export function settingsRouter() {
  const router = Router();

  router.get('/', async (_req, res) => {
    const cache = getCachedModels();
    const rt = getRuntimeSettings();
    res.json({
      provider: {
        baseURL: process.env.CUSTOM_AI_BASE_URL || rt.baseURL || '',
        providerId: getProviderId(),
        providerName: process.env.CUSTOM_AI_PROVIDER_NAME || rt.providerName || 'China-GPT',
        model: process.env.CUSTOM_AI_MODEL || rt.model || '',
        modelName: process.env.CUSTOM_AI_MODEL_NAME || rt.modelName || '',
        defaultModel: resolveDefaultModelRef() || '',
        hasApiKey: Boolean(process.env.CUSTOM_AI_API_KEY || rt.apiKey),
        models: (cache.models || []).map((m) => ({ id: m.id, name: m.name, openCodeRef: m.openCodeRef })),
        discovery: cache.source || 'none',
        error: cache.error || null,
        source: 'admin-dashboard',
      },
      account: {
        username: config.auth.username || '',
        passwordOverride: Boolean(rt.passwordHash || rt.password),
      },
      integrations: {
        hasGithubToken: Boolean(config.github.token || rt.githubToken),
        hasTelegramToken: Boolean(config.telegram?.token || rt.telegramToken),
        telegramAllowedUserIds: process.env.TELEGRAM_ALLOWED_USER_IDS || rt.telegramAllowedUserIds || '',
      },
      openCodeReady: isOpenCodeReady(),
      persistence: getSettingsPersistence(),
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

  router.post('/integrations', async (req, res) => {
    const body = req.body || {};
    const update = {};
    const githubToken = typeof body.githubToken === 'string' ? body.githubToken.trim() : '';
    if (githubToken) update.githubToken = githubToken;
    if (body.clearGithubToken === true) update.githubToken = '';

    const telegramToken = typeof body.telegramToken === 'string' ? body.telegramToken.trim() : '';
    if (telegramToken) update.telegramToken = telegramToken;
    if (body.clearTelegramToken === true) update.telegramToken = '';

    if (body.telegramAllowedUserIds !== undefined) {
      update.telegramAllowedUserIds = String(body.telegramAllowedUserIds || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .join(',');
    }

    if (Object.keys(update).length) {
      await saveRuntimeSettings(update);
      try {
        const { resetOctokit } = await import('../../github/client.js');
        resetOctokit();
      } catch {}
    }
    res.json({
      ok: true,
      message: 'Integrations saved in the admin dashboard (encrypted at rest when persistence is available).',
      hasGithubToken: Boolean(process.env.GITHUB_TOKEN),
      hasTelegramToken: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      telegramAllowedUserIds: process.env.TELEGRAM_ALLOWED_USER_IDS || '',
      persistence: getSettingsPersistence(),
    });
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
