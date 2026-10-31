import { oc, splitModel } from './client.js';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/async.js';
import { ensureOpenCodeReady } from './opencode.js';
import { snapshotWorkspaceFingerprint, verifyAgentOutcome } from './verify.js';

const MAX_REPAIR_ROUNDS = Number(process.env.AGENT_MAX_REPAIR_ROUNDS || 1);

/**
 * Create an OpenCode session rooted at `directory` and stream the agent's work.
 * Emits events via onEvent({type, ...}). Resolves with {sessionId, verification}.
 */
export function buildTaskPrompt(prompt, mode = 'build', planOn = true) {
  const safeMode = mode === 'plan' ? 'plan' : 'build';
  const modeInstruction = safeMode === 'plan'
    ? [
        'PLAN MODE: Analyze the workspace and the user request.',
        'Do not create, edit, delete, or overwrite files.',
        'Do not run commands that modify the workspace.',
        'Return a structured plan with:',
        '1) Goal summary',
        '2) Numbered task list (3–10 concrete steps)',
        '3) Relevant files/paths',
        '4) Risks and edge cases',
        '5) Verification steps (build/test/manual checks)',
        'If the request asks for code changes, describe them but do not apply them.',
        '',
      ].join('\n')
    : [
        'BUILD MODE: Implement the user request in the workspace.',
        'Inspect existing code first, make focused changes, run appropriate tests or builds when available,',
        'and report exactly what changed and what verification passed or failed.',
        'Do not claim success without evidence of file changes or passing checks.',
        '',
      ].join('\n');
  const planPrefix = planOn
    ? 'Before making changes, briefly outline a short plan (3–6 bullets), then execute it in the workspace, then summarize what you did and what remains.\n\n'
    : '';
  return modeInstruction + (safeMode === 'plan' ? '' : planPrefix) + 'User request:\n' + prompt;
}

export function buildRepairPrompt(verification) {
  const lines = [
    'BUILD REPAIR MODE: The previous implementation attempt did not fully succeed.',
    'Do not rewrite unrelated files. Fix the failures below with the smallest safe change set.',
    `Files touched: ${verification?.diff?.totalTouched ?? 0}`,
  ];
  if (verification?.diff?.changed?.length) lines.push(`Changed: ${verification.diff.changed.slice(0, 20).join(', ')}`);
  if (verification?.diff?.added?.length) lines.push(`Added: ${verification.diff.added.slice(0, 20).join(', ')}`);
  for (const a of verification?.actions || []) {
    lines.push(`Action ${a.action}: ok=${a.ok}`);
    for (const r of a.results || []) {
      lines.push(`  $ ${r.cmd} → code ${r.code}`);
      if (r.stderr) lines.push(`  stderr: ${r.stderr.slice(0, 1200)}`);
    }
    if (a.error) lines.push(`  error: ${a.error}`);
  }
  if (verification?.successCriteria?.reason) lines.push(`Reason: ${verification.successCriteria.reason}`);
  lines.push('After fixing, ensure the project builds/tests if possible.');
  return lines.join('\n');
}

async function promptSession({ sessionId, directory, text, model }) {
  const body = { parts: [{ type: 'text', text }] };
  const m = splitModel(model || config.agent.defaultModel);
  if (m) body.model = m;
  await oc('POST', `/session/${sessionId}/prompt_async`, {
    query: { directory },
    body,
    timeoutMs: 20000,
  });
}

