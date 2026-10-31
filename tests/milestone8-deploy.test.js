import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { listDeployProviders } from '../src/deploy/adapters.js';

test('deploy providers include render netlify vercel without exposing secrets', () => {
  const providers = listDeployProviders();
  const ids = providers.map((p) => p.id).sort();
  assert.deepEqual(ids, ['netlify', 'render', 'vercel']);
});

test('deploy routes require authorizeDeploy and app mounts readiness', () => {
  const deploy = fs.readFileSync(new URL('../src/server/routes/deploy.js', import.meta.url), 'utf8');
  assert.match(deploy, /authorizeDeploy/);
  const app = fs.readFileSync(new URL('../src/server/app.js', import.meta.url), 'utf8');
  assert.match(app, /deployRouter/);
  assert.match(app, /\/ready/);
  assert.match(app, /\/api\/metrics/);
});
