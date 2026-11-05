import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/env.js';
import { resolveWorkspace, resolveInside } from './manager.js';
import { logger } from '../utils/logger.js';

const DENY_NAMES = new Set([
  '.universal-modder-chat.json','.env', '.env.local', '.env.production', 'id_rsa', 'id_ed25519', '.npmrc', '.netrc']);
const DENY_PATTERNS = [
  /^\.git\//,
  /(^|\/)\.ssh\//,
  /(^|\/)node_modules\//,
  /(^|\/)\.aws\//,
  /(^|\/)\.config\/gcloud\//,
];

function isDenied(rel) {
  const base = path.basename(rel);
  if (DENY_NAMES.has(base)) return true;
  return DENY_PATTERNS.some((p) => p.test(rel));
}

export async function listFiles(workspaceId, { subdir = '.', max = 2000 } = {}) {
  const root = await resolveWorkspace(workspaceId);
  const start = resolveInside(root, subdir);
  const out = [];
  async function walk(dir) {
    if (out.length >= max) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (out.length >= max) return;
      const full = path.join(dir, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (isDenied(rel)) continue;
      if (e.isDirectory()) {
        out.push({ path: rel + '/', type: 'dir' });
        await walk(full);
      } else if (e.isFile()) {
        const st = await fs.stat(full).catch(() => null);
        out.push({ path: rel, type: 'file', size: st?.size ?? 0 });
      }
    }
  }
  await walk(start);
  return out;
}

export async function readFile(workspaceId, relativePath) {
  const root = await resolveWorkspace(workspaceId);
  const rel = String(relativePath || '').replace(/\\/g, '/');
  if (!rel || isDenied(rel)) {
    throw Object.assign(new Error('File not accessible'), { code: 'FORBIDDEN_FILE' });
  }
  const full = resolveInside(root, rel);
  const st = await fs.stat(full);
  if (!st.isFile()) throw new Error('Not a file');
  if (st.size > config.limits.maxDownloadBytes) {
    throw Object.assign(new Error('File too large'), { code: 'TOO_LARGE' });
  }
  return { path: rel, size: st.size, content: await fs.readFile(full) };
}

export async function writeFile(workspaceId, relativePath, content) {
  const root = await resolveWorkspace(workspaceId);
  const rel = String(relativePath || '').replace(/\\/g, '/');
  if (!rel || isDenied(rel)) {
    throw Object.assign(new Error('File not writable'), { code: 'FORBIDDEN_FILE' });
  }
  const full = resolveInside(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
  logger.info(`Wrote ${rel} in workspace ${workspaceId}`);
  return { path: rel, bytes: Buffer.byteLength(content) };
}

export async function deleteFile(workspaceId, relativePath, { confirmed } = {}) {
  if (!confirmed) {
    throw Object.assign(new Error('Deletion requires confirmed=true'), { code: 'CONFIRM_REQUIRED' });
  }
  const root = await resolveWorkspace(workspaceId);
  const rel = String(relativePath || '').replace(/\\/g, '/');
  if (!rel || isDenied(rel)) {
    throw Object.assign(new Error('File not removable'), { code: 'FORBIDDEN_FILE' });
  }
  const full = resolveInside(root, rel);
  await fs.rm(full, { recursive: true, force: true });
  logger.info(`Deleted ${rel} in workspace ${workspaceId}`);
  return { path: rel, deleted: true };
}

export async function saveUpload(workspaceId, originalName, buffer, { subdir = '' } = {}) {
  const root = await resolveWorkspace(workspaceId);
  const base = path.basename(String(originalName || 'upload.bin')).replace(/[^a-zA-Z0-9._-]/g, '_');
  const rel = path.posix.join(subdir.replace(/\\/g, '/').replace(/^\/+/, ''), base);
  const full = resolveInside(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buffer);
  logger.info(`Uploaded ${rel} (${buffer.length} bytes) to ${workspaceId}`);
  return { path: rel, bytes: buffer.length };
}
