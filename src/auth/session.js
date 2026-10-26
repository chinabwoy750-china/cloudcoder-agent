import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { checkCredentials } from './basic.js';

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

export function signSession(payload) {
  const data = b64url(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', config.session.secret).update(data).digest('base64url');
  return `${data}.${mac}`;
}

export function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return null;
  const data = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expected = crypto.createHmac('sha256', config.session.secret).update(data).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

export function parseCookies(req) {
  const raw = req.headers.cookie;
  if (!raw) return {};
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function setSessionCookie(res, user) {
  const token = signSession({ user, exp: Date.now() + config.session.ttlMs });
  const attrs = [
    `${config.session.cookieName}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${Math.floor(config.session.ttlMs / 1000)}`,
  ];
  if (config.production) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

export function clearSessionCookie(res) {
  const attrs = [
    `${config.session.cookieName}=`,
    'HttpOnly', 'Path=/', 'SameSite=Strict', 'Max-Age=0',
  ];
  if (config.production) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

/**
 * Accept either HTTP Basic (API/curl) or a signed session cookie (web UI).
 */
export function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Basic ')) {
    const parsed = (() => {
      try {
        const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
        const i = decoded.indexOf(':');
        return i < 0 ? null : { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
      } catch { return null; }
    })();
    if (parsed && checkCredentials(parsed.user, parsed.pass)) {
      req.authUser = parsed.user;
      req.authMethod = 'basic';
      return next();
    }
  }

  const cookies = parseCookies(req);
  const session = verifySession(cookies[config.session.cookieName]);
  if (session) {
    req.authUser = session.user;
    req.authMethod = 'cookie';
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="CloudCoder"');
  return res.status(401).json({ error: 'Authentication required' });
}

/**
 * CSRF guard for cookie-authenticated state-changing requests.
 * Basic-auth callers are exempt (they must already know the password).
 */
export function csrfGuard(req, res, next) {
  if (req.authMethod !== 'cookie') return next();
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-CloudCoder-CSRF') === '1') return next();
  return res.status(403).json({ error: 'Missing CSRF header' });
}
