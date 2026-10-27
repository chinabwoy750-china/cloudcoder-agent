import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { config } from '../../config/env.js';
import * as ws from '../../workspace/manager.js';
import * as files from '../../workspace/files.js';
import { createZip, extractZip } from '../../workspace/zip.js';
import { runProjectAction, allowedActions } from '../../workspace/run.js';
import { detectProjectType } from '../../git/detect.js';
import { rateLimitMiddleware } from '../../utils/ratelimit.js';
import { logger } from '../../utils/logger.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.limits.maxUploadBytes,
    files: 20,
    fields: 10,
    fieldNameSize: 200,
    fieldSize: 1024 * 1024,
  },
});


const PREVIEW_DENY = /(^|\/)(?:\.git|node_modules|\.cloudcoder|\.ssh|\.aws|\.config)(?:\/|$)|(^|\/)\.env(?:\.|$)|(^|\/)(?:id_rsa|id_ed25519|\.npmrc|\.netrc)$/i;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

async function sendWorkspacePreview(req, res) {
  const root = await ws.resolveWorkspace(req.params.id);
  let rel = String(req.params[0] || '').replace(/\\/g, '/');
  try { rel = decodeURIComponent(rel); } catch { return res.status(400).send('Invalid preview path'); }
  rel = rel.replace(/^\/+/, '');
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  if (rel.split('/').some((part) => part === '..') || PREVIEW_DENY.test(rel)) {
    return res.status(403).send('Preview path not allowed');
  }
  const candidate = path.resolve(root, rel);
  const rootReal = await fs.realpath(root);
  const full = await fs.realpath(candidate).catch(() => null);
  if (!full || (full !== rootReal && !full.startsWith(rootReal + path.sep))) {
    return res.status(404).send('Preview file not found');
  }
  const stat = await fs.stat(full);
  if (!stat.isFile()) return res.status(404).send('Preview file not found');
  if (stat.size > config.limits.maxDownloadBytes) return res.status(413).send('Preview file too large');
  const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
  res.setHeader('Content-Type', type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  // Preview runs in a sandboxed iframe in the UI; do not allow framing elsewhere.
  res.setHeader('Content-Security-Policy', "default-src 'self' data: blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; connect-src 'self'; frame-ancestors 'self'");
  res.sendFile(full);
}

function asyncH(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function filesRouter() {
  const router = Router();

  router.get('/workspaces', asyncH(async (req, res) => {
    const ids = await ws.listWorkspaces();
    const stats = await Promise.all(ids.map((id) => ws.workspaceStats(id).catch(() => ({ id, files: 0, bytes: 0 }))));
    res.json(stats);
  }));

  router.post('/workspaces', rateLimitMiddleware({ windowMs: 60000, max: 20 }), asyncH(async (req, res) => {
    const { id, dir } = await ws.createWorkspace();
    res.status(201).json({ workspaceId: id, dir });
  }));

  router.get('/workspaces/:id', asyncH(async (req, res) => {
    const stats = await ws.workspaceStats(req.params.id);
    const project = await detectProjectType(stats.dir);
    res.json({ ...stats, project, actions: allowedActions(project.type) });
  }));

  router.delete('/workspaces/:id', asyncH(async (req, res) => {
    if (req.query.confirm !== 'true') {
      return res.status(400).json({ error: 'Deletion requires ?confirm=true' });
    }
    await ws.removeWorkspace(req.params.id);
    res.json({ removed: true });
  }));

  // Static project preview only. This does not execute package scripts or launch untrusted servers.
  router.get('/workspaces/:id/preview', asyncH(async (req, res) => {
    req.params[0] = '';
    await sendWorkspacePreview(req, res);
  }));
  router.get('/workspaces/:id/preview/*', asyncH(async (req, res) => {
    await sendWorkspacePreview(req, res);
  }));

  router.get('/workspaces/:id/files', asyncH(async (req, res) => {
    const list = await files.listFiles(req.params.id, { subdir: req.query.subdir || '.', max: 2000 });
    res.json(list);
  }));

  router.get('/workspaces/:id/file', asyncH(async (req, res) => {
    const rel = req.query.path;
    if (!rel) return res.status(400).json({ error: 'path query param required' });
    const file = await files.readFile(req.params.id, rel);
    res.type('application/octet-stream').send(file.content);
  }));

  router.put('/workspaces/:id/file', asyncH(async (req, res) => {
    const { path: rel, content } = req.body || {};
    if (!rel || typeof content !== 'string') return res.status(400).json({ error: 'path and content required' });
    if (Buffer.byteLength(content) > config.limits.maxUploadBytes) {
      return res.status(413).json({ error: 'Content too large' });
    }
    res.json(await files.writeFile(req.params.id, rel, content));
  }));

  router.delete('/workspaces/:id/file', asyncH(async (req, res) => {
    const rel = req.query.path;
    const confirmed = req.query.confirm === 'true';
    res.json(await files.deleteFile(req.params.id, rel, { confirmed }));
  }));

  // Upload loose files (multipart) into the workspace root.
  router.post(
    '/workspaces/:id/upload',
    rateLimitMiddleware({ windowMs: 60000, max: 20 }),
    upload.array('files', 20),
    asyncH(async (req, res) => {
      const saved = [];
      for (const f of req.files || []) {
        saved.push(await files.saveUpload(req.params.id, f.originalname, f.buffer));
      }
      res.json({ uploaded: saved });
    })
  );

  // Upload and extract a ZIP.
  router.post(
    '/workspaces/:id/upload-zip',
    rateLimitMiddleware({ windowMs: 60000, max: 10 }),
    upload.single('archive'),
    asyncH(async (req, res) => {
      if (!req.file) return res.status(400).json({ error: 'archive field required' });
      const dir = await ws.resolveWorkspace(req.params.id);
      const tmpPath = `${dir}/.cloudcoder-upload-${Date.now()}.zip`;
      await fs.mkdir(`${dir}/.cloudcoder`, { recursive: true });
      const staged = `${dir}/.cloudcoder/${Date.now()}.zip`;
      await fs.writeFile(staged, req.file.buffer);
      try {
        const result = await extractZip(staged, dir);
        logger.info(`Extracted ${result.entries} entries into ${req.params.id}`);
        res.json({ workspaceId: req.params.id, extracted: result });
      } finally {
        await fs.rm(staged, { force: true }).catch(() => {});
        await fs.rm(tmpPath, { force: true }).catch(() => {});
      }
    })
  );

  router.get('/workspaces/:id/zip', asyncH(async (req, res) => {
    const zip = await createZip(req.params.id, { subdir: req.query.subdir || '.' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zip.name}"`);
    res.setHeader('Content-Length', String(zip.size));
    res.sendFile(zip.path, async (err) => {
      await fs.rm(zip.path, { force: true }).catch(() => {});
      if (err && !res.headersSent) res.status(500).end();
    });
  }));

  // Run a named project action (test / build / install).
  router.post('/workspaces/:id/actions/:action', rateLimitMiddleware({ windowMs: 60000, max: 20 }), asyncH(async (req, res) => {
    const action = req.params.action;
    if (!['test', 'build', 'install'].includes(action)) {
      return res.status(400).json({ error: 'action must be test, build, or install' });
    }
    const dir = await ws.resolveWorkspace(req.params.id);
    const project = await detectProjectType(dir);
    const result = await runProjectAction({ dir, action, projectType: project.type });
    res.json(result);
  }));

  return router;
}
