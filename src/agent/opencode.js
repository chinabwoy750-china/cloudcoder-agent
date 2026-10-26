import { spawn } from 'node:child_process';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { serialiseOpenCodeConfig } from '../config/opencode-config.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

function resolveOpenCodeBin() {
  for (const candidate of ['/usr/bin/opencode', '/usr/local/bin/opencode', 'opencode']) {
    try {
      if (candidate.startsWith('/')) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
      return execFileSync('which', [candidate], { encoding: 'utf8' }).trim();
    } catch { /* try next */ }
  }
  return 'opencode';
}

let proc = null;
let ready = false;
let shuttingDown = false;
let lastExit = null;

function pipeOpenCodeLogs(stream, label) {
  let buf = '';
  stream.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '').trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      // Always surface OpenCode process output at info — on Render Free,
      // LOG_LEVEL=info previously hid crashes that only went to debug.
      logger.info(`[${label}] ${line}`);
    }
  });
  stream.on('end', () => {
    const rest = buf.trim();
    if (rest) logger.info(`[${label}] ${rest}`);
  });
}

export function startOpenCode() {
  if (proc) return proc;

  let inlineConfig = '{}';
  try {
    inlineConfig = serialiseOpenCodeConfig();
  } catch (err) {
    logger.error(`[opencode-config] Failed to build config: ${err.message}; starting OpenCode with empty config`);
    inlineConfig = JSON.stringify({ $schema: 'https://opencode.ai/config.json' });
  }

  const env = {
    ...process.env,
    OPENCODE_SERVER_PASSWORD: config.opencode.password,
    OPENCODE_SERVER_USERNAME: config.opencode.username,
    // Inline config — never written to disk. API key is NOT embedded;
    // the provider references CUSTOM_AI_API_KEY via env: [...].
    OPENCODE_CONFIG_CONTENT: inlineConfig,
  };

  const bin = resolveOpenCodeBin();
  const args = ['serve', '--port', String(config.opencode.port), '--hostname', config.opencode.hostname];
  // Ensure OpenCode has a writable HOME (Docker USER cloudcoder).
  if (!env.HOME) env.HOME = process.env.HOME || '/home/cloudcoder';

  logger.info(`Starting OpenCode: ${bin} ${args.join(' ')}`);
  logger.info(
    `OpenCode env: port=${config.opencode.port} host=${config.opencode.hostname} home=${env.HOME} ` +
    `configBytes=${Buffer.byteLength(inlineConfig)} hasCustomBase=${Boolean(process.env.CUSTOM_AI_BASE_URL)} ` +
    `hasCustomKey=${Boolean(process.env.CUSTOM_AI_API_KEY)}`
  );

  proc = spawn(bin, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });
  logger.info(`OpenCode child pid=${proc.pid}`);

  pipeOpenCodeLogs(proc.stdout, 'opencode');
  pipeOpenCodeLogs(proc.stderr, 'opencode:err');

  proc.on('error', (err) => {
    logger.error(`OpenCode spawn error: ${err.message}`);
    ready = false;
    lastExit = { code: null, signal: null, error: err.message, at: Date.now() };
  });

  proc.on('exit', (code, signal) => {
    logger.warn(`OpenCode exited (code=${code}, signal=${signal})`);
    ready = false;
    lastExit = { code, signal, at: Date.now() };
    proc = null;
    if (!shuttingDown && code !== 0 && !signal) {
      logger.info('Restarting OpenCode in 3s...');
      setTimeout(() => { if (!shuttingDown) startOpenCode(); }, 3000);
    }
  });

  return proc;
}

export async function waitForOpenCode(maxWaitMs = 90000) {
  if (ready) return true;
  const url = `http://${config.opencode.hostname}:${config.opencode.port}/global/health`;
  const auth = 'Basic ' + Buffer.from(
    `${config.opencode.username}:${config.opencode.password}`
  ).toString('base64');
  const start = Date.now();
  let attempt = 0;

  while (Date.now() - start < maxWaitMs) {
    attempt += 1;
    if (lastExit && lastExit.at >= start) {
      throw new Error(
        `OpenCode process exited before becoming ready ` +
        `(code=${lastExit.code}, signal=${lastExit.signal}` +
        `${lastExit.error ? `, error=${lastExit.error}` : ''}). Check [opencode] / [opencode:err] log lines above.`
      );
    }
    try {
      // Bound each probe: fetch can otherwise remain pending after the TCP
      // connection succeeds, preventing the outer maxWaitMs deadline from
      // being checked and making a 120s timeout appear several minutes late.
      const res = await fetch(url, {
        headers: { Authorization: auth },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        let body = {};
        try { body = await res.json(); } catch { /* health body may be empty */ }
        logger.info(`OpenCode ready (version=${body.version || 'unknown'})`);
        ready = true;
        return true;
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(`OpenCode health endpoint rejected Basic authentication (HTTP ${res.status}); check OPENCODE_SERVER_USERNAME and OPENCODE_SERVER_PASSWORD.`);
      }
      if (res.status === 404) {
        throw new Error(`OpenCode health endpoint returned HTTP 404 at ${url}; verify the installed OpenCode API/version.`);
      }
      if (attempt === 1 || attempt % 10 === 0) {
        logger.info(`OpenCode health HTTP ${res.status} (attempt ${attempt}, waited=${Date.now() - start}ms)`);
      }
    } catch (err) {
      if (/rejected Basic authentication|health endpoint returned HTTP 404/.test(err.message)) throw err;
      if (attempt === 1 || attempt % 10 === 0) {
        const alive = proc && proc.exitCode === null && !proc.killed;
        const reason = err.name === 'TimeoutError' || err.name === 'AbortError'
          ? 'request-timeout'
          : (err.cause?.code || err.message);
        logger.info(
          `OpenCode not reachable yet (attempt ${attempt}, alive=${Boolean(alive)}, ` +
          `waited=${Date.now() - start}ms): ${reason}`
        );
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  const alive = proc && proc.exitCode === null && !proc.killed;
  throw new Error(
    `OpenCode not ready within ${maxWaitMs}ms (process_alive=${Boolean(alive)}, ` +
    `lastExit=${lastExit ? JSON.stringify(lastExit) : 'none'}). ` +
    `Inspect [opencode] / [opencode:err] lines in the logs.`
  );
}

/**
 * Wait until OpenCode is ready or throw OPENCODE_NOT_READY.
 * Used by agent API and Telegram before starting jobs.
 */
export async function ensureOpenCodeReady(maxWaitMs = 45000) {
  if (ready) return true;
  try {
    await waitForOpenCode(maxWaitMs);
  } catch (err) {
    throw Object.assign(
      new Error('OpenCode is still starting. Retry in a few seconds.'),
      { code: 'OPENCODE_NOT_READY', status: 503, cause: err }
    );
  }
  if (!ready) {
    throw Object.assign(
      new Error('OpenCode is not ready'),
      { code: 'OPENCODE_NOT_READY', status: 503 }
    );
  }
  return true;
}

export function isOpenCodeReady() { return ready; }

export function stopOpenCode() {
  shuttingDown = true;
  if (proc) {
    logger.info('Stopping OpenCode...');
    proc.kill('SIGTERM');
    setTimeout(() => proc && proc.kill('SIGKILL'), 5000);
  }
}
