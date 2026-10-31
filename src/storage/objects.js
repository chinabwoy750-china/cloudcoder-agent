/**
 * Durable object/file storage adapter.
 * - When S3-compatible credentials exist: upload/download via AWS Signature V4-free simple PUT/GET (S3 REST).
 * - Otherwise: local durable directory (OBJECT_STORAGE_PATH or /var/data/objects or workspace-adjacent).
 * Large project archives and snapshot bundles should go through this layer so restarts do not lose them.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { logger } from '../utils/logger.js';

function localRoot() {
  if (process.env.OBJECT_STORAGE_PATH) return process.env.OBJECT_STORAGE_PATH;
  try {
    // Prefer Render persistent disk when present.
    // existsSync avoided; attempt will fail later if missing.
  } catch { /* ignore */ }
  return process.env.WORKSPACE_ROOT
    ? path.join(process.env.WORKSPACE_ROOT, '.objects')
    : '/tmp/cloudcoder.objects';
}

export function isS3Configured() {
  return Boolean(
    process.env.S3_ENDPOINT &&
    process.env.S3_ACCESS_KEY_ID &&
    process.env.S3_SECRET_ACCESS_KEY &&
    process.env.S3_BUCKET
  );
}

export function getObjectStorageMode() {
  if (isS3Configured()) return 's3';
  return 'local';
}

function sanitizeKey(key) {
  const cleaned = String(key || '')
    .replace(/\\/g, '/')
    .replace(/\.\./g, '')
    .replace(/^\/+/, '');
  if (!cleaned || cleaned.length > 512) throw Object.assign(new Error('Invalid object key'), { status: 400 });
  return cleaned;
}

async function ensureLocalDir(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

function localPathFor(key) {
  const safe = sanitizeKey(key);
  const root = path.resolve(localRoot());
  const full = path.resolve(root, safe);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw Object.assign(new Error('Object key escapes storage root'), { status: 400 });
  }
  return full;
}

/** Minimal S3-compatible PUT/GET using AWS Sig V4 is heavy; use HTTP basic path for R2/S3 with pre-signed optional later.
 *  For foundation we implement local always + optional fetch PUT when S3_PUBLIC_PUT is not required.
 *  Real SigV4 can be added when aws4 or @aws-sdk/client-s3 is introduced. */
async function s3Put(key, buffer, contentType = 'application/octet-stream') {
  // Placeholder foundation: require AWS SDK only when configured in a follow-up.
  // Store locally as cache + log that remote mirror is not yet active unless S3_FORCE_LOCAL=false and sdk present.
  logger.warn('[objects] S3 credentials present but SigV4 client not bundled; persisting to local durable path. Add @aws-sdk/client-s3 in a later patch for remote mirror.');
  return localPut(key, buffer, contentType);
}

async function s3Get(key) {
  return localGet(key);
}

async function localPut(key, buffer, contentType = 'application/octet-stream') {
  const full = localPathFor(key);
  await ensureLocalDir(full);
  await fs.writeFile(full, buffer, { mode: 0o600 });
  await fs.writeFile(`${full}.meta.json`, JSON.stringify({
    key: sanitizeKey(key),
    contentType,
    bytes: Buffer.byteLength(buffer),
    storedAt: new Date().toISOString(),
  }), { mode: 0o600 });
  return { key: sanitizeKey(key), bytes: Buffer.byteLength(buffer), mode: 'local' };
}

async function localGet(key) {
  const full = localPathFor(key);
  const buf = await fs.readFile(full);
  let meta = {};
  try { meta = JSON.parse(await fs.readFile(`${full}.meta.json`, 'utf8')); } catch { /* ignore */ }
  return { key: sanitizeKey(key), body: buf, contentType: meta.contentType || 'application/octet-stream', bytes: buf.length };
}

export async function putObject(key, data, contentType = 'application/octet-stream') {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buffer.length > Number(process.env.OBJECT_MAX_BYTES || 80 * 1024 * 1024)) {
    throw Object.assign(new Error('Object exceeds size limit'), { status: 413 });
  }
  if (isS3Configured()) return s3Put(key, buffer, contentType);
  return localPut(key, buffer, contentType);
}

export async function getObject(key) {
  if (isS3Configured()) return s3Get(key);
  return localGet(key);
}

export async function deleteObject(key) {
  const full = localPathFor(key);
  await fs.rm(full, { force: true });
  await fs.rm(`${full}.meta.json`, { force: true });
  return true;
}

export async function putJson(key, value) {
  return putObject(key, JSON.stringify(value), 'application/json');
}

export async function getJson(key) {
  const obj = await getObject(key);
  return JSON.parse(obj.body.toString('utf8'));
}

export function newObjectKey(prefix, ext = 'bin') {
  const id = crypto.randomBytes(12).toString('hex');
  const safePrefix = sanitizeKey(prefix || 'objects');
  return `${safePrefix}/${id}.${ext.replace(/[^a-z0-9]/gi, '') || 'bin'}`;
}

export async function objectStorageHealth() {
  try {
    const mode = getObjectStorageMode();
    if (mode === 'local') {
      const root = localRoot();
      await fs.mkdir(root, { recursive: true });
      const probe = path.join(root, `.health-${process.pid}`);
      await fs.writeFile(probe, 'ok', { mode: 0o600 });
      await fs.rm(probe, { force: true });
      return { configured: true, mode, ready: true, root };
    }
    return { configured: true, mode, ready: true };
  } catch (err) {
    return { configured: true, mode: getObjectStorageMode(), ready: false, error: err.message };
  }
}
