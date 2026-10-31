import { getPostgresPool, isPostgresConfigured } from '../storage/postgres.js';

const KEY_REGISTRATION = 'registration_enabled';

export async function getPlatformSetting(key, fallback = null) {
  const db = getPostgresPool();
  if (!db) return fallback;
  // Use audit-free simple key-value via a lightweight table if present; fall back to env.
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        key VARCHAR(80) PRIMARY KEY,
        value JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const { rows } = await db.query('SELECT value FROM platform_settings WHERE key=$1', [key]);
    if (!rows[0]) return fallback;
    return rows[0].value;
  } catch {
    return fallback;
  }
}

export async function setPlatformSetting(key, value) {
  const db = getPostgresPool();
  if (!db) throw Object.assign(new Error('PostgreSQL is not configured'), { status: 503 });
  await db.query(`
    CREATE TABLE IF NOT EXISTS platform_settings (
      key VARCHAR(80) PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(
    `INSERT INTO platform_settings (key, value) VALUES ($1,$2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
    [key, JSON.stringify(value)]
  );
  return true;
}

export async function isRegistrationEnabled() {
  if (!isPostgresConfigured()) return false;
  const envDefault = process.env.ALLOW_PUBLIC_REGISTRATION === 'true';
  const stored = await getPlatformSetting(KEY_REGISTRATION, { enabled: envDefault });
  if (stored && typeof stored === 'object' && 'enabled' in stored) return Boolean(stored.enabled);
  return Boolean(stored);
}

export async function setRegistrationEnabled(enabled) {
  return setPlatformSetting(KEY_REGISTRATION, { enabled: Boolean(enabled) });
}
