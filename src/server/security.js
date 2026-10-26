import { config } from '../config/env.js';

export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
    "frame-ancestors 'none'; form-action 'self'"
  );
  if (config.production) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
}

export function corsGuard(req, res, next) {
  // Same-origin app: reject cross-origin requests outright.
  const origin = req.headers.origin;
  if (origin) {
    const host = req.headers.host;
    let originHost = null;
    try { originHost = new URL(origin).host; } catch { /* ignore */ }
    if (!originHost || originHost !== host) {
      return res.status(403).json({ error: 'Cross-origin request rejected' });
    }
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-CloudCoder-CSRF');
    res.setHeader('Access-Control-Max-Age', '600');
    return res.status(204).end();
  }
  next();
}
