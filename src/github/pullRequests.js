import { getOctokit, withRetry } from './client.js';
import { logger } from '../utils/logger.js';

export async function createPullRequest({ owner, repo, head, base, title, body, draft = false }) {
  const octokit = getOctokit();
  if (!octokit) throw Object.assign(new Error('GitHub not configured'), { code: 'GITHUB_DISABLED' });
  if (!owner || !repo || !head || !base || !title) throw new Error('owner, repo, head, base, title required');
  return withRetry(async () => {
    const { data } = await octokit.rest.pulls.create({ owner, repo, head, base, title, body: body || '', draft });
    logger.info(`PR created: ${owner}/${repo}#${data.number}`);
    return { number: data.number, url: data.html_url, state: data.state, title: data.title };
  });
}

export async function listPullRequests({ owner, repo, state = 'open' }) {
  const octokit = getOctokit();
  if (!octokit) throw Object.assign(new Error('GitHub not configured'), { code: 'GITHUB_DISABLED' });
  return withRetry(async () => {
    const { data } = await octokit.rest.pulls.list({ owner, repo, state, per_page: 30 });
    return data.map((p) => ({ number: p.number, title: p.title, head: p.head.ref, base: p.base.ref, url: p.html_url, draft: p.draft }));
  });
}
