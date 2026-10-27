import { Octokit } from 'octokit';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

let client = null;

export function resetOctokit() { client = null; }

export function getOctokit() {
  if (!config.github.token) return null;
  if (client) return client;
  client = new Octokit({
    auth: config.github.token,
    userAgent: config.github.userAgent,
    request: { headers: { 'X-GitHub-Api-Version': config.github.apiVersion } },
  });
  return client;
}

export async function withRetry(fn, { maxAttempts = 3 } = {}) {
  let attempt = 0;
  let lastErr;
  while (attempt < maxAttempts) {
    attempt += 1;
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const status = err.status || err.response?.status;
      const headers = err.response?.headers || {};
      if (status === 403 && headers['x-ratelimit-remaining'] === '0' && headers['x-ratelimit-reset']) {
        const waitMs = Math.max(0, parseInt(headers['x-ratelimit-reset'], 10) * 1000 - Date.now()) + 1000;
        logger.warn(`GitHub rate limit; waiting ${Math.round(waitMs / 1000)}s`);
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      const retryable = status === 429 || (status >= 500 && status < 600);
      if (!retryable || attempt >= maxAttempts) break;
      const delay = Math.min(8000, 500 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}
