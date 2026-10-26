import { config } from './env.js';
import { logger } from '../utils/logger.js';
import {
  getProviderId,
  modelsForOpenCodeConfig,
  getCachedModels,
  resolveDefaultModelRef,
  sanitizeModelKey,
} from './custom-models.js';

/**
 * Build the OpenCode config object from CloudCoder environment variables
 * and any discovered custom models (from /v1/models cache).
 *
 * The API key is NEVER written into this object — the provider declares
 * `env: ["CUSTOM_AI_API_KEY"]` so OpenCode reads it from the process env.
 */
export function buildOpenCodeConfig() {
  const cfg = { $schema: 'https://opencode.ai/config.json' };

  const baseURL = (process.env.CUSTOM_AI_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!baseURL) {
    logger.info('[opencode-config] No CUSTOM_AI_BASE_URL set; using OpenCode default providers.');
    return cfg;
  }

  const providerId = getProviderId();
  const models = modelsForOpenCodeConfig();
  const modelCount = Object.keys(models).length;

  if (!/\/v1$/i.test(baseURL)) {
    logger.warn('[opencode-config] CUSTOM_AI_BASE_URL does not end with /v1; openai-compatible clients usually need /v1.');
  }

  if (!modelCount) {
    logger.warn('[opencode-config] Custom provider has no models yet (discovery empty and CUSTOM_AI_MODEL unset).');
  }

  cfg.provider = {
    [providerId]: {
      npm: '@ai-sdk/openai-compatible',
      name: process.env.CUSTOM_AI_PROVIDER_NAME || `Custom (${providerId})`,
      options: { baseURL },
      env: ['CUSTOM_AI_API_KEY'],
      ...(modelCount ? { models } : {}),
    },
  };

  const defaultRef = resolveDefaultModelRef();
  if (defaultRef && defaultRef.startsWith(`${providerId}/`)) {
    cfg.model = defaultRef;
  }

  const cache = getCachedModels();
  logger.info(
    `[opencode-config] Custom provider "${providerId}" registered ` +
    `(baseURL host set, models=${modelCount}, source=${cache.source}, ` +
    `hasApiKey=${Boolean(process.env.CUSTOM_AI_API_KEY)}, defaultModel=${cfg.model || 'unset'})`
  );
  return cfg;
}

export function serialiseOpenCodeConfig() {
  return JSON.stringify(buildOpenCodeConfig());
}

export { sanitizeModelKey };
