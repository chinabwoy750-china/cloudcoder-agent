import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';
import { persistJobCreate, persistJobUpdate, loadJobFromDb, listJobsForUser as listJobsForUserDb } from './store.js';

const jobs = new Map();
const MAX_JOBS = 200;

export function createJob({ type, meta = {} }) {
  const id = crypto.randomBytes(6).toString('hex');
  const job = {
    id, type, meta,
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    events: [],
    result: null,
    error: null,
    controller: new AbortController(),
    listeners: new Set(),
  };
  jobs.set(id, job);
  if (jobs.size > MAX_JOBS) {
    const oldest = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt)
      .find((j) => j.status !== 'running');
    if (oldest) jobs.delete(oldest.id);
  }
  logger.info(`Job ${id} created (${type})`);
  // Fire-and-forget durable row
  persistJobCreate(job).catch(() => {});
  return job;
}

export function getJob(id) { return jobs.get(id) || null; }

export function emit(job, event) {
  const enriched = { ...event, at: Date.now() };
  job.events.push(enriched);
  if (job.events.length > 5000) job.events.splice(0, job.events.length - 5000);
  job.updatedAt = Date.now();
  for (const fn of job.listeners) { try { fn(enriched); } catch { /* ignore */ } }
}

export function finish(job, { result, error } = {}) {
  job.status = error ? 'failed' : 'completed';
  job.result = result ?? null;
  job.error = error ? String(error.message || error) : null;
  job.updatedAt = Date.now();
  for (const fn of job.listeners) { try { fn({ type: 'done', status: job.status, error: job.error }); } catch { /* ignore */ } }
  for (const fn of job.listeners) { try { fn.__end?.(); } catch { /* ignore */ } }
  job.listeners.clear();
  logger.info(`Job ${job.id} ${job.status}`);
  persistJobUpdate(job).catch(() => {});
}

export function cancel(job) {
  if (job.status !== 'running') return false;
  job.controller.abort();
  job.status = 'cancelling';
  emit(job, { type: 'status', message: 'Cancellation requested' });
  persistJobUpdate(job).catch(() => {});
  return true;
}

export function subscribe(job, listener) {
  job.listeners.add(listener);
  return () => job.listeners.delete(listener);
}

export function listJobs() {
  return [...jobs.values()].map((j) => ({
    id: j.id, type: j.type, status: j.status, createdAt: j.createdAt, updatedAt: j.updatedAt, meta: j.meta,
  }));
}

export async function listJobsForOwner(ownerUserId, opts) {
  const memory = listJobs().filter((j) => !ownerUserId || j.meta?.ownerUserId === ownerUserId);
  const durable = await listJobsForUserDb(ownerUserId, opts).catch(() => []);
  // Merge by id, prefer memory for live status
  const map = new Map();
  for (const row of durable) {
    map.set(row.id, {
      id: row.id,
      type: row.type,
      status: row.status,
      createdAt: row.created_at ? new Date(row.created_at).getTime() : null,
      updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null,
      meta: row.meta,
      error: row.error,
      durable: true,
    });
  }
  for (const j of memory) map.set(j.id, { ...j, durable: false });
  return [...map.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export async function getJobWithFallback(id) {
  const live = getJob(id);
  if (live) return live;
  const row = await loadJobFromDb(id);
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    createdAt: row.created_at ? new Date(row.created_at).getTime() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).getTime() : null,
    meta: row.meta,
    result: row.result,
    error: row.error,
    events: [],
    durableOnly: true,
  };
}
