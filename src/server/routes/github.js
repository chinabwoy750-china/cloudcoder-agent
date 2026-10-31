import { Router } from 'express';
import simpleGit from 'simple-git';
import { config } from '../../config/env.js';
import * as repos from '../../github/repos.js';
import * as prs from '../../github/pullRequests.js';
import * as ws from '../../workspace/manager.js';
import * as git from '../../git/engine.js';
import { detectProjectType } from '../../git/detect.js';
import { rateLimitMiddleware } from '../../utils/ratelimit.js';

const at = (dir) => simpleGit({ baseDir: dir });

export function githubRouter() {
  const router = Router();

  router.use((req, res, next) => {
    if (!config.github.token) {
      return res.status(503).json({
        error: 'GitHub integration not configured',
        hint: 'Set GITHUB_TOKEN in the environment.',
      });
    }
    next();
  });

  router.get('/me', async (req, res, next) => {
    try { res.json(await repos.getAuthenticatedUser()); } catch (e) { next(e); }
  });

  router.get('/repos', async (req, res, next) => {
    try { res.json(await repos.listRepositories({ perPage: 50 })); } catch (e) { next(e); }
  });

  router.get('/repos/:owner/:repo/branches', async (req, res, next) => {
    try { res.json(await repos.listBranches(req.params.owner, req.params.repo)); } catch (e) { next(e); }
  });

  router.get('/repos/:owner/:repo', async (req, res, next) => {
    try { res.json(await repos.getRepository(req.params.owner, req.params.repo)); } catch (e) { next(e); }
  });

  router.post('/clone', rateLimitMiddleware({ windowMs: 60000, max: 10 }), async (req, res, next) => {
    let workspaceId = null;
    try {
      const { owner, repo, branch, workspaceName } = req.body || {};
      if (!owner || !repo) return res.status(400).json({ error: 'owner and repo required' });
      if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
        return res.status(400).json({ error: 'Invalid owner or repo name' });
      }
      const created = await ws.createWorkspace(undefined, workspaceName || repo);
      workspaceId = created.id;
      const dir = created.dir;
      const meta = await repos.getRepository(owner, repo);
      const cloned = await git.cloneRepo({
        owner, repo, dir,
        branch: branch || meta.defaultBranch,
        token: config.github.token,
      });
      if (!(await git.isGitRepo(dir))) {
        throw Object.assign(new Error('Clone did not produce a valid git repository'), { code: 'GIT_CLONE_INVALID' });
      }
      const project = await detectProjectType(dir);
      res.json({
        workspaceId: created.id, workspaceName: created.name, owner, repo,
        branch: cloned.branch, defaultBranch: meta.defaultBranch, project,
      });
    } catch (e) {
      if (workspaceId) {
        await ws.removeWorkspace(workspaceId).catch(() => {});
      }
      next(e);
    }
  });

  router.post('/:workspaceId/branch', async (req, res, next) => {
    try {
      const dir = await ws.resolveWorkspace(req.params.workspaceId);
      const { name } = req.body || {};
      if (!name) return res.status(400).json({ error: 'name required' });
      await git.createBranch(at(dir), name);
      res.json({ workspaceId: req.params.workspaceId, branch: name });
    } catch (e) { next(e); }
  });

  router.get('/:workspaceId/status', async (req, res, next) => {
    try {
      const dir = await ws.resolveWorkspace(req.params.workspaceId);
      const g = at(dir);
      const [st, branch] = await Promise.all([git.status(g), git.currentBranch(g)]);
      res.json({ workspaceId: req.params.workspaceId, branch, status: st });
    } catch (e) { next(e); }
  });

  router.get('/:workspaceId/diff', async (req, res, next) => {
    try {
      const dir = await ws.resolveWorkspace(req.params.workspaceId);
      const d = await git.diff(at(dir));
      res.type('text/plain').send(d);
    } catch (e) { next(e); }
  });

  router.post('/:workspaceId/commit', async (req, res, next) => {
    try {
      const dir = await ws.resolveWorkspace(req.params.workspaceId);
      const g = at(dir);
      await git.addAll(g);
      const result = await git.commit(g, (req.body || {}).message);
      res.json({ workspaceId: req.params.workspaceId, commit: result.commit });
    } catch (e) { next(e); }
  });

  router.post('/:workspaceId/push', async (req, res, next) => {
    try {
      const dir = await ws.resolveWorkspace(req.params.workspaceId);
      const { owner, repo, branch, confirm } = req.body || {};
      if (confirm !== true) {
        return res.status(400).json({
          error: 'Push requires explicit confirmation. Send { confirm: true } with owner, repo, branch.',
          code: 'CONFIRM_REQUIRED',
        });
      }
      if (!owner || !repo || !branch) return res.status(400).json({ error: 'owner, repo, branch required' });
      const meta = await repos.getRepository(owner, repo);
      git.assertBranchSafety(branch, meta.defaultBranch);
      await git.push(at(dir), { owner, repo, branch, token: config.github.token });
      res.json({ workspaceId: req.params.workspaceId, pushed: true, branch });
    } catch (e) {
      if (e.code === 'DEFAULT_BRANCH_PROTECTED') return res.status(409).json({ error: e.message, code: e.code });
      next(e);
    }
  });

  router.post('/:workspaceId/pr', async (req, res, next) => {
    try {
      const { owner, repo, head, title } = req.body || {};
      if (!owner || !repo || !head || !title) return res.status(400).json({ error: 'owner, repo, head, title required' });
      const meta = await repos.getRepository(owner, repo);
      const base = req.body.base || meta.defaultBranch;
      res.json(await prs.createPullRequest({ owner, repo, head, base, title, body: req.body.body, draft: !!req.body.draft }));
    } catch (e) { next(e); }
  });

  return router;
}
