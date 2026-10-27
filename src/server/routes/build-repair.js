import { Router } from 'express';
import { resolveWorkspace } from '../../workspace/manager.js';
import { detectProjectType } from '../../git/detect.js';
import { runProjectAction } from '../../workspace/run.js';
import { runAgentTask } from '../../agent/tasks.js';
import { ensureOpenCodeReady } from '../../agent/opencode.js';
import { resolveUserModelSelection, resolveDefaultModelRef } from '../../config/custom-models.js';
import { getRuntimeSettings } from '../../config/runtime-settings.js';
import { config } from '../../config/env.js';
import { rateLimitMiddleware } from '../../utils/ratelimit.js';

const MAX_REPAIR_ATTEMPTS = 1;
const clip = (value, max = 6000) => String(value || '').slice(0, max);

export function buildRepairRouter() {
  const router = Router();
  router.post('/:id/build-repair', rateLimitMiddleware({ windowMs: 60000, max: 4 }), async (req, res, next) => {
    try {
      const dir = await resolveWorkspace(req.params.id);
      const project = await detectProjectType(dir);
      await ensureOpenCodeReady(45000);
      const routing = getRuntimeSettings().modelRouting || {};
      const model = resolveUserModelSelection(routing.build) || resolveDefaultModelRef() || config.agent.defaultModel || undefined;
      const attempts = [];
      let result = await runProjectAction({ dir, action: 'build', projectType: project.type });
      attempts.push({ attempt: 1, result });
      for (let repair = 0; !result.ok && result.supported && repair < MAX_REPAIR_ATTEMPTS; repair += 1) {
        const failureText = (result.results || []).map((r) => `Command: ${r.cmd} ${(r.args || []).join(' ')}\nExit: ${r.code}\nSTDOUT:\n${clip(r.stdout, 3000)}\nSTDERR:\n${clip(r.stderr, 3000)}`).join('\n\n');
        const prompt = [
          'BUILD REPAIR MODE: Repair the existing project in place; do not replace unrelated files or remove existing features.',
          'Read the build error carefully, make the smallest necessary source/configuration change, then summarize the fix.',
          'Do not claim success unless the reported error is addressed. Do not change credentials or deployment settings.',
          `Project type: ${project.type}`,
          `Build failure details:\n${failureText}`,
        ].join('\n\n');
        await runAgentTask({ directory: dir, prompt, model, onEvent: () => {}, signal: undefined });
        result = await runProjectAction({ dir, action: 'build', projectType: project.type });
        attempts.push({ attempt: repair + 2, result });
      }
      const final = attempts[attempts.length - 1].result;
      res.json({ ok: Boolean(final.ok), workspaceId: req.params.id, projectType: project.type, repairAttempts: attempts.length - 1, attempts, previewPath: final.ok ? `/api/workspaces/${encodeURIComponent(req.params.id)}/preview/` : null, message: final.ok ? 'Build passed. Open preview to inspect the generated app.' : (final.supported ? 'Build still fails after the bounded repair attempt. Review the logs and try another repair.' : final.reason || 'Build is not supported for this project type.') });
    } catch (err) {
      next(err);
    }
  });
  return router;
}
