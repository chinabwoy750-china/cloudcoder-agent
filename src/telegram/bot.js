import fs from 'node:fs/promises';
import { config } from '../config/env.js';
import { isOpenCodeReady, waitForOpenCode } from '../agent/opencode.js';
import { fetchCustomModels, getCachedModels, resolveUserModelSelection, resolveDefaultModelRef } from '../config/custom-models.js';
import { logger } from '../utils/logger.js';
import { tgCall, sendMessage, sendChatAction, sendDocument, getUpdates, setMyCommands, getMe } from './api.js';
import { listRepositories } from '../github/repos.js';
import { cloneRepo, currentBranch, status as gitStatus, diff as gitDiff } from '../git/engine.js';
import { detectProjectType } from '../git/detect.js';
import * as ws from '../workspace/manager.js';
import { createZip } from '../workspace/zip.js';
import { runProjectAction } from '../workspace/run.js';
import { createJob, getJob, emit, finish, cancel } from '../jobs/registry.js';
import { runAgentTask } from '../agent/tasks.js';
import { sleep } from '../utils/async.js';

const HELP = `*Universal Modder*

Send a natural-language coding request and I will work on it.

Commands
/start — welcome
/help — this message
/status — current session
/repos — list your GitHub repositories
/workspace <owner/repo> — clone a repo into a fresh workspace
/files — list workspace files
/diff — show uncommitted changes
/test — run the project test command
/build — run the project build command
/zip — send the workspace as a ZIP
/models — list/select AI models
/model <id> — set model for this chat
/cancel — cancel the running task

State is stored per Telegram user. Each user gets an isolated workspace.`;

const sessions = new Map(); // userId → { workspaceId, dir, repo, branch, jobId }

function getUser(id) {
  if (!sessions.has(id)) sessions.set(id, { workspaceId: null, dir: null, repo: null, branch: null, jobId: null, model: null });
  return sessions.get(id);
}

export function isAuthorized(userId) {
  if (config.telegram.allowedUserIds.length === 0) return false;
  return config.telegram.allowedUserIds.includes(String(userId));
}

async function withTyping(chatId, promiseFactory) {
  let alive = true;
  const tick = async () => {
    while (alive) {
      await sendChatAction(chatId, 'typing');
      await sleep(config.telegram.typingRefreshMs);
    }
  };
  const loop = tick();
  try {
    return await promiseFactory();
  } finally {
    alive = false;
    await loop.catch(() => {});
  }
}

