import { config } from '../config/env.js';
import { detectProjectType } from '../git/detect.js';
import { logger } from '../utils/logger.js';
import { runIsolatedProcess, runRemoteWorker, isolationMode } from '../worker/runner.js';

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

/**
 * Run a single command through the isolation layer.
 */
export async function runProcess({ cwd, cmd, args = [], timeoutMs = config.limits.commandTimeoutMs, maxBytes = config.limits.maxCommandOutputBytes, network = false }) {
  const mode = isolationMode();
  if (mode === 'remote') {
    try {
      const remote = await runRemoteWorker({ cwd, cmd, args, timeoutMs, network });
      return {
        code: remote.ok ? 0 : (remote.code ?? -1),
        signal: remote.signal,
        stdout: String(remote.stdout || '').slice(0, maxBytes),
        stderr: String(remote.stderr || '').slice(0, maxBytes),
        durationMs: remote.durationMs,
        timedOut: Boolean(remote.killed),
        truncated: false,
        isolation: 'remote',
      };
    } catch (err) {
      logger.warn(`[worker] remote execution failed, falling back to local: ${err.message}`);
    }
  }
  const result = await runIsolatedProcess({ cwd, cmd, args, timeoutMs, maxBytes, network });
  return {
    code: result.ok ? 0 : (result.code ?? -1),
    signal: result.signal,
    stdout: String(result.stdout || '').slice(0, maxBytes),
    stderr: String(result.stderr || '').slice(0, maxBytes),
    durationMs: result.durationMs,
    timedOut: Boolean(result.killed),
    truncated: false,
    isolation: result.mode || mode,
  };
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
      isolation: isolationMode(),
    };
  }

  const results = [];
  // install/build often need network when using remote registries
  const needsNetwork = action === 'install';
  for (const [cmd, args] of steps) {
    logger.info(`Running ${action} for ${type}: ${cmd} ${args.join(' ')} (isolation=${isolationMode()})`);
    const r = await runProcess({ cwd: dir, cmd, args, network: needsNetwork });
    results.push({ cmd, args, ...r });
    if (r.code !== 0) break;
  }

  const ok = results.every((r) => r.code === 0);
  return { supported: true, projectType: type, action, ok, results, isolation: isolationMode() };
}
