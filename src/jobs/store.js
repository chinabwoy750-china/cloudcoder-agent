/**
 * Durable job persistence on PostgreSQL when available.
 * Falls back to no-op when DATABASE_URL is absent (in-memory registry remains source of truth).
 */
import { getPostgresPool, isPostgresConfigured } from '../storage/postgres.js';
import { logger } from '../utils/logger.js';

export async function persistJobCreate(job) {
  const db = getPostgresPool();
  if (!db) return;
  try {
    const owner = job.meta?.ownerUserId || null;
    const workspaceId = job.meta?.workspaceId || null;
    // owner_user_id is NOT NULL in schema — skip DB row if we have no owner (legacy single-user).
    if (!owner) return;
    await db.query(
      `INSERT INTO agent_jobs (id, owner_user_id, workspace_id, type, status, meta, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb, TO_TIMESTAMP($7/1000.0), TO_TIMESTAMP($8/1000.0))
       ON CONFLICT (id) DO NOTHING`,
      [
        job.id,
        owner,
        workspaceId,
        job.type,
        job.status,
        JSON.stringify(job.meta || {}),
        job.createdAt,
        job.updatedAt,
      ]
    );
  } catch (err) {
    logger.warn(`[jobs] persist create failed for ${job.id}: ${err.message}`);
  }
}

export async function persistJobUpdate(job) {
  const db = getPostgresPool();
  if (!db) return;
  try {
    if (!job.meta?.ownerUserId) return;
    await db.query(
      `UPDATE agent_jobs
       SET status=$2,
           result=$3::jsonb,
           error=$4,
           meta=$5::jsonb,
           updated_at=TO_TIMESTAMP($6/1000.0)
       WHERE id=$1`,
      [
        job.id,
        job.status,
        job.result != null ? JSON.stringify(job.result) : null,
        job.error,
        JSON.stringify(job.meta || {}),
        job.updatedAt,
      ]
    );
  } catch (err) {
    logger.warn(`[jobs] persist update failed for ${job.id}: ${err.message}`);
  }
}

export async function persistJobEvents(jobId, events) {
  // Events stay in memory for streaming; optional object storage snapshot of tail.
  // Avoid writing every token to Postgres (cost/volume). Snapshot on finish only.
  return null;
}

export async function loadJobFromDb(jobId) {
  const db = getPostgresPool();
  if (!db) return null;
  try {
    const { rows } = await db.query(`SELECT * FROM agent_jobs WHERE id=$1 LIMIT 1`, [jobId]);
    return rows[0] || null;
  } catch (err) {
    logger.warn(`[jobs] load failed for ${jobId}: ${err.message}`);
    return null;
  }
}

export async function listJobsForUser(ownerUserId, { limit = 50, offset = 0 } = {}) {
  const db = getPostgresPool();
  if (!db || !ownerUserId) return [];
  const { rows } = await db.query(
    `SELECT id, owner_user_id, workspace_id, type, status, meta, error, created_at, updated_at
     FROM agent_jobs WHERE owner_user_id=$1
     ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [ownerUserId, Math.min(Number(limit) || 50, 200), Math.max(Number(offset) || 0, 0)]
  );
  return rows;
}

export async function markStaleJobsFailed(maxAgeMs = 1000 * 60 * 60 * 6) {
  const db = getPostgresPool();
  if (!db) return 0;
  try {
    const { rowCount } = await db.query(
      `UPDATE agent_jobs
       SET status='failed',
           error=COALESCE(error, 'Process restarted before job completed'),
           updated_at=NOW()
       WHERE status IN ('running','cancelling')
         AND updated_at < NOW() - ($1::text || ' milliseconds')::interval`,
      [String(maxAgeMs)]
    );
    if (rowCount) logger.info(`[jobs] marked ${rowCount} stale job(s) failed after restart`);
    return rowCount || 0;
  } catch (err) {
    logger.warn(`[jobs] stale cleanup failed: ${err.message}`);
    return 0;
  }
}

export { isPostgresConfigured };
