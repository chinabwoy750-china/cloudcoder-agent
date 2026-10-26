import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

const ROOT = config.limits.workspaceRoot;

export function safeSegment(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
}

export function newWorkspaceId() {
  return crypto.randomBytes(8).toString('hex');
}

function withinRoot(p) {
  const resolved = path.resolve(p);
  const root = path.resolve(ROOT);
  return resolved === root || resolved.startsWith(root + path.sep);
}

export async function createWorkspace(id = newWorkspaceId()) {
  const safeId = safeSegment(id);
  const dir = path.join(ROOT, safeId);
  if (!withinRoot(dir)) throw new Error('Workspace path escapes root');
  await fs.mkdir(ROOT, { recursive: true });
  await fs.mkdir(dir, { recursive: false });
  logger.info(`Workspace created: ${dir}`);
  return { id: safeId, dir };
}

export async function resolveWorkspace(id) {
  const safeId = safeSegment(id);
  const dir = path.resolve(path.join(ROOT, safeId));
  if (!withinRoot(dir)) throw new Error('Workspace path escapes root');
  const st = await fs.stat(dir).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error('Workspace not found');
  return dir;
}

/**
 * Resolve a path *inside* a workspace, refusing traversal.
 */
export function resolveInside(workspaceDir, relative) {
  const root = path.resolve(workspaceDir);
  const target = path.resolve(root, relative || '.');
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw Object.assign(new Error('Path escapes workspace'), { code: 'PATH_ESCAPE', status: 400 });
  }
  return target;
}

export async function removeWorkspace(id) {
  const safeId = safeSegment(id);
  const dir = path.resolve(path.join(ROOT, safeId));
  if (!withinRoot(dir) || dir === path.resolve(ROOT)) throw new Error('Refusing to remove root');
  await fs.rm(dir, { recursive: true, force: true });
  logger.info(`Workspace removed: ${dir}`);
}

export async function listWorkspaces() {
  const entries = await fs.readdir(ROOT, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

export async function workspaceStats(id) {
  const dir = await resolveWorkspace(id);
  let files = 0;
  let bytes = 0;
  async function walk(d) {
    const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name === '.git') continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        files += 1;
        const st = await fs.stat(full).catch(() => null);
        if (st) bytes += st.size;
      }
    }
  }
  await walk(dir);
  return { id: safeSegment(id), dir, files, bytes };
}
