import crypto from 'node:crypto';
import { getPostgresPool, isPostgresConfigured } from '../storage/postgres.js';
import { logger } from '../utils/logger.js';

const SCRYPT_KEYLEN = 64;

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, SCRYPT_KEYLEN).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  const { hash } = hashPassword(password, salt);
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'));
  } catch {
    return false;
  }
}

export function newUserId() {
  return crypto.randomUUID();
}

export async function findUserByUsername(username) {
  const db = getPostgresPool();
  if (!db) return null;
  const { rows } = await db.query(
    'SELECT id, username, password_hash, password_salt, role, disabled, created_at, updated_at, last_login_at FROM app_users WHERE lower(username)=lower($1) LIMIT 1',
    [String(username || '').trim()]
  );
  return rows[0] || null;
}

export async function findUserById(id) {
  const db = getPostgresPool();
  if (!db) return null;
  const { rows } = await db.query(
    'SELECT id, username, password_hash, password_salt, role, disabled, created_at, updated_at, last_login_at FROM app_users WHERE id=$1 LIMIT 1',
    [id]
  );
  return rows[0] || null;
}

export async function countUsers() {
  const db = getPostgresPool();
  if (!db) return 0;
  const { rows } = await db.query('SELECT COUNT(*)::int AS c FROM app_users');
  return rows[0]?.c || 0;
}

export async function createUser({ username, password, role = 'user' }) {
  const db = getPostgresPool();
  if (!db) throw Object.assign(new Error('PostgreSQL is not configured'), { code: 'DB_NOT_CONFIGURED', status: 503 });
  const clean = String(username || '').trim();
  if (!clean || clean.length > 80) throw Object.assign(new Error('Username is required (max 80)'), { status: 400 });
  if (!password || String(password).length < 12) throw Object.assign(new Error('Password must be at least 12 characters'), { status: 400 });
  if (!['admin', 'user'].includes(role)) throw Object.assign(new Error('Invalid role'), { status: 400 });
  const { salt, hash } = hashPassword(password);
  const id = newUserId();
  try {
    const { rows } = await db.query(
      `INSERT INTO app_users (id, username, password_hash, password_salt, role)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, username, role, disabled, created_at`,
      [id, clean, hash, salt, role]
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') throw Object.assign(new Error('Username already taken'), { status: 409 });
    throw err;
  }
}

export async function touchLastLogin(userId) {
  const db = getPostgresPool();
  if (!db) return;
  await db.query('UPDATE app_users SET last_login_at=NOW(), updated_at=NOW() WHERE id=$1', [userId]);
}

export async function setUserDisabled(userId, disabled) {
  const db = getPostgresPool();
  if (!db) throw Object.assign(new Error('PostgreSQL is not configured'), { status: 503 });
  const { rows } = await db.query(
    'UPDATE app_users SET disabled=$2, updated_at=NOW() WHERE id=$1 RETURNING id, username, role, disabled',
    [userId, Boolean(disabled)]
  );
  return rows[0] || null;
}

export async function listUsers({ limit = 100, offset = 0 } = {}) {
  const db = getPostgresPool();
  if (!db) return [];
  const { rows } = await db.query(
    `SELECT id, username, role, disabled, created_at, updated_at, last_login_at
     FROM app_users ORDER BY created_at ASC LIMIT $1 OFFSET $2`,
    [Math.min(Number(limit) || 100, 500), Math.max(Number(offset) || 0, 0)]
  );
  return rows;
}

/**
 * Bootstrap the first admin from env credentials when the users table is empty.
 * Safe to call on every startup; no-ops if users already exist or Postgres is off.
 */
export async function bootstrapAdminFromEnv() {
  if (!isPostgresConfigured()) return { bootstrapped: false, reason: 'db-not-configured' };
  const existing = await countUsers();
  if (existing > 0) return { bootstrapped: false, reason: 'users-exist', count: existing };

  const username = String(process.env.CLOUDCODER_USERNAME || process.env.ADMIN_USERNAME || '').trim();
  const password = process.env.CLOUDCODER_PASSWORD || process.env.ADMIN_PASSWORD || '';
  if (!username || !password) {
    logger.warn('[auth] DATABASE_URL set but no users exist and CLOUDCODER_USERNAME/PASSWORD missing; admin bootstrap skipped');
    return { bootstrapped: false, reason: 'missing-env-credentials' };
  }
  if (String(password).length < 12) {
    logger.warn('[auth] Admin bootstrap password must be at least 12 characters; skipped');
    return { bootstrapped: false, reason: 'weak-password' };
  }
  const user = await createUser({ username, password, role: 'admin' });
  logger.info(`[auth] Bootstrapped initial admin user id=${user.id} username=${user.username}`);
  return { bootstrapped: true, user: { id: user.id, username: user.username, role: user.role } };
}

export async function authenticateDbUser(username, password) {
  const user = await findUserByUsername(username);
  if (!user) return null;
  if (user.disabled) return null;
  if (!verifyPassword(password, user.password_salt, user.password_hash)) return null;
  await touchLastLogin(user.id);
  return {
    id: user.id,
    username: user.username,
    role: user.role,
  };
}
