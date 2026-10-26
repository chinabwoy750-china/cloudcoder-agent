import { test, after, before } from 'node:test';
import assert from 'node:assert';

const SAVED = { ...process.env };
function resetCustom() {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('CUSTOM_AI_') || k === 'DEFAULT_MODEL') delete process.env[k];
  }
}

process.env.CLOUDCODER_USERNAME = 'u';
process.env.CLOUDCODER_PASSWORD = 'p';
process.env.OPENCODE_SERVER_PASSWORD = 'o';
process.env.SESSION_SECRET = 'x'.repeat(64);

after(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in SAVED)) delete process.env[k];
  }
  Object.assign(process.env, SAVED);
});

test('isOpenCodeReady is false before start', async () => {
  const { isOpenCodeReady } = await import('../src/agent/opencode.js');
  assert.equal(typeof isOpenCodeReady, 'function');
  // Without starting OpenCode, ready should be false
  assert.equal(isOpenCodeReady(), false);
});

test('resolveUserModelSelection maps bare and provider refs', async () => {
  resetCustom();
  process.env.CUSTOM_AI_BASE_URL = 'https://example.com/v1';
  process.env.CUSTOM_AI_PROVIDER = 'custom';
  process.env.CUSTOM_AI_MODEL = 'free-way/gpt-5.6-luna';
  const {
    _resetCacheForTests,
    resolveUserModelSelection,
    resolveDefaultModelRef,
    sanitizeModelKey,
  } = await import('../src/config/custom-models.js');
  _resetCacheForTests();
  // Seed fallback via fetch with missing key → fallback path
  process.env.CUSTOM_AI_API_KEY = '';
  const { fetchCustomModels } = await import('../src/config/custom-models.js');
  await fetchCustomModels({ force: true });
  const def = resolveDefaultModelRef();
  assert.ok(def.includes('custom/'));
  assert.ok(!def.includes(' '));
  const bare = resolveUserModelSelection('free-way/gpt-5.6-luna');
  assert.ok(bare.startsWith('custom/'));
  const full = resolveUserModelSelection('custom/free-way/gpt-5.6-luna');
  assert.equal(full, 'custom/free-way/gpt-5.6-luna');
  // Foreign provider passes through
  assert.equal(resolveUserModelSelection('openai/gpt-4o'), 'openai/gpt-4o');
});

test('modelsForOpenCodeConfig never embeds API key', async () => {
  resetCustom();
  process.env.CUSTOM_AI_BASE_URL = 'https://example.com/v1';
  process.env.CUSTOM_AI_MODEL = 'model-a';
  process.env.CUSTOM_AI_API_KEY = 'sk-secret-key-should-not-appear';
  const { _resetCacheForTests, fetchCustomModels, modelsForOpenCodeConfig } =
    await import('../src/config/custom-models.js');
  _resetCacheForTests();
  await fetchCustomModels({ force: true });
  const models = modelsForOpenCodeConfig();
  const json = JSON.stringify(models);
  assert.ok(!json.includes('sk-secret-key-should-not-appear'));
});

test('multiple models from mock discovery shape', async () => {
  resetCustom();
  process.env.CUSTOM_AI_BASE_URL = 'https://example.com/v1';
  process.env.CUSTOM_AI_PROVIDER = 'custom';
  process.env.CUSTOM_AI_API_KEY = 'sk-x';
  // Simulate cache injection via fallback only - without live endpoint
  const { _resetCacheForTests, getCachedModels, modelsForOpenCodeConfig, toOpenCodeRef } =
    await import('../src/config/custom-models.js');
  _resetCacheForTests();
  // Manually exercise sanitize / refs for multi-model
  const refs = ['gpt-a', 'gpt-b', 'free way/x'].map(toOpenCodeRef);
  assert.deepEqual(refs[0], 'custom/gpt-a');
  assert.deepEqual(refs[1], 'custom/gpt-b');
  assert.ok(!refs[2].includes(' '));
  assert.ok(modelsForOpenCodeConfig());
  assert.ok(getCachedModels());
});

test('git isGitRepo detects missing .git', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  // Inline the same check as engine.isGitRepo to avoid loading simple-git in unit tests
  async function isGitRepo(dir) {
    const st = await fs.stat(path.join(dir, '.git')).catch(() => null);
    return Boolean(st);
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-git-'));
  assert.equal(await isGitRepo(dir), false);
  await fs.mkdir(path.join(dir, '.git'));
  assert.equal(await isGitRepo(dir), true);
  await fs.rm(dir, { recursive: true, force: true });
});

test('API key with non-ASCII is stripped for headers', async () => {
  resetCustom();
  // bullet character U+2022 often pasted from mobile keyboards
  process.env.CUSTOM_AI_BASE_URL = 'https://example.com/v1';
  process.env.CUSTOM_AI_API_KEY = 'sk-test•key-with-bullet';
  process.env.CUSTOM_AI_MODEL = 'm1';
  const { fetchCustomModels, getCachedModels } = await import('../src/config/custom-models.js');
  const { _resetCacheForTests } = await import('../src/config/custom-models.js');
  _resetCacheForTests();
  // Will fail to reach host but must NOT throw ByteString error
  await fetchCustomModels({ force: true });
  const cache = getCachedModels();
  assert.ok(cache.source === 'fallback' || cache.source === 'live');
  assert.ok(!String(cache.error || '').includes('ByteString'));
});
