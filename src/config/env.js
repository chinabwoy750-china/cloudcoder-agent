import { logger } from '../utils/logger.js';

const REQUIRED = ['CLOUDCODER_USERNAME', 'CLOUDCODER_PASSWORD', 'OPENCODE_SERVER_PASSWORD', 'SESSION_SECRET'];

const STANDARD_AI_KEY_VARS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
];

const int = (v, d) => { const n = parseInt(v ?? '', 10); return Number.isFinite(n) ? n : d; };
const bool = (v) => String(v).toLowerCase() === 'true';

/**
 * A custom endpoint is considered configured when both a base URL and a
 * model are present. Without a model there is nothing to select.
 */
export function hasCustomAI() {
  return Boolean(process.env.CUSTOM_AI_BASE_URL && process.env.CUSTOM_AI_MODEL);
}

export function validateEnv() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(
      'FATAL: Missing required environment variables:\n' +
      missing.map((k) => `  - ${k}`).join('\n') +
      '\n\nSet them in Render Dashboard → Environment, or in a local .env file.'
    );
    process.exit(1);
  }

  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length < 32) {
    logger.warn('[CloudCoder] SESSION_SECRET is shorter than 32 chars — use a longer random value in production.');
  }

  const hasStandardKey = STANDARD_AI_KEY_VARS.some((k) => process.env[k]);
  const hasCustom = hasCustomAI();

  if (!hasStandardKey && !hasCustom) {
    logger.warn(
      `[CloudCoder] No AI provider configured. Set one of: ${STANDARD_AI_KEY_VARS.join(', ')}, ` +
      'or configure a custom endpoint with CUSTOM_AI_BASE_URL + CUSTOM_AI_MODEL + CUSTOM_AI_API_KEY.'
    );
  } else if (hasCustom) {
    if (!process.env.CUSTOM_AI_API_KEY) {
      logger.warn('[CloudCoder] CUSTOM_AI_BASE_URL is set but CUSTOM_AI_API_KEY is missing; the custom provider will fail at request time.');
    }
    if (!process.env.DEFAULT_MODEL) {
      const provider = process.env.CUSTOM_AI_PROVIDER || 'custom';
      logger.info(`[CloudCoder] Custom AI endpoint detected. Consider setting DEFAULT_MODEL=${provider}/${process.env.CUSTOM_AI_MODEL}`);
    }
  }
}

export function validateGitHubEnv() {
  if (!process.env.GITHUB_TOKEN) {
    logger.warn('[CloudCoder] GITHUB_TOKEN not set. GitHub endpoints will return 503.');
    return false;
  }
  return true;
}

export function validateTelegramEnv() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    logger.info('[CloudCoder] TELEGRAM_BOT_TOKEN not set. Telegram bot disabled.');
    return false;
  }
  if (!process.env.TELEGRAM_ALLOWED_USER_IDS) {
    logger.warn('[CloudCoder] TELEGRAM_ALLOWED_USER_IDS is empty — every Telegram user would be rejected. Set at least one numeric user ID.');
  }
  return true;
}

export const config = {
  port: int(process.env.PORT, 10000),
  host: '0.0.0.0',
  logLevel: process.env.LOG_LEVEL || 'info',
  production: process.env.NODE_ENV === 'production',
  opencode: {
    port: int(process.env.OPENCODE_PORT, 4096),
    hostname: '127.0.0.1',
    username: process.env.OPENCODE_SERVER_USERNAME || 'opencode',
    password: process.env.OPENCODE_SERVER_PASSWORD,
  },
  auth: {
    username: process.env.CLOUDCODER_USERNAME,
    password: process.env.CLOUDCODER_PASSWORD,
  },
  session: {
    secret: process.env.SESSION_SECRET || '',
    cookieName: 'cc_session',
    ttlMs: 1000 * 60 * 60 * 24 * 7,
  },
  agent: {
    defaultModel: process.env.DEFAULT_MODEL || '',
    taskTimeoutMs: int(process.env.TASK_TIMEOUT_MS, 900000),
    pollIntervalMs: int(process.env.AGENT_POLL_MS, 750),
  },
  github: {
    token: process.env.GITHUB_TOKEN || null,
    userAgent: process.env.GITHUB_USER_AGENT || 'universal-modder/1.0.0',
    apiVersion: process.env.GITHUB_API_VERSION || '2022-11-28',
    allowDefaultBranchPush: bool(process.env.GITHUB_ALLOW_DEFAULT_BRANCH),
    commitName: process.env.GIT_COMMIT_NAME || 'Universal Modder',
    commitEmail: process.env.GIT_COMMIT_EMAIL || 'agent@cloudcoder.local',
    cloneDepth: int(process.env.GIT_CLONE_DEPTH, 1),
  },
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || null,
    allowedUserIds: (process.env.TELEGRAM_ALLOWED_USER_IDS || '')
      .split(',').map((s) => s.trim()).filter(Boolean),
    pollTimeoutSec: int(process.env.TELEGRAM_POLL_TIMEOUT, 30),
    typingRefreshMs: 4500,
  },
  limits: {
    workspaceRoot: process.env.WORKSPACE_ROOT || '/tmp/cloudcoder',
    maxUploadBytes: int(process.env.MAX_UPLOAD_BYTES, 50 * 1024 * 1024),
    maxExtractBytes: int(process.env.MAX_EXTRACT_BYTES, 200 * 1024 * 1024),
    maxZipEntries: int(process.env.MAX_ZIP_ENTRIES, 5000),
    commandTimeoutMs: int(process.env.COMMAND_TIMEOUT_MS, 180000),
    maxCommandOutputBytes: int(process.env.MAX_COMMAND_OUTPUT, 256 * 1024),
    maxDownloadBytes: int(process.env.MAX_DOWNLOAD_BYTES, 64 * 1024 * 1024),
  },
  customAI: {
    baseURL: process.env.CUSTOM_AI_BASE_URL || null,
    apiKey: process.env.CUSTOM_AI_API_KEY || null,
    provider: process.env.CUSTOM_AI_PROVIDER || 'custom',
    model: process.env.CUSTOM_AI_MODEL || null,
    modelName: process.env.CUSTOM_AI_MODEL_NAME || null,
    providerName: process.env.CUSTOM_AI_PROVIDER_NAME || null,
  },
};
