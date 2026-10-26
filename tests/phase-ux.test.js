import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const SAVED = { ...process.env };
after(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in SAVED)) delete process.env[k];
  }
  Object.assign(process.env, SAVED);
});

test('UI has workspace-first empty state and model meta hooks', () => {
  const html = fs.readFileSync(path.join(root, 'src/ui/index.html'), 'utf8');
  assert.ok(html.includes('id="empty-title"'));
  assert.ok(html.includes('Select a workspace first') || html.includes('empty-title'));
  assert.ok(html.includes('id="settings-model"'));
  assert.ok(html.includes('id="model-meta"'));
  assert.ok(html.includes('id="meta-opencode"'));
  assert.ok(html.includes('id="prompt"') && html.includes('disabled'));
});

test('app.js gates composer on workspace and readiness', () => {
  const js = fs.readFileSync(path.join(root, 'src/ui/app.js'), 'utf8');
  assert.ok(js.includes('function updateComposerState'));
  assert.ok(js.includes('/api/models'));
  assert.ok(js.includes('openCodeReady'));
  assert.ok(js.includes("role === 'user'") || js.includes('role === "user"') || js.includes("ev.role === 'user'"));
});

test('git push requires confirm: true', () => {
  const src = fs.readFileSync(path.join(root, 'src/server/routes/github.js'), 'utf8');
  assert.ok(src.includes('CONFIRM_REQUIRED'));
  assert.ok(src.includes('confirm !== true'));
});

test('plan-then-act prefix is optional via PLAN_THEN_ACT', () => {
  const src = fs.readFileSync(path.join(root, 'src/agent/tasks.js'), 'utf8');
  assert.ok(src.includes('PLAN_THEN_ACT'));
  assert.ok(src.includes('planPrefix') || src.includes('finalPrompt'));
});

test('.env.example documents custom AI and ASCII keys', () => {
  const env = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  assert.ok(env.includes('CUSTOM_AI_BASE_URL'));
  assert.ok(env.includes('ASCII') || env.includes('pure ASCII') || env.includes('no bullets'));
  assert.ok(env.includes('api.deepseek.com') || env.includes('DEFAULT_MODEL'));
});
