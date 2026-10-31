import fs from 'node:fs/promises';
import { createZip } from './zip.js';
import { putObject, newObjectKey, getObjectStorageMode } from '../storage/objects.js';
import { safeSegment } from './manager.js';
import { logger } from '../utils/logger.js';

/**
 * Build a ZIP of the workspace and mirror bytes into object storage.
 * createZip writes a file and returns { path, name, size }.
 */
export async function exportWorkspaceArchive(workspaceId, opts = {}) {
  const id = safeSegment(workspaceId);
  const zipped = await createZip(id, opts);
  const buffer = await fs.readFile(zipped.path);
  const key = newObjectKey(`workspaces/${id}/exports`, 'zip');
  let stored = null;
  try {
    stored = await putObject(key, buffer, 'application/zip');
  } catch (err) {
    logger.warn(`[archive] durable mirror failed for ${id}: ${err.message}`);
  }
  return {
    filename: zipped.name,
    bytes: zipped.size,
    path: zipped.path,
    storageKey: stored?.key || null,
    storageMode: getObjectStorageMode(),
  };
}
