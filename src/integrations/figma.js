/**
 * Figma adapter groundwork — credential storage and capability flags only.
 * No Figma-to-code pipeline is claimed until implemented and tested.
 */
import { getPlatformSetting, setPlatformSetting } from '../db/platform-settings.js';
import { isPostgresConfigured } from '../storage/postgres.js';

const KEY = 'figma_connection';

export async function getFigmaConfig() {
  if (!isPostgresConfigured()) return { configured: false, hasToken: false, status: 'groundwork' };
  const value = await getPlatformSetting(KEY, {});
  return {
    configured: Boolean(value?.token),
    hasToken: Boolean(value?.token),
    fileKey: value?.fileKey || null,
    status: 'groundwork',
    capabilities: { importFrames: false, codegen: false },
  };
}

export async function saveFigmaConfig({ token, fileKey, clearToken = false }) {
  if (!isPostgresConfigured()) {
    const err = new Error('DATABASE_URL required');
    err.status = 503;
    throw err;
  }
  const current = await getPlatformSetting(KEY, {});
  const next = {
    token: clearToken ? '' : (token ? String(token).slice(0, 200) : current.token),
    fileKey: fileKey != null ? String(fileKey).slice(0, 80) : current.fileKey,
  };
  await setPlatformSetting(KEY, next);
  return getFigmaConfig();
}
