import pg from 'pg';
import { logger } from '../utils/logger.js';

const { Pool } = pg;
let pool = null;
let initialized = false;

const schema = `
CREATE TABLE IF NOT EXISTS app_users (
  id UUID PRIMARY KEY,
  username VARCHAR(80) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (role IN ('admin','user')),
  disabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS workspaces (
  id VARCHAR(64) PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  name VARCHAR(120) NOT NULL,
  storage_key TEXT,
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS workspaces_owner_updated_idx ON workspaces(owner_user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS agent_jobs (
  id VARCHAR(64) PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) REFERENCES workspaces(id) ON DELETE SET NULL,
  type VARCHAR(40) NOT NULL,
  status VARCHAR(24) NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS agent_jobs_owner_created_idx ON agent_jobs(owner_user_id, created_at DESC);
CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  workspace_id VARCHAR(64) NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  job_id VARCHAR(64) REFERENCES agent_jobs(id) ON DELETE SET NULL,
  role VARCHAR(20) NOT NULL,
  content JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS chat_messages_workspace_created_idx ON chat_messages(workspace_id, created_at);
CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  owner_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
  event_type VARCHAR(80) NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export function isPostgresConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

export function getPostgresPool() {
  if (!isPostgresConfigured()) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
      max: Number.parseInt(process.env.PGPOOL_MAX || '5', 10),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    pool.on('error', (err) => logger.error(`[database] PostgreSQL pool error: ${err.message}`));
  }
  return pool;
}

export async function initializePostgres() {
  const db = getPostgresPool();
  if (!db) return { configured: false, initialized: false };
  if (initialized) return { configured: true, initialized: true };
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(schema);
    await client.query('COMMIT');
    initialized = true;
    logger.info('[database] PostgreSQL schema initialized');
    return { configured: true, initialized: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function postgresHealth() {
  if (!isPostgresConfigured()) return { configured: false, ready: false };
  try {
    await getPostgresPool().query('SELECT 1');
    return { configured: true, ready: true };
  } catch {
    return { configured: true, ready: false };
  }
}

export async function closePostgres() {
  if (pool) await pool.end();
  pool = null;
  initialized = false;
}
