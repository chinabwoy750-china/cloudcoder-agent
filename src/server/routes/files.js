import { Router } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { config } from '../../config/env.js';
import * as ws from '../../workspace/manager.js';
import * as files from '../../workspace/files.js';
import { createZip, extractZip } from '../../workspace/zip.js';
import { exportWorkspaceArchive } from '../../workspace/archive.js';
import { runProjectAction, allowedActions } from '../../workspace/run.js';
import { detectProjectType } from '../../git/detect.js';
import { rateLimitMiddleware } from '../../utils/ratelimit.js';
import { logger } from '../../utils/logger.js';
import { createWorkspaceSnapshot, listWorkspaceSnapshots, restoreWorkspaceSnapshot } from '../../workspace/snapshots.js';
import { assertWorkspaceOwner } from '../../db/workspaces.js';
import { signPreviewToken, verifyPreviewToken } from '../../auth/preview-token.js';

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


async function requireWorkspaceAccess(req) {
  await assertWorkspaceOwner(req.params.id, req.authUserId || null, {
    allowAdmin: true,
    userRole: req.authRole || 'user',
  });
}

export function filesRouter() {
  const router = Router();

  router.get('/workspaces', asyncH(async (req, res) => {
    const listed = await ws.listWorkspaces(req.user || { id: req.authUserId, role: req.authRole });
    // listed may be string ids (legacy) or objects
    const items = Array.isArray(listed) ? listed : [];
    const stats = await Promise.all(items.map(async (entry) => {
      const id = typeof entry === 'string' ? entry : entry.id;
      const base = await ws.workspaceStats(id).catch(() => ({ id, files: 0, bytes: 0 }));
      const meta = await ws.getWorkspaceMeta(id);
      const name = (typeof entry === 'object' && entry.name) || meta.name || id;
      const createdAt = (typeof entry === 'object' && (entry.createdAt || entry.created_at)) || meta.createdAt || null;
      return { ...base, name, createdAt, legacy: Boolean(entry && entry.legacy) };
    }));
    res.json(stats);
  }));

  router.post('/workspaces', rateLimitMiddleware({ windowMs: 60000, max: 20 }), asyncH(async (req, res) => {
    const name = req.body?.name;
    if (name !== undefined && (typeof name !== 'string' || name.trim().length > 80)) return res.status(400).json({ error: 'Workspace name must be 1–80 characters' });
    const { id, dir, name: workspaceName } = await ws.createWorkspace(undefined, name || 'Untitled workspace', { ownerUserId: req.authUserId || null });
    res.status(201).json({ workspaceId: id, name: workspaceName, dir });
  }));

  router.patch('/workspaces/:id', asyncH(async (req, res) => {
    await requireWorkspaceAccess(req);
    const name = req.body?.name;
    if (!name || typeof name !== 'string' || name.trim().length > 80) return res.status(400).json({ error: 'Workspace name must be 1–80 characters' });
    const result = await ws.renameWorkspace(req.params.id, name, req.user || { id: req.authUserId, role: req.authRole });
    res.json(result);
  }));

  router.get('/workspaces/:id', asyncH(async (req, res) => {
    await requireWorkspaceAccess(req);
    const stats = await ws.workspaceStats(req.params.id);
    const project = await detectProjectType(stats.dir);
    const meta = await ws.getWorkspaceMeta(req.params.id);
    res.json({ ...stats, name: meta.name || req.params.id, createdAt: meta.createdAt || null, project, actions: allowedActions(project.type) });
  }));

  router.delete('/workspaces/:id', asyncH(async (req, res) => {
    if (req.query.confirm !== 'true') {
      return res.status(400).json({ error: 'Deletion requires ?confirm=true' });
    }
    await requireWorkspaceAccess(req);
    await ws.removeWorkspace(req.params.id, req.user || { id: req.authUserId, role: req.authRole });
    res.json({ removed: true });
  }));

  router.get('/workspaces/:id/files', asyncH(async (req, res) => {
    await requireWorkspaceAccess(req);
    const list = await files.listFiles(req.params.id, { subdir: req.query.subdir || '.', max: 2000 });
    res.json(list);
  }));

  router.get('/workspaces/:id/file', asyncH(async (req, res) => {
    await requireWorkspaceAccess(req);
    const rel = req.query.path;
    if (!rel) return res.status(400).json({ error: 'path query param required' });
    const file = await files.readFile(req.params.id, rel);
    res.type('application/octet-stream').send(file.content);
  }));

  router.put('/workspaces/:id/file', asyncH(async (req, res) => {
    await requireWorkspaceAccess(req);
    const { path: rel, content } = req.body || {};
    if (!rel || typeof content !== 'string') return res.status(400).json({ error: 'path and content required' });
    if (Buffer.byteLength(content) > config.limits.maxUploadBytes) {
      return res.status(413).json({ error: 'Content too large' });
    }
    res.json(await files.writeFile(req.params.id, rel, content));
  }));

  router.delete('/workspaces/:id/file', asyncH(async (req, res) => {
    await requireWorkspaceAccess(req);
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
    await requireWorkspaceAccess(req);
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
    await requireWorkspaceAccess(req);
    await requireWorkspaceAccess(req);
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

  
  router.post('/workspaces/:id/archive', rateLimitMiddleware({ windowMs: 60000, max: 5 }), asyncH(async (req, res) => {
    await requireWorkspaceAccess(req);
    const archive = await exportWorkspaceArchive(req.params.id);
    res.json({
      ok: true,
      filename: archive.filename,
      bytes: archive.bytes,
      storageKey: archive.storageKey,
      storageMode: archive.storageMode,
    });
  }));

  router.get('/workspaces/:id/zip', asyncH(async (req, res) => {
    await requireWorkspaceAccess(req);
    const zip = await createZip(req.params.id, { subdir: req.query.subdir || '.' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zip.name}"`);
    res.setHeader('Content-Length', String(zip.size));
    res.sendFile(zip.path, async (err) => {
      await fs.rm(zip.path, { force: true }).catch(() => {});
      if (err && !res.headersSent) res.status(500).end();
    });
  }));


  // Workspace snapshots provide an explicit recovery point before risky AI edits.
  router.get('/workspaces/:id/snapshots', asyncH(async (req, res) => {
    await requireWorkspaceAccess(req);
    res.json({ snapshots: await listWorkspaceSnapshots(req.params.id) });
  }));
  router.post('/workspaces/:id/snapshots', rateLimitMiddleware({ windowMs: 60000, max: 10 }), asyncH(async (req, res) => {
    await requireWorkspaceAccess(req);
    const label = typeof req.body?.label === 'string' ? req.body.label : '';
    const snapshot = await createWorkspaceSnapshot(req.params.id, label);
    res.status(201).json({ ok: true, snapshot });
  }));
  router.post('/workspaces/:id/snapshots/:snapshotId/restore', rateLimitMiddleware({ windowMs: 60000, max: 3 }), asyncH(async (req, res) => {
    await requireWorkspaceAccess(req);
    if (req.body?.confirm !== true) return res.status(400).json({ error: 'Restore is destructive; send confirm=true after reviewing the snapshot.' });
    const result = await restoreWorkspaceSnapshot(req.params.id, req.params.snapshotId);
    res.json({ ok: true, ...result, message: 'Snapshot restored. Rebuild the project to refresh generated output.' });
  }));

  // Serve saved visual overrides from the workspace root, independent of build output directory.
  router.get('/workspaces/:id/visual-overrides.css', asyncH(async (req, res) => {
    await requireWorkspaceAccess(req);
    const dir = await ws.resolveWorkspace(req.params.id);
    const cssPath = path.join(dir, '.universal-modder-visual.css');
    const css = await fs.readFile(cssPath, 'utf8').catch(() => '');
    res.type('text/css').set('Cache-Control', 'no-store').send(css);
  }));

  // Serve the project's real built/static output inside the authenticated preview iframe.
  // Prefer framework build directories; fall back to a root index.html for static projects.
  router.post('/workspaces/:id/preview-token', asyncH(async (req, res) => {
    await requireWorkspaceAccess(req);
    const token = signPreviewToken({ workspaceId: req.params.id, userId: req.authUserId || null });
    res.json({
      token,
      expiresInSec: 1800,
      previewPath: `/api/workspaces/${encodeURIComponent(req.params.id)}/preview/?preview_token=${encodeURIComponent(token)}`,
    });
  }));

  router.get(['/workspaces/:id/preview', '/workspaces/:id/preview/*'], asyncH(async (req, res) => {
    const previewToken = req.query.preview_token || req.get('X-Preview-Token');
    if (previewToken) {
      const claims = verifyPreviewToken(String(previewToken), req.params.id);
      if (!claims) return res.status(401).json({ error: 'Invalid or expired preview token' });
    } else {
      await requireWorkspaceAccess(req);
    }
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
      const visualCss = `<link rel="stylesheet" href="/api/workspaces/${encodeURIComponent(req.params.id)}/visual-overrides.css">`;
      const visualScript = `<script>(()=>{let enabled=false;const pathFor=e=>{const parts=[];let n=e;while(n&&n.nodeType===1&&n!==document.documentElement){let part=n.tagName.toLowerCase();if(n.id){part+='#'+n.id;parts.unshift(part);break;}if(n.classList&&n.classList.length)part+='.'+[...n.classList].slice(0,2).join('.');const p=n.parentElement;if(p){const same=[...p.children].filter(x=>x.tagName===n.tagName);if(same.length>1)part+=':nth-of-type('+(same.indexOf(n)+1)+')';}parts.unshift(part);n=p;}return parts.join(' > ')};document.addEventListener('click',e=>{if(!enabled)return;const el=e.target;if(!(el instanceof Element))return;e.preventDefault();e.stopPropagation();document.querySelectorAll('[data-um-selected]').forEach(x=>{x.style.outline='';x.removeAttribute('data-um-selected')});el.setAttribute('data-um-selected','1');el.style.outline='2px solid #6366f1';parent.postMessage({type:'um-visual-select',selector:pathFor(el),tag:el.tagName.toLowerCase(),text:(el.innerText||'').slice(0,300),color:getComputedStyle(el).color,background:getComputedStyle(el).backgroundColor,fontSize:parseFloat(getComputedStyle(el).fontSize)||16,padding:parseFloat(getComputedStyle(el).paddingTop)||0,radius:parseFloat(getComputedStyle(el).borderRadius)||0},'*');},true);addEventListener('message',e=>{if(e.source!==parent||!e.data||e.data.type!=='um-visual-mode')return;enabled=!!e.data.enabled;document.documentElement.style.cursor=enabled?'crosshair':'';if(!enabled)document.querySelectorAll('[data-um-selected]').forEach(x=>{x.style.outline='';x.removeAttribute('data-um-selected')});});})();<\/script>`;
      if (/<head[^>]*>/i.test(html)) html = html.replace(/<head([^>]*)>/i, `<head$1>${visualCss}${visualScript}`);
      res.type('html').send(html);
      return;
    }
    res.sendFile(target);
  }));

  // Run a named project action (test / build / install).
  router.post('/workspaces/:id/actions/:action', rateLimitMiddleware({ windowMs: 60000, max: 20 }), asyncH(async (req, res) => {
    await requireWorkspaceAccess(req);
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
