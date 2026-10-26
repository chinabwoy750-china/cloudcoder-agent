const buckets = new Map();

/**
 * Sliding-window limiter. Returns true if allowed, false if limited.
 */
export function rateLimit(key, { windowMs = 60000, max = 120 } = {}) {
  const now = Date.now();
  const hits = buckets.get(key) || [];
  const recent = hits.filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    buckets.set(key, recent);
    return false;
  }
  recent.push(now);
  buckets.set(key, recent);
  if (buckets.size > 10000) buckets.clear(); // crude memory guard
  return true;
}

export function rateLimitMiddleware({ windowMs = 60000, max = 120, keyFn } = {}) {
  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : (req.ip || 'unknown');
    if (!rateLimit(key, { windowMs, max })) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({ error: 'Too many requests' });
    }
    next();
  };
}
