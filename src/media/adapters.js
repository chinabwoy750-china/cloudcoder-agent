/**
 * Media generation provider adapters.
 * Only implements endpoints that are known on the configured China-GPT / OpenAI-compatible stack.
 * Does not invent unsupported provider APIs.
 */
import { config } from '../config/env.js';
import { putObject, newObjectKey } from '../storage/objects.js';
import { logger } from '../utils/logger.js';

function chinaBase() {
  return (process.env.CHINA_GPT_BASE_URL || config.customAI?.baseURL || 'https://gpt-china.onrender.com').replace(/\/+$/, '');
}
function chinaKey() {
  return process.env.CHINA_GPT_API_KEY || config.customAI?.apiKey || '';
}

async function chinaFetch(endpoint, { method = 'POST', body, binary = false, timeoutMs = 180000 } = {}) {
  const key = chinaKey();
  if (!key) {
    const err = new Error('China-GPT is not configured');
    err.status = 503;
    err.code = 'MEDIA_PROVIDER_UNCONFIGURED';
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetch(`${chinaBase()}${endpoint}`, {
      method,
      headers: {
        'X-China-GPT-Key': key,
        'Content-Type': 'application/json',
        Accept: binary ? '*/*' : 'application/json',
      },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!upstream.ok) {
      const details = await upstream.text().catch(() => '');
      const err = new Error(`Media provider error (${upstream.status})`);
      err.status = upstream.status;
      err.details = details.slice(0, 3000);
      throw err;
    }
    if (binary) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      return { binary: true, contentType: upstream.headers.get('content-type') || 'application/octet-stream', body: buf };
    }
    return { binary: false, json: await upstream.json() };
  } finally {
    clearTimeout(timer);
  }
}

export function listMediaCapabilities() {
  const china = Boolean(chinaKey());
  return {
    providers: [
      {
        id: 'china-gpt',
        name: 'China-GPT',
        configured: china,
        capabilities: {
          image: china,
          video: china,
          audio: china,
        },
        endpoints: {
          image: '/v1/image-generation',
          video: '/v1/video-generation',
          audio: '/v1/audio',
        },
      },
    ],
  };
}

export async function generateImage(payload = {}) {
  const result = await chinaFetch('/v1/image-generation', { body: payload });
  return { provider: 'china-gpt', kind: 'image', ...result };
}

export async function generateVideo(payload = {}) {
  const result = await chinaFetch('/v1/video-generation', { body: payload, timeoutMs: 300000 });
  return { provider: 'china-gpt', kind: 'video', ...result };
}

export async function generateAudio(payload = {}) {
  const result = await chinaFetch('/v1/audio', { body: payload, binary: true });
  return { provider: 'china-gpt', kind: 'audio', ...result };
}

/**
 * Persist generated binary/json asset into object storage + optional workspace path.
 */
export async function storeGeneratedAsset({ kind, data, contentType, workspaceId }) {
  const key = newObjectKey(`media/${kind}${workspaceId ? `/${workspaceId}` : ''}`, kind === 'audio' ? 'bin' : 'json');
  if (Buffer.isBuffer(data)) {
    const stored = await putObject(key, data, contentType || 'application/octet-stream');
    return { storageKey: stored.key, bytes: stored.bytes, contentType };
  }
  const stored = await putObject(key, JSON.stringify(data), 'application/json');
  return { storageKey: stored.key, bytes: stored.bytes, contentType: 'application/json' };
}

export async function safeGenerate(kind, payload) {
  try {
    let result;
    if (kind === 'image') result = await generateImage(payload);
    else if (kind === 'video') result = await generateVideo(payload);
    else if (kind === 'audio') result = await generateAudio(payload);
    else {
      const err = new Error(`Unsupported media kind: ${kind}`);
      err.status = 400;
      throw err;
    }
    let asset = null;
    if (result.binary) {
      asset = await storeGeneratedAsset({
        kind,
        data: result.body,
        contentType: result.contentType,
        workspaceId: payload.workspaceId,
      }).catch((err) => {
        logger.warn(`[media] store failed: ${err.message}`);
        return null;
      });
    } else if (result.json) {
      asset = await storeGeneratedAsset({
        kind,
        data: result.json,
        workspaceId: payload.workspaceId,
      }).catch(() => null);
    }
    return { ok: true, result, asset };
  } catch (err) {
    return {
      ok: false,
      error: err.message,
      status: err.status || 502,
      code: err.code || 'MEDIA_FAILED',
      details: err.details || null,
    };
  }
}
