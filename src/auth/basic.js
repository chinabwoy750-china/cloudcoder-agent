import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

function timingSafeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function parseBasicHeader(header) {
  if (!header || !header.startsWith('Basic ')) return null;
  let decoded;
  try { decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'); }
  catch { return null; }
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

export function checkCredentials(user, pass) {
  return timingSafeEq(user, config.auth.username) && timingSafeEq(pass, config.auth.password);
}

export function basicAuth(req, res, next) {
  const parsed = parseBasicHeader(req.headers.authorization);
  if (!parsed) {
    res.set('WWW-Authenticate', 'Basic realm="CloudCoder"');
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!checkCredentials(parsed.user, parsed.pass)) {
    logger.warn(`Auth failed: ${req.method} ${req.path}`);
    res.set('WWW-Authenticate', 'Basic realm="CloudCoder"');
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  req.authUser = parsed.user;
  next();
}