async function handleCommand(msg, text) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const state = getUser(userId);

  const [cmd, ...rest] = text.trim().split(/\s+/);
  const arg = rest.join(' ').trim();

  switch (cmd) {
    case '/start':
      await sendMessage(chatId, `Welcome to *Universal Modder*.\n\nYour Telegram user ID is \`${userId}\`.\n\n${HELP}`);
      return;

    case '/help':
      await sendMessage(chatId, HELP);
      return;

    case '/status': {
      const lines = [
        `*Session status*`,
        `Workspace: \`${state.workspaceId || 'none'}\``,
        `Repository: \`${state.repo || 'none'}\``,
        `Branch: \`${state.branch || 'none'}\``,
        `Running job: \`${state.jobId || 'none'}\``,
      ];
      await sendMessage(chatId, lines.join('\n'));
      return;
    }

    case '/repos': {
      const repos = await withTyping(chatId, () => listRepositories({ perPage: 20 }));
      if (!repos.length) return void await sendMessage(chatId, 'No repositories found.');
      const lines = repos.map((r, i) => `${i + 1}. \`${r.fullName}\`${r.private ? ' 🔒' : ''} — ${r.language || 'n/a'}`);
      await sendMessage(chatId, `*Repositories*\n\n${lines.join('\n')}\n\nClone with \`/workspace owner/repo\``);
      return;
    }

    case '/workspace': {
      if (!arg || !arg.includes('/')) return void await sendMessage(chatId, 'Usage: `/workspace owner/repo`');
      const [owner, repo] = arg.split('/');
      let createdId = null;
      try {
        const created = await withTyping(chatId, async () => {
          const { id, dir } = await ws.createWorkspace();
          createdId = id;
          const cloned = await cloneRepo({ owner, repo, dir, token: config.github.token });
          return { id, dir, branch: cloned.branch };
        });
        state.workspaceId = created.id;
        state.dir = created.dir;
        state.repo = `${owner}/${repo}`;
        state.branch = created.branch;
        const project = await detectProjectType(created.dir);
        await sendMessage(chatId, `Cloned \`${owner}/${repo}\`\nWorkspace: \`${created.id}\`\nBranch: \`${created.branch}\`\nProject: \`${project.type}\``);
      } catch (err) {
        if (createdId) await ws.removeWorkspace(createdId).catch(() => {});
        await sendMessage(chatId, `Clone failed: ${err.message}`);
      }
      return;
    }

    case '/files': {
      if (!state.workspaceId) return void await sendMessage(chatId, 'No workspace. Use `/workspace owner/repo` first.');
      const files = await ws.listFiles(state.workspaceId, { max: 60 });
      const listing = files.map((f) => `\`${f.path}\``).join('\n') || '(empty)';
      await sendMessage(chatId, `*Files*\n\n${listing}`);
      return;
    }

    case '/diff': {
      if (!state.workspaceId) return void await sendMessage(chatId, 'No workspace.');
      const dir = await ws.resolveWorkspace(state.workspaceId);
      const { simpleGit } = await import('simple-git');
      const git = simpleGit({ baseDir: dir });
      const d = await gitDiff(git);
      const body = d?.trim() ? `\`\`\`\n${d.slice(0, 3500)}\n\`\`\`` : 'No changes.';
      await sendMessage(chatId, body);
      return;
    }

    case '/test':
    case '/build': {
      if (!state.workspaceId) return void await sendMessage(chatId, 'No workspace.');
      const action = cmd.slice(1);
      const out = await withTyping(chatId, () => runProjectAction({ dir: state.dir, action }));
      if (!out.supported) return void await sendMessage(chatId, `\`${action}\` is not defined for project type \`${out.projectType}\`.`);
      const last = out.results[out.results.length - 1];
      const text = `*${action}* — ${out.ok ? '✅ passed' : '❌ failed'} (exit ${last.code}, ${last.durationMs}ms)\n\`\`\`\n${(last.stdout + '\n' + last.stderr).slice(0, 3500)}\n\`\`\``;
      await sendMessage(chatId, text);
      return;
    }

    case '/zip': {
      if (!state.workspaceId) return void await sendMessage(chatId, 'No workspace.');
      const zip = await withTyping(chatId, () => createZip(state.workspaceId));
      const buf = await fs.readFile(zip.path);
      if (buf.length > 49 * 1024 * 1024) {
        return void await sendMessage(chatId, `Archive is ${(buf.length / 1048576).toFixed(1)} MB — too large for Telegram (50 MB limit).`);
      }
      await sendDocument(chatId, buf, zip.name, `Workspace ${state.workspaceId}`);
      return;
    }

    case '/cancel': {
      if (!state.jobId) return void await sendMessage(chatId, 'No running task.');
      const job = getJob(state.jobId);
      if (job) cancel(job);
      await sendMessage(chatId, 'Cancellation requested.');
      return;
    }


    case '/models': {
      await fetchCustomModels();
      const cache = getCachedModels();
      const lines = (cache.models || []).slice(0, 40).map((m, i) =>
        `${i + 1}. \`${m.openCodeRef}\` — ${m.name}`
      );
      const current = state.model || resolveDefaultModelRef() || '(default)';
      const body = lines.length
        ? `*Available models* (current: \`${current}\`)\n\n${lines.join('\n')}\n\nSelect with \`/model <id or openCodeRef>\``
        : `No models discovered (${cache.error || 'none'}). Using default \`${current}\`.`;
      await sendMessage(chatId, body);
      return;
    }

    case '/model': {
      if (!arg) {
        const current = state.model || resolveDefaultModelRef() || '(default)';
        return void await sendMessage(chatId, `Current model: \`${current}\`\nUse \`/model <id>\` to change.`);
      }
      const resolved = resolveUserModelSelection(arg);
      if (!resolved) return void await sendMessage(chatId, 'Could not resolve that model id.');
      state.model = resolved;
      await sendMessage(chatId, `Model set to \`${resolved}\` for this chat.`);
      return;
    }

    default:
      await sendMessage(chatId, `Unknown command \`${cmd}\`. Try /help.`);
  }
}

