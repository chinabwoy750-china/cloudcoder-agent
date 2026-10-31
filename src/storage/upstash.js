/** Minimal Upstash Redis REST adapter. No additional dependency is required. */
function keyPrefix() { return (process.env.UPSTASH_REDIS_PREFIX || 'universal-modder').replace(/[^a-zA-Z0-9:_-]/g, '-'); }

export function isUpstashConfigured() {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

function endpoint() {
  const raw = process.env.UPSTASH_REDIS_REST_URL;
  if (!raw) throw new Error('UPSTASH_REDIS_REST_URL is not configured');
  const url = new URL(raw);
  if (url.protocol !== 'https:') throw new Error('Upstash Redis REST URL must use HTTPS');
  return url.toString().replace(/\/$/, '');
}

async function command(...args) {
  if (!isUpstashConfigured()) throw new Error('Upstash Redis is not configured');
  const response = await fetch(endpoint(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`Upstash Redis request failed (HTTP ${response.status})`);
  const payload = await response.json();
  if (payload.error) throw new Error(`Upstash Redis command failed: ${String(payload.error).slice(0, 200)}`);
  return payload.result;
}

function redisKey(key) {
  return `${keyPrefix()}:${String(key).replace(/[^a-zA-Z0-9:_-]/g, '-')}`;
}

export async function redisGetJson(key) {
  const result = await command('GET', redisKey(key));
  if (result == null) return null;
  try { return JSON.parse(result); }
  catch { throw new Error(`Stored Redis value for ${key} is not valid JSON`); }
}

export async function redisSetJson(key, value) {
  await command('SET', redisKey(key), JSON.stringify(value));
  return true;
}

export async function redisPing() {
  return (await command('PING')) === 'PONG';
}
