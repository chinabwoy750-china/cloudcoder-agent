import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { recordWorkspace, renameWorkspaceRow, deleteWorkspaceRow, listWorkspacesForUser, assertWorkspaceOwner } from '../db/workspaces.js';
import { isPostgresConfigured } from '../storage/postgres.js';

const ROOT = config.limits.workspaceRoot;
const META_ROOT = `${ROOT}.metadata`;

function cleanWorkspaceName(name, fallback = 'Untitled workspace') {
  const value = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
  return value || fallback;
}

async function writeWorkspaceMeta(id, meta) {
  await fs.mkdir(META_ROOT, { recursive: true });
  const file = path.join(META_ROOT, `${safeSegment(id)}.json`);
  await fs.writeFile(file, JSON.stringify(meta, null, 2), { mode: 0o600 });
}

export async function getWorkspaceMeta(id) {
  const safeId = safeSegment(id);
  try { return JSON.parse(await fs.readFile(path.join(META_ROOT, `${safeId}.json`), 'utf8')); }
  catch { return { id: safeId, name: safeId, createdAt: null }; }
}

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

/**
 * Create a workspace on disk and, when multi-user DB is active, record ownership.
 * @param {string} [id]
 * @param {string} [name]
 * @param {{ ownerUserId?: string|null }} [opts]
 */
export async function createWorkspace(id = newWorkspaceId(), name = 'Untitled workspace', opts = {}) {
  const safeId = safeSegment(id);
  const dir = path.join(ROOT, safeId);
  if (!withinRoot(dir)) throw new Error('Workspace path escapes root');
  await fs.mkdir(ROOT, { recursive: true });
  await fs.mkdir(dir, { recursive: false });
  const cleaned = cleanWorkspaceName(name, safeId);
  const meta = {
    id: safeId,
    name: cleaned,
    createdAt: new Date().toISOString(),
    ownerUserId: opts.ownerUserId || null,
  };
  await writeWorkspaceMeta(safeId, meta);
  if (opts.ownerUserId && isPostgresConfigured()) {
    try {
      await recordWorkspace({ id: safeId, ownerUserId: opts.ownerUserId, name: cleaned });
    } catch (err) {
      logger.warn(`[workspace] failed to record ownership for ${safeId}: ${err.message}`);
    }
  }
  logger.info(`Workspace created: ${dir}`);
  return { id: safeId, dir, ...meta };
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
 * Resolve workspace and enforce ownership when multi-user mode is active.
 */
export async function resolveWorkspaceForUser(id, user) {
  const dir = await resolveWorkspace(id);
  if (user?.id || user?.role) {
    await assertWorkspaceOwner(safeSegment(id), user?.id || null, {
      allowAdmin: true,
      userRole: user?.role || 'user',
    });
  }
  return dir;
}

export async function renameWorkspace(id, name, user = null) {
  const safeId = safeSegment(id);
  await resolveWorkspace(safeId);
  if (user?.id) {
    await assertWorkspaceOwner(safeId, user.id, { allowAdmin: true, userRole: user.role || 'user' });
  }
  const cleaned = cleanWorkspaceName(name, safeId);
  const meta = await getWorkspaceMeta(safeId);
  meta.name = cleaned;
  meta.updatedAt = new Date().toISOString();
  await writeWorkspaceMeta(safeId, meta);
  if (user?.id && isPostgresConfigured()) {
    await renameWorkspaceRow(safeId, user.id, cleaned).catch(() => {});
  }
  return { id: safeId, name: cleaned };
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

export async function removeWorkspace(id, user = null) {
  const safeId = safeSegment(id);
  if (user?.id) {
    await assertWorkspaceOwner(safeId, user.id, { allowAdmin: true, userRole: user.role || 'user' });
  }
  const dir = path.resolve(path.join(ROOT, safeId));
  if (!withinRoot(dir) || dir === path.resolve(ROOT)) throw new Error('Refusing to remove root');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(path.join(META_ROOT, `${safeId}.json`), { force: true }).catch(() => {});
  if (user?.id && isPostgresConfigured()) {
    await deleteWorkspaceRow(safeId, user.id).catch(() => {});
  }
  logger.info(`Workspace removed: ${dir}`);
}

export async function listWorkspaces(user = null) {
  if (user?.id && isPostgresConfigured()) {
    const rows = await listWorkspacesForUser(user.id);
    // Prefer DB list; still include disk-only legacy workspaces owned by no one only for admins.
    const ids = new Set(rows.map((r) => r.id));
    const result = [];
    for (const row of rows) {
      const meta = await getWorkspaceMeta(row.id);
      result.push({ id: row.id, name: row.name || meta.name, createdAt: row.created_at, updatedAt: row.updated_at });
    }
    if (user.role === 'admin') {
      const disk = await fs.readdir(ROOT, { withFileTypes: true }).catch(() => []);
      for (const e of disk.filter((d) => d.isDirectory() && !d.name.startsWith('.'))) {
        if (!ids.has(e.name)) {
          const meta = await getWorkspaceMeta(e.name);
          result.push({ id: e.name, name: meta.name, createdAt: meta.createdAt, legacy: true });
        }
      }
    }
    return result;
  }
  const entries = await fs.readdir(ROOT, { withFileTypes: true }).catch(() => []);
  const names = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  const out = [];
  for (const id of names) {
    const meta = await getWorkspaceMeta(id);
    out.push({ id, name: meta.name, createdAt: meta.createdAt });
  }
  return out;
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
