import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './env.js';
import { logger } from '../utils/logger.js';
import { setRuntimeCredentials } from '../auth/basic.js';
import { isUpstashConfigured, redisGetJson, redisSetJson } from '../storage/upstash.js';

const SETTINGS_FILE = process.env.RUNTIME_SETTINGS_PATH || (fsSync.existsSync('/var/data') ? '/var/data/universal-modder-settings.json' : '/tmp/universal-modder-settings.json');
let saved = {};

export function getRuntimeSettings() { return { ...saved }; }
export function getSettingsPersistence() { return isUpstashConfigured() ? 'upstash-redis' : 'runtime-file'; }

function encryptionKey() {
  return crypto.scryptSync(String(config.session.secret || ''), 'universal-modder-site-settings-v1', 32);
}
function encryptSecret(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return { __encrypted: 'aes-256-gcm-v1', iv: iv.toString('base64'), data: data.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
function decryptSecret(value) {
  if (!value || value.__encrypted !== 'aes-256-gcm-v1') return value;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8');
  } catch (err) {
    logger.warn('[settings] Could not decrypt a saved secret; check whether SESSION_SECRET changed.');
    return null;
  }
}
function serializableSettings(values) {
  const output = { ...values };
  for (const key of ['apiKey', 'githubToken', 'telegramToken']) {
    if (typeof output[key] === 'string' && output[key]) output[key] = encryptSecret(output[key]);
  }
  return output;
}
function hydrateSettings(values) {
  const output = { ...values };
  for (const key of ['apiKey', 'githubToken', 'telegramToken']) output[key] = decryptSecret(output[key]);
  return output;
}

function applyEnv(values = {}) {
  const map = {
    baseURL: 'CUSTOM_AI_BASE_URL',
    apiKey: 'CUSTOM_AI_API_KEY',
    provider: 'CUSTOM_AI_PROVIDER',
    model: 'CUSTOM_AI_MODEL',
    modelName: 'CUSTOM_AI_MODEL_NAME',
    providerName: 'CUSTOM_AI_PROVIDER_NAME',
    defaultModel: 'DEFAULT_MODEL',
    githubToken: 'GITHUB_TOKEN',
    telegramToken: 'TELEGRAM_BOT_TOKEN',
    telegramAllowedUserIds: 'TELEGRAM_ALLOWED_USER_IDS',
  };
  for (const [key, envName] of Object.entries(map)) {
    if (values[key] !== undefined && values[key] !== null) process.env[envName] = String(values[key]);
  }
  if (values.username) config.auth.username = values.username;
  if (values.password) config.auth.password = values.password;
  if (values.username || values.passwordHash) {
    setRuntimeCredentials({
      username: values.username,
      passwordSalt: values.passwordSalt,
      passwordHash: values.passwordHash,
    });
  }
  config.customAI.baseURL = process.env.CUSTOM_AI_BASE_URL || null;
  config.customAI.apiKey = process.env.CUSTOM_AI_API_KEY || null;
  config.customAI.provider = process.env.CUSTOM_AI_PROVIDER || 'china-gpt';
  config.customAI.model = process.env.CUSTOM_AI_MODEL || null;
  config.customAI.modelName = process.env.CUSTOM_AI_MODEL_NAME || null;
  config.customAI.providerName = process.env.CUSTOM_AI_PROVIDER_NAME || null;
  config.agent.defaultModel = process.env.DEFAULT_MODEL || '';
  config.github.token = process.env.GITHUB_TOKEN || null;
  config.telegram.token = process.env.TELEGRAM_BOT_TOKEN || null;
  const ids = String(process.env.TELEGRAM_ALLOWED_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  config.telegram.allowedUserIds = ids;
}

export async function loadRuntimeSettings() {
  let stored = null;
  if (isUpstashConfigured()) {
    try {
      stored = await redisGetJson('runtime-settings');
      if (stored) {
        logger.info('[settings] Loaded site-managed runtime settings from Upstash Redis');
      } else {
        // One-time migration: if the current instance still has its previous
        // runtime file, move it into Redis before accepting new settings.
        try {
          stored = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'));
          await redisSetJson('runtime-settings', stored);
          logger.info('[settings] Migrated existing runtime settings file to Upstash Redis');
        } catch (migrationErr) {
          if (migrationErr.code !== 'ENOENT') throw migrationErr;
          logger.info('[settings] No site-managed settings found in Upstash Redis or local file yet');
        }
      }
    } catch (err) {
      logger.error(`[settings] Upstash Redis read failed: ${err.message}`);
      // Do not silently load an older file when Redis is configured: that could
      // overwrite newer settings on the next save and mislead the operator.
      throw new Error('Upstash Redis is configured but unavailable; refusing to start with potentially stale settings.');
    }
  } else {
    try {
      stored = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'));
      logger.info('[settings] Loaded site-managed runtime settings from local file');
    } catch (err) {
      if (err.code !== 'ENOENT') logger.warn(`[settings] Could not load runtime settings: ${err.message}`);
    }
  }
  if (stored) {
    saved = hydrateSettings(stored);
    applyEnv(saved);
  }
}

export async function saveRuntimeSettings(values) {
  const next = { ...saved, ...values };
  const serialized = serializableSettings(next);
  if (isUpstashConfigured()) {
    // Redis is authoritative when configured. Fail the save rather than report
    // success while settings are only held in ephemeral process memory.
    await redisSetJson('runtime-settings', serialized);
  } else {
    await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
    await fs.writeFile(SETTINGS_FILE, JSON.stringify(serialized, null, 2), { mode: 0o600 });
    await fs.chmod(SETTINGS_FILE, 0o600).catch(() => {});
  }
  saved = next;
  applyEnv(saved);
  return { ...saved };
}
