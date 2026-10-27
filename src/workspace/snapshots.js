import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { resolveWorkspace, safeSegment } from './manager.js';

const SNAPSHOT_ROOT = process.env.WORKSPACE_SNAPSHOT_PATH || `${config.limits.workspaceRoot}.snapshots`;
const MAX_FILES = 1500;
const MAX_BYTES = 30 * 1024 * 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.universal-modder-snapshots']);

function safeSnapshotId(id) {
  const value = String(id || '');
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(value)) throw Object.assign(new Error('Invalid snapshot ID'), { status: 400 });
  return value;
}
async function walkFiles(dir, rel = '') {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const nextRel = path.posix.join(rel, entry.name);
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walkFiles(full, nextRel));
    else if (entry.isFile()) out.push({ full, rel: nextRel });
    if (out.length > MAX_FILES) throw Object.assign(new Error(`Snapshot exceeds ${MAX_FILES} files`), { status: 413 });
  }
  return out;
}
export async function listWorkspaceSnapshots(workspaceId) {
  const id = safeSegment(workspaceId);
  const dir = path.join(SNAPSHOT_ROOT, id);
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-zA-Z0-9_-]{8,80}$/.test(entry.name)) continue;
    try {
      const meta = JSON.parse(await fs.readFile(path.join(dir, entry.name, 'snapshot.json'), 'utf8'));
      result.push({ id: entry.name, createdAt: meta.createdAt, files: meta.files, bytes: meta.bytes, label: meta.label });
    } catch {}
  }
  return result.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 30);
}
export async function createWorkspaceSnapshot(workspaceId, label = '') {
  const id = safeSegment(workspaceId);
  const source = await resolveWorkspace(id);
  const files = await walkFiles(source);
  const total = files.reduce((sum, f) => sum + 0, 0);
  let bytes = 0;
  for (const item of files) {
    const st = await fs.stat(item.full);
    bytes += st.size;
    if (bytes > MAX_BYTES) throw Object.assign(new Error(`Snapshot exceeds ${MAX_BYTES} bytes`), { status: 413 });
  }
  const snapId = `${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
  const base = path.join(SNAPSHOT_ROOT, id, snapId);
  await fs.mkdir(base, { recursive: true, mode: 0o700 });
  try {
    for (const item of files) {
      const dest = path.join(base, 'files', item.rel);
      await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      await fs.copyFile(item.full, dest);
    }
    const meta = { id: snapId, workspaceId: id, createdAt: new Date().toISOString(), files: files.length, bytes, label: String(label || '').replace(/[\u0000-\u001f]/g, '').slice(0, 120) };
    await fs.writeFile(path.join(base, 'snapshot.json'), JSON.stringify(meta, null, 2), { mode: 0o600 });
    return { id: snapId, createdAt: meta.createdAt, files: meta.files, bytes: meta.bytes, label: meta.label };
  } catch (err) {
    await fs.rm(base, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}
export async function restoreWorkspaceSnapshot(workspaceId, snapshotId) {
  const id = safeSegment(workspaceId);
  const snapId = safeSnapshotId(snapshotId);
  const workspace = await resolveWorkspace(id);
  const base = path.join(SNAPSHOT_ROOT, id, snapId);
  const meta = JSON.parse(await fs.readFile(path.join(base, 'snapshot.json'), 'utf8').catch(() => { throw Object.assign(new Error('Snapshot not found'), { status: 404 }); }));
  if (meta.workspaceId !== id) throw Object.assign(new Error('Snapshot does not belong to this workspace'), { status: 404 });
  // Destructive restore is only invoked by the explicit confirm=true route.
  for (const entry of await fs.readdir(workspace, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    await fs.rm(path.join(workspace, entry.name), { recursive: true, force: true });
  }
  const source = path.join(base, 'files');
  for (const item of await walkFiles(source)) {
    const dest = path.join(workspace, item.rel);
    const resolved = path.resolve(dest);
    if (resolved !== workspace && !resolved.startsWith(path.resolve(workspace) + path.sep)) throw Object.assign(new Error('Snapshot path is invalid'), { status: 400 });
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(item.full, dest);
  }
  return { restored: true, snapshotId: snapId, files: meta.files, bytes: meta.bytes };
}
