import { oc, splitModel } from './client.js';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/async.js';
import { ensureOpenCodeReady } from './opencode.js';

/**
 * Create an OpenCode session rooted at `directory` and stream the agent's work.
 * Emits events via onEvent({type, ...}). Resolves with {sessionId}.
 */
export function buildTaskPrompt(prompt, mode = 'build', planOn = true) {
  const safeMode = mode === 'plan' ? 'plan' : 'build';
  const modeInstruction = safeMode === 'plan'
    ? 'PLAN MODE: Analyze the workspace and the user request. Do not create, edit, delete, or overwrite files. Do not run commands that modify the workspace. Return a concise implementation plan, relevant files, risks, and verification steps. If the request asks for code changes, describe the changes you would make but do not apply them.\n\n'
    : 'BUILD MODE: Implement the user request in the workspace. Inspect existing code first, make focused changes, run appropriate tests or builds when available, and report exactly what changed and what verification passed or failed.\n\n';
  const planPrefix = planOn
    ? 'Before making changes, briefly outline a short plan (3–6 bullets), then execute it in the workspace, then summarize what you did and what remains.\n\n'
    : '';
  return modeInstruction + (safeMode === 'plan' ? '' : planPrefix) + 'User request:\n' + prompt;
}

export async function runAgentTask({ directory, prompt, model, mode = 'build', onEvent = () => {}, signal }) {
  // Never hit OpenCode while it is still booting.
  await ensureOpenCodeReady(45000);
  const session = await oc('POST', '/session', {
    query: { directory },
    body: { title: prompt.slice(0, 80) },
    timeoutMs: 20000,
  });
  const sessionId = session.id;
  onEvent({ type: 'session', sessionId, directory });

  // Build/Plan mode is supplied by the UI. Plan mode asks for analysis only;
  // build mode retains the optional plan-then-act prefix. This is a model
  // instruction, not a hard security boundary for tools that can write files.
  const planOn = String(process.env.PLAN_THEN_ACT || 'true').toLowerCase() !== 'false';
  const safeMode = mode === 'plan' ? 'plan' : 'build';
  const finalPrompt = buildTaskPrompt(prompt, safeMode, planOn);

  const body = { parts: [{ type: 'text', text: finalPrompt }] };
  const m = splitModel(model || config.agent.defaultModel);
  if (m) body.model = m;
  logger.info(`Agent task mode=${safeMode} model=${m ? m.providerID + '/' + m.modelID : '(opencode-default)'} planThenAct=${planOn}`);

  await oc('POST', `/session/${sessionId}/prompt_async`, {
    query: { directory },
    body,
    timeoutMs: 20000,
  });

  const seen = new Set();
  let assistantSeen = false;
  let idleStreak = 0;
  const deadline = Date.now() + config.agent.taskTimeoutMs;

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
        // Never forward the user's own prompt back to UI/Telegram as an "AI" message.
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

  return { sessionId };
}

export async function abortSession(sessionId, directory) {
  try {
    await oc('POST', `/session/${sessionId}/abort`, { query: { directory }, timeoutMs: 10000 });
  } catch (err) {
    logger.warn(`Abort ${sessionId} failed: ${err.message}`);
  }
}
