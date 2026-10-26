import { spawn } from 'node:child_process';
import { config } from '../config/env.js';
import { detectProjectType } from '../git/detect.js';
import { logger } from '../utils/logger.js';

/**
 * Map of allowed project actions → argv. The command is chosen by the server
 * based on the detected project type; users only select the action name.
 * This means user input never reaches a shell.
 */
const RECIPES = {
  node:        { test: [['npm', ['test', '--silent']]], build: [['npm', ['run', 'build', '--silent']]], install: [['npm', ['install', '--no-audit', '--no-fund']]] },
  'node-next': { test: [['npm', ['test', '--silent']]], build: [['npm', ['run', 'build']]],       install: [['npm', ['install', '--no-audit', '--no-fund']]] },
  'node-vite': { test: [['npm', ['test', '--silent']]], build: [['npm', ['run', 'build']]],       install: [['npm', ['install', '--no-audit', '--no-fund']]] },
  'node-nuxt': { test: [['npm', ['test', '--silent']]], build: [['npm', ['run', 'build']]],       install: [['npm', ['install', '--no-audit', '--no-fund']]] },
  python:      { test: [['python', ['-m', 'pytest', '-q']]], build: [['python', ['-m', 'compileall', '-q', '.']]], install: [['python', ['-m', 'pip', 'install', '--no-input', '-r', 'requirements.txt']]] },
  go:          { test: [['go', ['test', './...']]], build: [['go', ['build', './...']]], install: [['go', ['mod', 'download']]] },
  rust:        { test: [['cargo', ['test', '--quiet']]], build: [['cargo', ['build', '--quiet']]], install: [['cargo', ['fetch', '--quiet']]] },
  'java-maven':{ test: [['mvn', ['-q', 'test']]], build: [['mvn', ['-q', '-DskipTests', 'package']]], install: [['mvn', ['-q', 'dependency:resolve']]] },
  'java-gradle':{ test: [['./gradlew', ['test', '--quiet']]], build: [['./gradlew', ['build', '-x', 'test', '--quiet']]], install: [['./gradlew', ['dependencies', '--quiet']]] },
  php:         { test: [['composer', ['test']]], build: [['composer', ['install', '--no-interaction']]], install: [['composer', ['install', '--no-interaction']]] },
  static:      { test: [], build: [], install: [] },
};

export function allowedActions(projectType) {
  const recipes = RECIPES[projectType] || {};
  return Object.keys(recipes).filter((k) => recipes[k].length > 0);
}

export function runProcess({ cwd, cmd, args = [], timeoutMs = config.limits.commandTimeoutMs, maxBytes = config.limits.maxCommandOutputBytes, env = {} }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cmd, args, {
      cwd,
      env: {
        ...process.env,
        ...env,
        CI: '1',
        NO_COLOR: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      detached: process.platform !== 'win32',
    });

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;

    const append = (buf, which) => {
      const s = buf.toString();
      if (which === 'out') {
        if (stdout.length < maxBytes) stdout += s;
        else truncated = true;
      } else {
        if (stderr.length < maxBytes) stderr += s;
        else truncated = true;
      }
    };

    child.stdout.on('data', (b) => append(b, 'out'));
    child.stderr.on('data', (b) => append(b, 'err'));

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* ignore */ }
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + `\n${err.message}`, durationMs: Date.now() - started, timedOut, truncated });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code: timedOut ? -1 : (code ?? -1),
        signal,
        stdout: stdout.slice(0, maxBytes),
        stderr: stderr.slice(0, maxBytes),
        durationMs: Date.now() - started,
        timedOut,
        truncated,
      });
    });
  });
}

/**
 * Run a named project action (test / build / install) inside the workspace.
 * The concrete command comes from RECIPES based on detected project type.
 */
export async function runProjectAction({ dir, action, projectType }) {
  const type = projectType || (await detectProjectType(dir)).type;
  const recipes = RECIPES[type] || {};
  const steps = recipes[action];
  if (!steps || steps.length === 0) {
    return {
      supported: false,
      projectType: type,
      action,
      reason: steps ? `No ${action} command defined for ${type}` : `Unknown action "${action}" for ${type}`,
    };
  }

  const results = [];
  for (const [cmd, args] of steps) {
    logger.info(`Running ${action} for ${type}: ${cmd} ${args.join(' ')}`);
    const r = await runProcess({ cwd: dir, cmd, args });
    results.push({ cmd, args, ...r });
    if (r.code !== 0) break;
  }

  const ok = results.every((r) => r.code === 0);
  return { supported: true, projectType: type, action, ok, results };
}
