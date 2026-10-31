import { getPostgresPool, isPostgresConfigured } from '../storage/postgres.js';

export async function recordWorkspace({ id, ownerUserId, name, storageKey = null, status = 'active' }) {
  const db = getPostgresPool();
  if (!db || !ownerUserId) return null;
  const { rows } = await db.query(
    `INSERT INTO workspaces (id, owner_user_id, name, storage_key, status)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (id) DO UPDATE SET
       name=EXCLUDED.name,
       updated_at=NOW()
     RETURNING *`,
    [id, ownerUserId, name, storageKey, status]
  );
  return rows[0] || null;
}

export async function renameWorkspaceRow(id, ownerUserId, name) {
  const db = getPostgresPool();
  if (!db) return null;
  const { rows } = await db.query(
    `UPDATE workspaces SET name=$3, updated_at=NOW()
     WHERE id=$1 AND owner_user_id=$2
     RETURNING *`,
    [id, ownerUserId, name]
  );
  return rows[0] || null;
}

export async function getWorkspaceRow(id) {
  const db = getPostgresPool();
  if (!db) return null;
  const { rows } = await db.query('SELECT * FROM workspaces WHERE id=$1 LIMIT 1', [id]);
  return rows[0] || null;
}

export async function listWorkspacesForUser(ownerUserId, { limit = 100, offset = 0 } = {}) {
  const db = getPostgresPool();
  if (!db) return [];
  const { rows } = await db.query(
    `SELECT id, owner_user_id, name, status, created_at, updated_at
     FROM workspaces WHERE owner_user_id=$1
     ORDER BY updated_at DESC LIMIT $2 OFFSET $3`,
    [ownerUserId, Math.min(Number(limit) || 100, 500), Math.max(Number(offset) || 0, 0)]
  );
  return rows;
}

export async function deleteWorkspaceRow(id, ownerUserId) {
  const db = getPostgresPool();
  if (!db) return false;
  const { rowCount } = await db.query(
    'DELETE FROM workspaces WHERE id=$1 AND owner_user_id=$2',
    [id, ownerUserId]
  );
  return rowCount > 0;
}

export async function assertWorkspaceOwner(workspaceId, userId, { allowAdmin = true, userRole = 'user' } = {}) {
  if (!isPostgresConfigured()) return { ok: true, mode: 'legacy' };
  if (!userId) {
    const err = new Error('Authentication required');
    err.status = 401;
    err.code = 'AUTH_REQUIRED';
    throw err;
  }
  const row = await getWorkspaceRow(workspaceId);
  if (!row) {
    // Workspace may exist only on disk (pre-migration). Allow owner-less legacy until backfill.
    return { ok: true, mode: 'legacy-untracked' };
  }
  if (row.owner_user_id === userId) return { ok: true, mode: 'owner', row };
  if (allowAdmin && userRole === 'admin') return { ok: true, mode: 'admin', row };
  const err = new Error('Workspace not found');
  err.status = 404;
  err.code = 'WORKSPACE_FORBIDDEN';
  throw err;
}

export { isPostgresConfigured };
