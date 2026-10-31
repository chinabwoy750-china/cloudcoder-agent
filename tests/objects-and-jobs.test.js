import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { putObject, getObject, deleteObject, getObjectStorageMode, objectStorageHealth } from '../src/storage/objects.js';
import { createJob, finish, getJob, listJobs } from '../src/jobs/registry.js';

test('object storage local put/get/delete round-trip', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'um-objects-'));
  process.env.OBJECT_STORAGE_PATH = root;
  assert.equal(getObjectStorageMode(), 'local');
  const key = 'tests/sample.txt';
  await putObject(key, Buffer.from('hello-durable'), 'text/plain');
  const got = await getObject(key);
  assert.equal(got.body.toString('utf8'), 'hello-durable');
  await deleteObject(key);
  await assert.rejects(() => getObject(key));
  const health = await objectStorageHealth();
  assert.equal(health.ready, true);
});

test('job registry create/finish tracks status', () => {
  const job = createJob({ type: 'agent', meta: { workspaceId: 'abc', ownerUserId: null } });
  assert.equal(job.status, 'running');
  assert.ok(getJob(job.id));
  finish(job, { result: { ok: true } });
  assert.equal(job.status, 'completed');
  assert.ok(listJobs().some((j) => j.id === job.id));
});
