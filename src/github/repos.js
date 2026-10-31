import { getOctokit, withRetry } from './client.js';
import { logger } from '../utils/logger.js';

export async function listRepositories({ perPage = 50, sort = 'updated' } = {}) {
  const octokit = getOctokit();
  if (!octokit) throw Object.assign(new Error('GitHub not configured'), { code: 'GITHUB_DISABLED' });
  return withRetry(async () => {
    const { data } = await octokit.rest.repos.listForAuthenticatedUser({ per_page: Math.min(perPage, 100), sort });
    return data.map((r) => ({
      fullName: r.full_name,
      owner: r.owner.login,
      name: r.name,
      private: r.private,
      defaultBranch: r.default_branch,
      language: r.language,
      updatedAt: r.updated_at,
      description: r.description,
    }));
  });
}

export async function getRepository(owner, repo) {
  const octokit = getOctokit();
  if (!octokit) throw Object.assign(new Error('GitHub not configured'), { code: 'GITHUB_DISABLED' });
  return withRetry(async () => {
    const { data } = await octokit.rest.repos.get({ owner, repo });
    return {
      fullName: data.full_name,
      owner: data.owner.login,
      name: data.name,
      defaultBranch: data.default_branch,
      private: data.private,
      language: data.language,
      cloneUrl: data.clone_url,
    };
  });
}

export async function getAuthenticatedUser() {
  const octokit = getOctokit();
  if (!octokit) throw Object.assign(new Error('GitHub not configured'), { code: 'GITHUB_DISABLED' });
  return withRetry(async () => {
    const { data } = await octokit.rest.users.getAuthenticated();
    logger.info(`GitHub authenticated as ${data.login}`);
    return { login: data.login, id: data.id };
  });
}


export async function listBranches(owner, repo, { perPage = 50 } = {}) {
  const octokit = getOctokit();
  if (!octokit) throw Object.assign(new Error('GitHub not configured'), { code: 'GITHUB_DISABLED' });
  return withRetry(async () => {
    const { data } = await octokit.rest.repos.listBranches({ owner, repo, per_page: Math.min(perPage, 100) });
    return data.map((b) => ({ name: b.name, protected: b.protected, sha: b.commit?.sha }));
  });
}
