import { config } from '../config/env.js';

const BASE = `http://${config.opencode.hostname}:${config.opencode.port}`;
const AUTH = 'Basic ' + Buffer.from(
  `${config.opencode.username}:${config.opencode.password}`
).toString('base64');

/**
 * Thin HTTP client for the OpenCode server. All calls carry the internal
 * basic-auth header. `directory` selects the project root for the request.
 */
export async function oc(method, pathname, { body, query, timeoutMs = 30000, signal } = {}) {
  const url = new URL(BASE + pathname);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    if (!res.ok) {
      const err = new Error(`OpenCode ${method} ${pathname} → ${res.status}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export function splitModel(model) {
  if (!model || !model.includes('/')) return null;
  const [providerID, ...rest] = model.split('/');
  return { providerID, modelID: rest.join('/') };
}
