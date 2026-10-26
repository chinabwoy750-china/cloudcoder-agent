import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import archiver from 'archiver';
import yauzl from 'yauzl';
import { config } from '../config/env.js';
import { resolveWorkspace, resolveInside } from './manager.js';
import { logger } from '../utils/logger.js';

const isSymlink = (entry) => {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (mode & 0xf000) === 0xa000;
};

/**
 * Safely extract a zip into destDir.
 * Defends against Zip Slip (CWE-22) and zip bombs:
 *  - every entry path is resolved and must stay inside destDir
 *  - absolute paths and backslash traversal are rejected
 *  - symlink entries are rejected
 *  - entry count and total uncompressed size are capped
 */
export function extractZip(zipPath, destDir, {
  maxEntries = config.limits.maxZipEntries,
  maxBytes = config.limits.maxExtractBytes,
} = {}) {
  const destResolved = path.resolve(destDir);
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };

    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zipfile) => {
      if (err) return fail(err);

      let entries = 0;
      let totalBytes = 0;

      zipfile.on('error', fail);
      zipfile.on('end', () => { if (!settled) { settled = true; resolve({ entries, bytes: totalBytes }); } });

      zipfile.on('entry', async (entry) => {
        if (settled) return;
        entries += 1;
        if (entries > maxEntries) return fail(new Error(`Zip has more than ${maxEntries} entries`));

        const rawName = String(entry.fileName || '');
        const normalized = rawName.replace(/\\/g, '/');

        if (!normalized || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
          return fail(new Error(`Rejected absolute path in zip: ${rawName}`));
        }
        if (normalized.split('/').includes('..')) {
          return fail(new Error(`Rejected path traversal in zip: ${rawName}`));
        }
        if (isSymlink(entry)) {
          return fail(new Error(`Rejected symlink entry in zip: ${rawName}`));
        }

        const target = path.resolve(destResolved, normalized);
        if (target !== destResolved && !target.startsWith(destResolved + path.sep)) {
          return fail(new Error(`Rejected path traversal in zip: ${rawName}`));
        }

        const isDir = normalized.endsWith('/') || (entry.externalFileAttributes & 0x10) !== 0;

        try {
          if (isDir) {
            await fsp.mkdir(target, { recursive: true });
            zipfile.readEntry();
            return;
          }

          totalBytes += entry.uncompressedSize;
          if (totalBytes > maxBytes) {
            return fail(new Error(`Zip expands beyond ${maxBytes} bytes`));
          }

          await fsp.mkdir(path.dirname(target), { recursive: true });
          await new Promise((res, rej) => {
            zipfile.openReadStream(entry, (streamErr, readStream) => {
              if (streamErr) return rej(streamErr);
              const writeStream = fs.createWriteStream(target, { mode: 0o644, flags: 'wx' });
              readStream.on('error', rej);
              writeStream.on('error', rej);
              writeStream.on('close', res);
              readStream.pipe(writeStream);
            });
          });
          zipfile.readEntry();
        } catch (e) {
          fail(e);
        }
      });

      zipfile.readEntry();
    });
  });
}

/**
 * Create a zip of a workspace subdirectory. Returns the archive path.
 */
export async function createZip(workspaceId, { subdir = '.', outName } = {}) {
  const root = await resolveWorkspace(workspaceId);
  const source = resolveInside(root, subdir);
  const name = outName || `workspace-${workspaceId}-${Date.now()}.zip`;
  const outPath = path.join(root, '.cloudcoder', path.basename(name));
  await fsp.mkdir(path.dirname(outPath), { recursive: true });

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', (w) => logger.warn(`Archive warning: ${w.message}`));
    archive.pipe(output);
    archive.glob('**/*', {
      cwd: source,
      dot: false,
      ignore: [
        '**/.git/**', '**/node_modules/**', '**/.cloudcoder/**',
        '**/*.zip', '**/.env', '**/.env.*',
      ],
    });
    archive.finalize();
  });

  const st = await fsp.stat(outPath);
  logger.info(`Created zip ${outPath} (${st.size} bytes)`);
  return { path: outPath, name: path.basename(outPath), size: st.size };
}
