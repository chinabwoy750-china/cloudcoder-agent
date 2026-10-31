import crypto from 'node:crypto';
import { config } from '../config/env.js';

function b64url(buf) { return Buffer.from(buf).toString('base64url'); }

export function signPreviewToken({ workspaceId, userId = null, expMs = 1000 * 60 * 30 }) {
  const payload = { wid: workspaceId, uid: userId, exp: Date.now() + expMs };
  const data = b64url(JSON.stringify(payload));
  const mac = crypto.createHmac('sha256', config.session.secret || 'preview').update(`preview:${data}`).digest('base64url');
  return `${data}.${mac}`;
}

export function verifyPreviewToken(token, workspaceId) {
  if (!token || typeof token !== 'string') return null;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return null;
  const data = token.slice(0, idx);
  const mac = token.slice(idx + 1);
  const expected = crypto.createHmac('sha256', config.session.secret || 'preview').update(`preview:${data}`).digest('base64url');
  const a = Buffer.from(mac); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (!payload.exp || Date.now() > payload.exp) return null;
    if (workspaceId && payload.wid !== workspaceId) return null;
    return payload;
  } catch { return null; }
}