async function handleNaturalLanguage(msg, text) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const state = getUser(userId);

  if (!state.workspaceId) {
    // Auto-clone if the message names a repo, otherwise create an empty workspace.
    const repoMatch = text.match(/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/);
    if (repoMatch) {
      await sendMessage(chatId, `Cloning \`${repoMatch[1]}\`...`);
      const [owner, repo] = repoMatch[1].split('/');
      let cloneWsId = null;
      try {
        const { id, dir } = await ws.createWorkspace();
        cloneWsId = id;
        const cloned = await cloneRepo({ owner, repo, dir, token: config.github.token });
        state.workspaceId = id; state.dir = dir; state.repo = repoMatch[1]; state.branch = cloned.branch;
      } catch (err) {
        if (cloneWsId) await ws.removeWorkspace(cloneWsId).catch(() => {});
        return void await sendMessage(chatId, `Could not clone: ${err.message}`);
      }
    } else {
      const { id, dir } = await ws.createWorkspace();
      state.workspaceId = id; state.dir = dir;
    }
  }

  // Ensure workspace directory is resolved even if only workspaceId was stored.
  if (state.workspaceId && !state.dir) {
    try {
      state.dir = await ws.resolveWorkspace(state.workspaceId);
    } catch (err) {
      return void await sendMessage(chatId, `Workspace error: ${err.message}`);
    }
  }

  try {
    const { ensureOpenCodeReady } = await import('../agent/opencode.js');
    await ensureOpenCodeReady(45000);
  } catch {
    return void await sendMessage(chatId, 'OpenCode is still starting. Please retry in a few seconds.');
  }

  const selectedModel = state.model || resolveDefaultModelRef() || undefined;

  const job = createJob({ type: 'agent', meta: { source: 'telegram', userId, workspaceId: state.workspaceId, model: selectedModel } });
  state.jobId = job.id;

  const progress = [];
  let lastFlush = 0;
  const flush = async (force = false) => {
    if (!force && Date.now() - lastFlush < 4000) return;
    lastFlush = Date.now();
    if (!progress.length) return;
    await sendMessage(chatId, progress.slice(-8).join('\n')).catch(() => {});
  };

  try {
    await sendMessage(chatId, `Working on it… (job \`${job.id}\`)`);

    await withTyping(chatId, async () => {
      await runAgentTask({
      directory: state.dir,
      model: selectedModel,
        prompt: text,
        onEvent: (ev) => {
          emit(job, ev);
          if (ev.type === 'part' && (ev.role === 'user' || ev.role === 'system')) return;
          if (ev.type === 'part' && ev.part?.type === 'text' && ev.part.text) {
            progress.push(`→ ${ev.part.text.slice(0, 180)}`);
            flush();
          } else if (ev.type === 'part' && ev.part?.type === 'tool') {
            progress.push(`→ 🔧 ${ev.part.tool || 'tool'}`);
            flush();
          }
        },
        signal: job.controller.signal,
      });
    });

    await flush(true);
    const zip = await createZip(state.workspaceId);
    const buf = await fs.readFile(zip.path);
    if (buf.length <= 49 * 1024 * 1024) {
      await sendDocument(chatId, buf, zip.name, 'Resulting workspace');
    } else {
      await sendMessage(chatId, `Done — workspace archived at \`${zip.name}\` (${(buf.length / 1048576).toFixed(1)} MB, too large for Telegram).`);
    }
    finish(job, { result: { workspaceId: state.workspaceId } });
  } catch (err) {
    finish(job, { error: err });
    await sendMessage(chatId, `Task failed: ${err.message}`);
  } finally {
    state.jobId = null;
  }
}

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.text) return;
  const userId = msg.from?.id;
  const chatId = msg.chat?.id;
  if (!userId || !chatId) return;

  if (!isAuthorized(userId)) {
    logger.warn(`Telegram: rejected unauthorized user ${userId}`);
    await sendMessage(chatId, `⛔ Unauthorized.\nYour Telegram user ID is \`${userId}\`.\nAdd it to TELEGRAM_ALLOWED_USER_IDS to grant access.`);
    return;
  }

  const text = msg.text.trim();
  try {
    if (text.startsWith('/')) await handleCommand(msg, text);
    else await handleNaturalLanguage(msg, text);
  } catch (err) {
    logger.error(`Telegram handler error: ${err.message}`);
    await sendMessage(chatId, `⚠️ ${err.message}`).catch(() => {});
  }
}

let running = false;

export async function startTelegramBot() {
  if (!config.telegram.token) return null;
  if (running) return null; // prevent duplicate polling workers
  running = true;

  let me;
  try { me = await getMe(); }
  catch (err) {
    logger.error(`Telegram getMe failed: ${err.message}`);
    running = false;
    return null;
  }
  logger.info(`Telegram bot @${me.username} starting`);

  await setMyCommands([
    { command: 'start', description: 'Welcome' },
    { command: 'help', description: 'Show help' },
    { command: 'status', description: 'Session status' },
    { command: 'repos', description: 'List repositories' },
    { command: 'workspace', description: 'Clone owner/repo' },
    { command: 'files', description: 'List workspace files' },
    { command: 'diff', description: 'Show uncommitted changes' },
    { command: 'test', description: 'Run project tests' },
    { command: 'build', description: 'Run project build' },
    { command: 'zip', description: 'Download workspace ZIP' },
    { command: 'cancel', description: 'Cancel running task' },
    { command: 'models', description: 'List available AI models' },
    { command: 'model', description: 'Set model for this chat' },
  ]).catch((e) => logger.warn(`setMyCommands failed: ${e.message}`));

  let offset = 0;

  (async function loop() {
    let backoff = 1000;
    while (running) {
      try {
        const updates = await getUpdates({ offset, timeoutSec: config.telegram.pollTimeoutSec });
        backoff = 1000;
        for (const u of updates || []) {
          offset = u.update_id + 1;
          handleUpdate(u).catch((e) => logger.error(`Telegram update error: ${e.message}`));
        }
      } catch (err) {
        logger.warn(`Telegram polling error: ${err.message}; retrying in ${backoff}ms`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  })();

  return { stop: () => { running = false; } };
}

export function stopTelegramBot() { running = false; }
