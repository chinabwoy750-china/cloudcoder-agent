import { Router } from 'express';
import { createJob, getJob, getJobWithFallback, emit, finish, cancel, subscribe, listJobs, listJobsForOwner } from '../../jobs/registry.js';
import { createWorkspaceSnapshot } from '../../workspace/snapshots.js';
import { runAgentTask } from '../../agent/tasks.js';
import { resolveWorkspace } from '../../workspace/manager.js';
import { config } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { rateLimitMiddleware } from '../../utils/ratelimit.js';
import { resolveUserModelSelection, resolveDefaultModelRef } from '../../config/custom-models.js';

export function agentRouter() {
  const router = Router();

  router.get('/tasks', async (req, res, next) => {
    try {
      if (req.authUserId) {
        const jobs = await listJobsForOwner(req.authUserId, { limit: 50 });
        return res.json(jobs);
      }
      res.json(listJobs());
    } catch (err) { next(err); }
  });

  router.post(
    '/tasks',
    rateLimitMiddleware({ windowMs: 60000, max: 20 }),
    (req, res, next) => {
      const { workspaceId, prompt, model } = req.body || {};
      const mode = req.body?.mode === 'plan' ? 'plan' : 'build';
      if (!workspaceId || !prompt || typeof prompt !== 'string') {
        return res.status(400).json({ error: 'workspaceId and prompt are required' });
      }
      if (prompt.length > 20000) {
        return res.status(413).json({ error: 'Prompt too long (20000 char limit)' });
      }

      resolveWorkspace(workspaceId)
        .then(async (dir) => {
          // Gate BEFORE creating a job so failed readiness never leaves a dead job.
          const { ensureOpenCodeReady } = await import('../../agent/opencode.js');
          await ensureOpenCodeReady(45000);
          const resolvedModel =
            resolveUserModelSelection(model) ||
            resolveDefaultModelRef() ||
            config.agent.defaultModel ||
            undefined;
          let snapshotMeta = null;
          if (mode === 'build') {
            try {
              snapshotMeta = await createWorkspaceSnapshot(workspaceId, `pre-agent ${new Date().toISOString()}`);
            } catch (snapErr) {
              // Non-fatal: continue agent run but report snapshot failure
              snapshotMeta = { error: snapErr.message };
            }
          }
          const job = createJob({ type: 'agent', meta: { workspaceId, source: 'api', model: resolvedModel, mode, ownerUserId: req.authUserId || null, snapshotId: snapshotMeta?.id || null } });
          res.status(202).json({ jobId: job.id, workspaceId, model: resolvedModel || null, mode });

          if (snapshotMeta?.id) {
            emit(job, { type: 'status', message: `Recovery snapshot ${snapshotMeta.id}`, phase: 'snapshot', snapshotId: snapshotMeta.id });
          } else if (snapshotMeta?.error) {
            emit(job, { type: 'status', message: `Snapshot skipped: ${snapshotMeta.error}`, phase: 'snapshot' });
          }
          runAgentTask({
            directory: dir,
            prompt,
            model: resolvedModel,
            mode,
            onEvent: (ev) => emit(job, ev),
            signal: job.controller.signal,
          })
            .then((result) => finish(job, { result }))
            .catch((err) => finish(job, { error: err }));
        })
        .catch((err) => {
          if (err?.code === 'OPENCODE_NOT_READY') {
            return res.status(503).json({ error: err.message, code: err.code });
          }
          next(err);
        });
    }
  );

  router.get('/tasks/:id', async (req, res, next) => {
    try {
      const job = await getJobWithFallback(req.params.id);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      if (req.authUserId && job.meta?.ownerUserId && job.meta.ownerUserId !== req.authUserId && req.authRole !== 'admin') {
        return res.status(404).json({ error: 'Job not found' });
      }
      res.json({
        id: job.id, type: job.type, status: job.status,
        createdAt: job.createdAt, updatedAt: job.updatedAt,
        result: job.result, error: job.error,
        events: (job.events || []).slice(-500),
        durableOnly: Boolean(job.durableOnly),
      });
    } catch (err) { next(err); }
  });

  router.post('/tasks/:id/cancel', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });
    const ok = cancel(job);
    res.json({ cancelled: ok });
  });

  router.get('/tasks/:id/stream', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Replay what has already happened.
    for (const ev of job.events) {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
    if (job.status !== 'running') {
      res.write(`data: ${JSON.stringify({ type: 'done', status: job.status, error: job.error })}\n\n`);
      return res.end();
    }

    const unsubscribe = subscribe(job, (ev) => {
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
      if (ev.type === 'done') { unsubscribe(); res.end(); }
    });

    const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15000);
    req.on('close', () => { clearInterval(keepalive); unsubscribe(); });
  });

  return router;
}
