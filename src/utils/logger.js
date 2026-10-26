import { redact } from './redact.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const current = LEVELS[process.env.LOG_LEVEL || 'info'] ?? LEVELS.info;

function log(level, ...args) {
  if (LEVELS[level] > current) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}`;
  const safe = redact(line);
  (level === 'error' ? process.stderr : process.stdout).write(safe + '\n');
}

export const logger = {
  error: (...a) => log('error', ...a),
  warn: (...a) => log('warn', ...a),
  info: (...a) => log('info', ...a),
  debug: (...a) => log('debug', ...a),
};
