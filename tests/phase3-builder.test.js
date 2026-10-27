import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Phase 3 patch restores admin panel, attachment composer, Build/Plan and preview', () => {
  const html = fs.readFileSync(path.join(root, 'src/ui/index.html'), 'utf8');
  for (const needle of ['Admin panel', 'id="attach-btn"', 'id="task-mode"', 'id="preview-toggle"', 'id="model-routing-form"', 'id="preview-frame"']) assert.ok(html.includes(needle), `missing ${needle}`);
});

test('Build & preview invokes bounded build/repair endpoint', () => {
  const js = fs.readFileSync(path.join(root, 'src/ui/app.js'), 'utf8');
  assert.ok(js.includes('/build-repair'));
});

test('build repair has bounded retries and uses the existing agent/model routing', () => {
  const js = fs.readFileSync(path.join(root, 'src/server/routes/build-repair.js'), 'utf8');
  assert.ok(js.includes('MAX_REPAIR_ATTEMPTS = 1'));
  assert.ok(js.includes('runAgentTask'));
  assert.ok(js.includes('routing.build'));
  assert.ok(js.includes('runProjectAction'));
});

test('settings routes are mounted behind the existing authenticated /api middleware', () => {
  const js = fs.readFileSync(path.join(root, 'src/server/app.js'), 'utf8');
  assert.ok(js.indexOf("app.use('/api', requireAuth, csrfGuard)") < js.indexOf("app.use('/api/settings', settingsRouter())"));
});