async function waitForSessionIdle({ sessionId, directory, signal, onEvent, seen, deadline }) {
  let assistantSeen = false;
  let idleStreak = 0;
  while (true) {
    if (signal?.aborted) {
      await abortSession(sessionId, directory);
      throw Object.assign(new Error('Task cancelled'), { code: 'CANCELLED' });
    }
    if (Date.now() > deadline) {
      await abortSession(sessionId, directory);
      throw Object.assign(new Error('Task timed out'), { code: 'TIMEOUT' });
    }

    let messages = [];
    try {
      messages = await oc('GET', `/session/${sessionId}/message`, {
        query: { directory }, timeoutMs: 15000,
      });
    } catch (err) {
      logger.warn(`Polling session ${sessionId} failed: ${err.message}`);
    }

    for (const msg of Array.isArray(messages) ? messages : []) {
      const info = msg.info || msg;
      const role = info.role || msg.role || 'assistant';
      for (const part of msg.parts || []) {
        const key = `${info.id || msg.id || ''}:${part.id ?? part.type}:${String(part.text || part.tool || '').slice(0, 40)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (role === 'user' || role === 'system') continue;
        if (role === 'assistant') assistantSeen = true;
        onEvent({ type: 'part', role, part });
      }
    }

    let statusMap = {};
    try {
      statusMap = await oc('GET', '/session/status', {
        query: { directory }, timeoutMs: 10000,
      });
    } catch { /* ignore */ }

    const status = statusMap?.[sessionId];
    const type = typeof status === 'string' ? status : status?.type;
    const busy = type === 'busy' || type === 'running';

    if (!busy && assistantSeen) {
      idleStreak += 1;
      if (idleStreak >= 2) break;
    } else {
      idleStreak = 0;
    }

    await sleep(config.agent.pollIntervalMs);
  }
}

export async function runAgentTask({
  directory,
  prompt,
  model,
  mode = 'build',
  onEvent = () => {},
  signal,
  verify = true,
}) {
  await ensureOpenCodeReady(45000);
  const session = await oc('POST', '/session', {
    query: { directory },
    body: { title: prompt.slice(0, 80) },
    timeoutMs: 20000,
  });
  const sessionId = session.id;
  onEvent({ type: 'session', sessionId, directory });
  onEvent({ type: 'status', message: 'Agent session started', phase: 'start' });

  const planOn = String(process.env.PLAN_THEN_ACT || 'true').toLowerCase() !== 'false';
  const safeMode = mode === 'plan' ? 'plan' : 'build';
  const finalPrompt = buildTaskPrompt(prompt, safeMode, planOn);

  const m = splitModel(model || config.agent.defaultModel);
  logger.info(`Agent task mode=${safeMode} model=${m ? m.providerID + '/' + m.modelID : '(opencode-default)'} planThenAct=${planOn}`);

  onEvent({
    type: 'task_list',
    mode: safeMode,
    items: safeMode === 'plan'
      ? ['Inspect workspace', 'Draft implementation plan', 'List risks and verification']
      : ['Inspect workspace', 'Apply focused changes', 'Verify build/test', 'Summarize outcome'],
  });

  const before = await snapshotWorkspaceFingerprint(directory);
  onEvent({ type: 'status', message: 'Workspace fingerprint captured', phase: 'inspect', fileCount: before.length });

  const seen = new Set();
  const deadline = Date.now() + config.agent.taskTimeoutMs;

  await promptSession({ sessionId, directory, text: finalPrompt, model });
  onEvent({ type: 'status', message: safeMode === 'plan' ? 'Planning…' : 'Implementing…', phase: safeMode });
  await waitForSessionIdle({ sessionId, directory, signal, onEvent, seen, deadline });

  let verification = await verifyAgentOutcome(directory, before, {
    runVerify: Boolean(verify) && safeMode === 'build',
    mode: safeMode,
  });
  onEvent({ type: 'verification', verification });

  // Bounded auto-repair when build verification fails and files may be partial.
  if (
    safeMode === 'build' &&
    verify &&
    verification?.successCriteria &&
    verification.successCriteria.ok === false &&
    MAX_REPAIR_ROUNDS > 0
  ) {
    for (let round = 1; round <= MAX_REPAIR_ROUNDS; round += 1) {
      if (signal?.aborted) break;
      onEvent({ type: 'status', message: `Repair round ${round}/${MAX_REPAIR_ROUNDS}`, phase: 'repair' });
      const repairPrompt = buildRepairPrompt(verification);
      const beforeRepair = await snapshotWorkspaceFingerprint(directory);
      await promptSession({ sessionId, directory, text: repairPrompt, model });
      await waitForSessionIdle({ sessionId, directory, signal, onEvent, seen, deadline });
      verification = await verifyAgentOutcome(directory, beforeRepair, {
        runVerify: true,
        mode: 'build',
      });
      onEvent({ type: 'verification', verification, repairRound: round });
      if (verification.successCriteria?.ok) break;
    }
  }

  onEvent({
    type: 'status',
    message: verification.successCriteria?.ok ? 'Agent task verified' : 'Agent task finished with verification warnings',
    phase: 'done',
  });

  return { sessionId, verification, mode: safeMode };
}

export async function abortSession(sessionId, directory) {
  try {
    await oc('POST', `/session/${sessionId}/abort`, { query: { directory }, timeoutMs: 10000 });
  } catch (err) {
    logger.warn(`Abort ${sessionId} failed: ${err.message}`);
  }
}
