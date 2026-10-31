/**
 * Isolated-ish project command runner.
 * Prefer Docker-isolated execution when DOCKER_ISOLATION=true and docker CLI is available.
 * Otherwise run with resource timeouts inside a dedicated subprocess group (current host).
 */
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

function dockerAvailable() {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export function isolationMode() {
  if (process.env.WORKER_URL) return 'remote';
  if (process.env.DOCKER_ISOLATION === 'true' && dockerAvailable()) return 'docker';
  return 'local-process';
}

function envForProject(extra = {}) {
  const blocked = new Set([
    'CLOUDCODER_PASSWORD', 'SESSION_SECRET', 'CUSTOM_AI_API_KEY', 'GITHUB_TOKEN',
    'TELEGRAM_BOT_TOKEN', 'OPENCODE_SERVER_PASSWORD', 'DATABASE_URL',
    'UPSTASH_REDIS_REST_TOKEN', 'S3_SECRET_ACCESS_KEY', 'STRIPE_SECRET_KEY',
    'WORKER_SHARED_SECRET',
  ]);
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (blocked.has(k)) continue;
    if (/(_SECRET|_TOKEN|API_KEY|PASSWORD)$/i.test(k)) continue;
    out[k] = v;
  }
  return { ...out, ...extra, NODE_ENV: process.env.NODE_ENV || 'production' };
}

export function runIsolatedProcess({
  cwd,
  cmd,
  args = [],
  timeoutMs = config.limits.commandTimeoutMs,
  maxBytes = config.limits.maxCommandOutputBytes,
  network = false,
}) {
  const mode = isolationMode();
  if (mode === 'docker') {
    return runDockerIsolated({ cwd, cmd, args, timeoutMs, maxBytes, network });
  }
  return runLocalProcess({ cwd, cmd, args, timeoutMs, maxBytes });
}

function runLocalProcess({ cwd, cmd, args, timeoutMs, maxBytes }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let killed = false;
    const child = spawn(cmd, args, {
      cwd,
      env: envForProject(),
      shell: false,
      detached: true,
    });
    const timer = setTimeout(() => {
      killed = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
    }, timeoutMs);

    const append = (buf, which) => {
      const s = buf.toString();
      if (which === 'out') {
        if (stdout.length < maxBytes) stdout += s.slice(0, maxBytes - stdout.length);
      } else if (stderr.length < maxBytes) stderr += s.slice(0, maxBytes - stderr.length);
    };
    child.stdout?.on('data', (d) => append(d, 'out'));
    child.stderr?.on('data', (d) => append(d, 'err'));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, signal: null, stdout, stderr: String(err.message), durationMs: Date.now() - started, killed, mode: 'local-process' });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !killed, code, signal, stdout, stderr, durationMs: Date.now() - started, killed, mode: 'local-process' });
    });
  });
}

function runDockerIsolated({ cwd, cmd, args, timeoutMs, maxBytes, network }) {
  const image = process.env.WORKER_DOCKER_IMAGE || 'node:22-bookworm-slim';
  const workdir = '/workspace';
  const dockerArgs = [
    'run', '--rm',
    '--network', network ? 'bridge' : 'none',
    '--memory', process.env.WORKER_MEMORY || '512m',
    '--cpus', process.env.WORKER_CPUS || '1',
    '--pids-limit', process.env.WORKER_PIDS || '256',
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m',
    '-v', `${path.resolve(cwd)}:${workdir}:rw`,
    '-w', workdir,
    '--user', process.env.WORKER_DOCKER_USER || 'node',
    image,
    cmd, ...args,
  ];
  logger.info(`[worker] docker isolation: ${image} ${cmd} ${args.join(' ')}`);
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let killed = false;
    const child = spawn('docker', dockerArgs, { shell: false, env: envForProject() });
    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);
    const append = (buf, which) => {
      const s = buf.toString();
      if (which === 'out') {
        if (stdout.length < maxBytes) stdout += s.slice(0, maxBytes - stdout.length);
      } else if (stderr.length < maxBytes) stderr += s.slice(0, maxBytes - stderr.length);
    };
    child.stdout?.on('data', (d) => append(d, 'out'));
    child.stderr?.on('data', (d) => append(d, 'err'));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, signal: null, stdout, stderr: String(err.message), durationMs: Date.now() - started, killed, mode: 'docker' });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !killed, code, signal, stdout, stderr, durationMs: Date.now() - started, killed, mode: 'docker' });
    });
  });
}

export async function runRemoteWorker(payload) {
  const base = process.env.WORKER_URL;
  if (!base) throw new Error('WORKER_URL not configured');
  const secret = process.env.WORKER_SHARED_SECRET || '';
  const res = await fetch(`${base.replace(/\/$/, '')}/v1/exec`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(payload.timeoutMs || config.limits.commandTimeoutMs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Worker HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}
