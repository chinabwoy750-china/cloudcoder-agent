import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './env.js';
import { logger } from '../utils/logger.js';
import { setRuntimeCredentials } from '../auth/basic.js';

const SETTINGS_FILE = process.env.RUNTIME_SETTINGS_PATH || (fsSync.existsSync('/var/data') ? '/var/data/universal-modder-settings.json' : '/tmp/universal-modder-settings.json');
let saved = {};

export function getRuntimeSettings() { return { ...saved }; }

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
  for (const key of ['apiKey', 'githubToken']) {
    if (typeof output[key] === 'string') output[key] = encryptSecret(output[key]);
  }
  return output;
}
function hydrateSettings(values) {
  const output = { ...values };
  for (const key of ['apiKey', 'githubToken']) output[key] = decryptSecret(output[key]);
  return output;
}

function applyEnv(values = {}) {
  const map = {
    baseURL: 'CUSTOM_AI_BASE_URL', apiKey: 'CUSTOM_AI_API_KEY', provider: 'CUSTOM_AI_PROVIDER',
    model: 'CUSTOM_AI_MODEL', modelName: 'CUSTOM_AI_MODEL_NAME', providerName: 'CUSTOM_AI_PROVIDER_NAME',
    defaultModel: 'DEFAULT_MODEL', githubToken: 'GITHUB_TOKEN',
  };
  for (const [key, envName] of Object.entries(map)) {
    if (values[key] !== undefined && values[key] !== null) process.env[envName] = String(values[key]);
  }
  if (values.username) config.auth.username = values.username;
  if (values.password) config.auth.password = values.password;
  if (values.username || values.passwordHash) setRuntimeCredentials({ username: values.username, passwordSalt: values.passwordSalt, passwordHash: values.passwordHash });
  config.customAI.baseURL = process.env.CUSTOM_AI_BASE_URL || null;
  config.customAI.apiKey = process.env.CUSTOM_AI_API_KEY || null;
  config.customAI.provider = process.env.CUSTOM_AI_PROVIDER || 'custom';
  config.customAI.model = process.env.CUSTOM_AI_MODEL || null;
  config.customAI.modelName = process.env.CUSTOM_AI_MODEL_NAME || null;
  config.customAI.providerName = process.env.CUSTOM_AI_PROVIDER_NAME || null;
  config.agent.defaultModel = process.env.DEFAULT_MODEL || '';
  config.github.token = process.env.GITHUB_TOKEN || null;
}

export async function loadRuntimeSettings() {
  try {
    saved = hydrateSettings(JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8')));
    applyEnv(saved);
    logger.info('[settings] Loaded site-managed runtime settings');
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn(`[settings] Could not load runtime settings: ${err.message}`);
  }
}

export async function saveRuntimeSettings(values) {
  saved = { ...saved, ...values };
  await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(serializableSettings(saved), null, 2), { mode: 0o600 });
  await fs.chmod(SETTINGS_FILE, 0o600).catch(() => {});
  applyEnv(saved);
  return { ...saved };
}
