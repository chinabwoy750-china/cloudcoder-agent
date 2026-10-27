import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

function asyncH(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function filesRouter() {
  const router = Router();

  router.get('/workspaces', asyncH(async (req, res) => {
    const ids = await ws.listWorkspaces();
    const stats = await Promise.all(ids.map(async (id) => {
      const base = await ws.workspaceStats(id).catch(() => ({ id, files: 0, bytes: 0 }));
      const meta = await ws.getWorkspaceMeta(id);
      return { ...base, name: meta.name || id, createdAt: meta.createdAt || null };
    }));
    res.json(stats);
  }));

  router.post('/workspaces', rateLimitMiddleware({ windowMs: 60000, max: 20 }), asyncH(async (req, res) => {
    const name = req.body?.name;
    if (name !== undefined && (typeof name !== 'string' || name.trim().length > 80)) return res.status(400).json({ error: 'Workspace name must be 1–80 characters' });
    const { id, dir, name: workspaceName } = await ws.createWorkspace(undefined, name || 'Untitled workspace');
    res.status(201).json({ workspaceId: id, name: workspaceName, dir });
  }));

  router.get('/workspaces/:id', asyncH(async (req, res) => {
    const stats = await ws.workspaceStats(req.params.id);
    const project = await detectProjectType(stats.dir);
    const meta = await ws.getWorkspaceMeta(req.params.id);
    res.json({ ...stats, name: meta.name || req.params.id, createdAt: meta.createdAt || null, project, actions: allowedActions(project.type) });
  }));

  router.delete('/workspaces/:id', asyncH(async (req, res) => {
    if (req.query.confirm !== 'true') {
      return res.status(400).json({ error: 'Deletion requires ?confirm=true' });
    }
    await ws.removeWorkspace(req.params.id);
    res.json({ removed: true });
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


  // Serve the project's real built/static output inside the authenticated preview iframe.
  // Prefer framework build directories; fall back to a root index.html for static projects.
  router.get(['/workspaces/:id/preview', '/workspaces/:id/preview/*'], asyncH(async (req, res) => {
    const dir = await ws.resolveWorkspace(req.params.id);
    const candidates = [path.join(dir, 'dist'), path.join(dir, 'build'), path.join(dir, 'out'), dir];
    let root = dir;
    for (const candidate of candidates) {
      try { const st = await fs.stat(path.join(candidate, 'index.html')); if (st.isFile()) { root = candidate; break; } } catch {}
    }
    const requested = String(req.params[0] || '').replace(/\\/g, '/');
    if (requested.split('/').some((part) => part === '..' || part.startsWith('.'))) {
      return res.status(400).json({ error: 'Invalid preview path' });
    }
    let target = path.resolve(root, requested || 'index.html');
    const rootReal = await fs.realpath(root);
    try {
      let real = await fs.realpath(target);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) return res.status(403).json({ error: 'Preview path escapes project' });
      const st = await fs.stat(real);
      if (!st.isFile()) throw new Error('Not a file');
      target = real;
    } catch {
      if (requested && !requested.endsWith('/')) return res.status(404).json({ error: `Preview asset not found: ${requested}` });
      target = path.join(root, 'index.html');
      if (!(await fs.stat(target).catch(() => null))?.isFile()) return res.status(404).json({ error: 'No index.html found. Build the project first or add an index.html file.' });
    }
    if (path.basename(target).toLowerCase() === 'index.html') {
      let html = await fs.readFile(target, 'utf8');
      const prefix = `/api/workspaces/${encodeURIComponent(req.params.id)}/preview/`;
      if (!/<base\s/i.test(html)) html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${prefix}">`);
      html = html.replace(/(src|href|action)=(['"])\/(?!\/)/gi, `$1=$2${prefix}`);
      res.type('html').send(html);
      return;
    }
    res.sendFile(target);
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
