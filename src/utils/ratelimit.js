const buckets = new Map();

/**
 * Sliding-window limiter. Returns true if allowed, false if limited.
 */
export function rateLimit(key, { windowMs = 60000, max = 120 } = {}) {
  if (process.env.RATE_LIMIT_DISABLED === '1' || process.env.RATE_LIMIT_DISABLED === 'true') {
    return true;
  }
  const now = Date.now();
  const hits = buckets.get(key) || [];
  const recent = hits.filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    buckets.set(key, recent);
    return false;
  }
  recent.push(now);
  buckets.set(key, recent);
  // Bound memory without wiping active windows for everyone
  if (buckets.size > 20000) {
    for (const [k, arr] of buckets) {
      const kept = arr.filter((t) => now - t < windowMs);
      if (!kept.length) buckets.delete(k);
      else buckets.set(k, kept);
    }
  }
  return true;
}

/**
 * Prefer authenticated user id so one shared NAT/IP does not block everyone.
 * Falls back to IP for anonymous routes (login).
 */
export function defaultRateLimitKey(req) {
  if (req.authUserId) return `user:${req.authUserId}`;
  if (req.sessionUser?.id) return `user:${req.sessionUser.id}`;
  const ip = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  return `ip:${String(ip).split(',')[0].trim()}`;
}

export function rateLimitMiddleware({ windowMs = 60000, max = 120, keyFn } = {}) {
  return (req, res, next) => {
    // Never throttle live streams / health-style traffic if mounted under this middleware
    if (req.path?.includes('/stream') || req.path === '/health' || req.path === '/ready') {
      return next();
    }
    const key = `${windowMs}:${max}:${(keyFn || defaultRateLimitKey)(req)}`;
    if (!rateLimit(key, { windowMs, max })) {
      res.set('Retry-After', String(Math.ceil(windowMs / 1000)));
      return res.status(429).json({
        error: 'Too many requests — please wait a moment and try again',
        retryAfterSec: Math.ceil(windowMs / 1000),
      });
    }
    next();
  };
}
