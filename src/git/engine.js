import simpleGit from 'simple-git';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

const AUTHOR = {
  name: process.env.GIT_AUTHOR_NAME || 'CloudCoder Agent',
  email: process.env.GIT_AUTHOR_EMAIL || 'cloudcoder@localhost',
};

function publicUrl(owner, repo) {
  return `https://github.com/${owner}/${repo}.git`;
}

function authedUrl(owner, repo, token) {
  // x-access-token form works for both classic and fine-grained PATs
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}

async function run(label, fn) {
  try {
    return await fn();
  } catch (err) {
    const msg = err?.message || String(err);
    logger.warn(`git ${label} failed: ${msg}`);
    throw Object.assign(new Error(`git ${label} failed: ${msg}`), { code: 'GIT_ERROR', cause: err });
  }
}

/**
 * Clone into an empty workspace directory and leave it as a valid git repo.
 * Never writes core.hooksPath (modern git rejects it without allowUnsafeHooksPath).
 * Hooks are disabled per-operation via --no-verify on commit/push instead.
 */
export async function cloneRepo({ owner, repo, dir, branch, token }) {
  const url = token ? authedUrl(owner, repo, token) : publicUrl(owner, repo);
  const args = ['--depth', String(config.github.cloneDepth || 1), '--single-branch'];
  if (branch) args.push('--branch', branch);

  const outer = simpleGit();
  await run('clone', () => outer.clone(url, dir, args));

  // Verify the workspace is actually a git repository
  const gitDir = path.join(dir, '.git');
  const st = await fs.stat(gitDir).catch(() => null);
  if (!st) {
    throw Object.assign(
      new Error(`Clone completed but ${dir} is not a git repository`),
      { code: 'GIT_CLONE_INVALID' }
    );
  }

  const git = simpleGit({ baseDir: dir });
  // Strip credentials from origin URL so they are not persisted on disk
  await git.remote(['set-url', 'origin', publicUrl(owner, repo)]);
  await git.addConfig('user.name', AUTHOR.name);
  await git.addConfig('user.email', AUTHOR.email);
  // Do NOT set core.hooksPath — newer Git requires allowUnsafeHooksPath for that.
  // Commit/push already use --no-verify.

  const resolvedBranch = branch || await currentBranch(git);
  logger.info(`Cloned ${owner}/${repo} → ${dir} (branch=${resolvedBranch})`);
  return { git, branch: resolvedBranch };
}

export async function currentBranch(git) {
  const b = await git.revparse(['--abbrev-ref', 'HEAD']);
  return b.trim();
}

export async function createBranch(git, name) {
  if (!/^[A-Za-z0-9._\/-]{1,100}$/.test(name)) throw new Error('Invalid branch name');
  await run('checkout -b', () => git.checkoutLocalBranch(name));
  return name;
}

export async function status(git) {
  return run('status', () => git.status());
}

export async function diff(git, { staged = false, target } = {}) {
  const args = staged ? ['--cached'] : [];
  if (target) args.push(target);
  return run('diff', () => git.diff(args));
}

export async function addAll(git) {
  return run('add', () => git.add(['-A']));
}

export async function commit(git, message) {
  if (!message || !message.trim()) throw new Error('Commit message required');
  return run('commit', () => git.commit(message, undefined, { '--no-verify': null }));
}

export async function push(git, { owner, repo, branch, token }) {
  if (!token) throw new Error('GitHub token required for push');
  if (!branch) throw new Error('Branch required for push');
  const url = authedUrl(owner, repo, token);
  await run('push', () => git.push(url, `HEAD:refs/heads/${branch}`, ['--no-verify']));
  logger.info(`Pushed branch ${branch} to ${owner}/${repo}`);
}

export async function log(git, { max = 20 } = {}) {
  const out = await run('log', () => git.log({ maxCount: max }));
  return out.all;
}

export function assertBranchSafety(branch, defaultBranch) {
  if (!config.github.allowDefaultBranchPush && branch === defaultBranch) {
    throw Object.assign(
      new Error(`Refusing to push directly to default branch "${branch}". Create a feature branch or set GITHUB_ALLOW_DEFAULT_BRANCH=true.`),
      { code: 'DEFAULT_BRANCH_PROTECTED' }
    );
  }
}

/** True if dir contains a .git directory (file or dir). */
export async function isGitRepo(dir) {
  const st = await fs.stat(path.join(dir, '.git')).catch(() => null);
  return Boolean(st);
}
