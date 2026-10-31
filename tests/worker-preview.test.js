import test from 'node:test';
import assert from 'node:assert/strict';
import { signPreviewToken, verifyPreviewToken } from '../src/auth/preview-token.js';
import { isolationMode } from '../src/worker/runner.js';
import { config } from '../src/config/env.js';

test('preview token signs and verifies for workspace', () => {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-value-32chars!!';
  // config.session.secret already loaded — re-import path uses env at module load; sign uses config
  const token = signPreviewToken({ workspaceId: 'abc123', userId: 'u1', expMs: 60_000 });
  const claims = verifyPreviewToken(token, 'abc123');
  assert.ok(claims);
  assert.equal(claims.wid, 'abc123');
  assert.equal(verifyPreviewToken(token, 'other'), null);
});

test('expired preview token rejected', () => {
  const token = signPreviewToken({ workspaceId: 'w1', expMs: -1000 });
  assert.equal(verifyPreviewToken(token, 'w1'), null);
});

test('isolation mode defaults to local-process', () => {
  delete process.env.WORKER_URL;
  delete process.env.DOCKER_ISOLATION;
  assert.equal(isolationMode(), 'local-process');
});
