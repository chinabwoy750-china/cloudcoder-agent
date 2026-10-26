import { oc, splitModel } from './client.js';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/async.js';
import { ensureOpenCodeReady } from './opencode.js';

/**
 * Create an OpenCode session rooted at `directory` and stream the agent's work.
 * Emits events via onEvent({type, ...}). Resolves with {sessionId}.
 */
export async function runAgentTask({ directory, prompt, model, onEvent = () => {}, signal }) {
  // Never hit OpenCode while it is still booting.
  await ensureOpenCodeReady(45000);
  const session = await oc('POST', '/session', {
    query: { directory },
    body: { title: prompt.slice(0, 80) },
    timeoutMs: 20000,
  });
  const sessionId = session.id;
  onEvent({ type: 'session', sessionId, directory });

  // Optional plan-then-act prefix (still a single OpenCode prompt — not a second engine).
  const planOn = String(process.env.PLAN_THEN_ACT || 'true').toLowerCase() !== 'false';
  const planPrefix = planOn
    ? (
      'Before making changes, briefly outline a short plan (3–6 bullets), ' +
      'then execute it in the workspace, then summarize what you did and what remains.\n\n' +
      'User request:\n'
    )
    : '';
  const finalPrompt = planPrefix + prompt;

  const body = { parts: [{ type: 'text', text: finalPrompt }] };
  const m = splitModel(model || config.agent.defaultModel);
  if (m) body.model = m;
  logger.info(`Agent task model=${m ? m.providerID + '/' + m.modelID : '(opencode-default)'} planThenAct=${planOn}`);

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
