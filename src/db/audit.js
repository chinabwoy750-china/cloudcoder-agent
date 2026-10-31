import { getPostgresPool } from '../storage/postgres.js';
import { logger } from '../utils/logger.js';

export async function writeAuditEvent({ ownerUserId = null, eventType, details = {} }) {
  const db = getPostgresPool();
  if (!db) return null;
  try {
    const { rows } = await db.query(
      `INSERT INTO audit_events (owner_user_id, event_type, details)
       VALUES ($1,$2,$3::jsonb) RETURNING id, created_at`,
      [ownerUserId, String(eventType || 'unknown').slice(0, 80), JSON.stringify(details || {})]
    );
    return rows[0] || null;
  } catch (err) {
    logger.warn(`[audit] failed to write event ${eventType}: ${err.message}`);
    return null;
  }
}
