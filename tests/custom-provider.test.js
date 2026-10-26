import { test, after } from 'node:test';
import assert from 'node:assert';

// Isolate env for the whole suite.
const SAVED = { ...process.env };
function resetEnv() {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('CUSTOM_AI_') || k === 'DEFAULT_MODEL' || k === 'OPENAI_API_KEY') delete process.env[k];
  }
}

process.env.CLOUDCODER_USERNAME = 'u';
process.env.CLOUDCODER_PASSWORD = 'p';
process.env.OPENCODE_SERVER_PASSWORD = 'o';
process.env.SESSION_SECRET = 'x'.repeat(64);

const { buildOpenCodeConfig, serialiseOpenCodeConfig } = await import('../src/config/opencode-config.js');
const { hasCustomAI, validateEnv } = await import('../src/config/env.js');

after(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in SAVED)) delete process.env[k];
  }
  Object.assign(process.env, SAVED);
});

test('no custom config → no provider block', () => {
  resetEnv();
  const cfg = buildOpenCodeConfig();
  assert.equal(cfg.provider, undefined);
  assert.equal(hasCustomAI(), false);
});

test('custom config → provider block with correct baseURL and model', () => {
  resetEnv();
  process.env.CUSTOM_AI_BASE_URL = 'https://example.com/v1';
  process.env.CUSTOM_AI_MODEL = 'my-model';
  process.env.CUSTOM_AI_PROVIDER = 'gpt-china';
  process.env.CUSTOM_AI_API_KEY = 'sk-secret-value-do-not-log';

  const cfg = buildOpenCodeConfig();
  assert.ok(cfg.provider);
  const p = cfg.provider['gpt-china'];
  assert.ok(p, 'provider keyed by CUSTOM_AI_PROVIDER');
  assert.equal(p.npm, '@ai-sdk/openai-compatible');
  assert.equal(p.options.baseURL, 'https://example.com/v1');
  assert.deepEqual(p.env, ['CUSTOM_AI_API_KEY']);
  assert.ok(p.models['my-model'], 'model keyed by CUSTOM_AI_MODEL');
  assert.equal(hasCustomAI(), true);
});

test('API key never appears in the serialised config', () => {
  resetEnv();
  process.env.CUSTOM_AI_BASE_URL = 'https://example.com/v1';
  process.env.CUSTOM_AI_MODEL = 'my-model';
  process.env.CUSTOM_AI_API_KEY = 'sk-super-secret-abcdefghijklmnop';

  const json = serialiseOpenCodeConfig();
  assert.ok(!json.includes('sk-super-secret-abcdefghijklmnop'), 'raw key must not be in config JSON');
  assert.ok(json.includes('CUSTOM_AI_API_KEY'), 'config references the env var name instead');
});

test('DEFAULT_MODEL=custom/model is reflected in config', () => {
  resetEnv();
  process.env.CUSTOM_AI_BASE_URL = 'https://example.com/v1';
  process.env.CUSTOM_AI_MODEL = 'my-model';
  process.env.CUSTOM_AI_PROVIDER = 'custom';
  process.env.DEFAULT_MODEL = 'custom/my-model';

  const cfg = buildOpenCodeConfig();
  assert.equal(cfg.model, 'custom/my-model');
  assert.ok(cfg.provider?.custom);
});

test('standard-provider-only setup produces an empty provider block', () => {
  resetEnv();
  process.env.OPENAI_API_KEY = 'sk-aaaaaaaaaaaaaaaaaaaaaaaa';
  const cfg = buildOpenCodeConfig();
  assert.equal(cfg.provider, undefined, 'no custom provider block when CUSTOM_AI_BASE_URL is unset');
  assert.equal(hasCustomAI(), false);
});

test('base URL without model → provider block but no models', () => {
  resetEnv();
  process.env.CUSTOM_AI_BASE_URL = 'https://example.com/v1';
  const cfg = buildOpenCodeConfig();
  assert.ok(cfg.provider);
  assert.equal(cfg.provider.custom.models, undefined);
});

test('validateEnv does not warn when custom endpoint is fully configured', () => {
  resetEnv();
  process.env.CUSTOM_AI_BASE_URL = 'https://example.com/v1';
  process.env.CUSTOM_AI_MODEL = 'my-model';
  process.env.CUSTOM_AI_API_KEY = 'sk-aaaaaaaaaaaaaaaaaaaaaaaa';
  let warned = false;
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...args) => {
    if (String(chunk).includes('No AI provider')) warned = true;
    return origWrite(chunk, ...args);
  };
  try { validateEnv(); } finally { process.stderr.write = origWrite; }
  assert.equal(warned, false);
});

test('validateEnv warns when nothing at all is configured', () => {
  resetEnv();
  let warned = false;
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const intercept = (chunk, ...args) => {
    if (String(chunk).includes('No AI provider')) warned = true;
    return true;
  };
  process.stdout.write = intercept;
  process.stderr.write = intercept;
  try { validateEnv(); } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  assert.equal(warned, true);
});

test('model IDs with spaces are sanitized for OpenCode keys', () => {
  resetEnv();
  process.env.CUSTOM_AI_BASE_URL = 'https://gpt-china.onrender.com/v1';
  process.env.CUSTOM_AI_MODEL = 'free way/gpt-5.6-luna';
  process.env.CUSTOM_AI_PROVIDER = 'custom';
  process.env.CUSTOM_AI_API_KEY = 'sk-test';

  const cfg = buildOpenCodeConfig();
  const p = cfg.provider.custom;
  assert.ok(p, 'provider exists');
  assert.ok(!Object.keys(p.models).some((k) => k.includes(' ')), 'no spaces in model keys');
  assert.ok(p.models['free-way/gpt-5.6-luna'] || p.models['free-way-gpt-5.6-luna'] || Object.keys(p.models).length === 1);
  const entry = Object.values(p.models)[0];
  // upstream id preserved when key was sanitized
  assert.ok(entry.id === 'free way/gpt-5.6-luna' || entry.name);
});

test('DEFAULT_MODEL with spaced model is normalized', () => {
  resetEnv();
  process.env.CUSTOM_AI_BASE_URL = 'https://example.com/v1';
  process.env.CUSTOM_AI_MODEL = 'free way/gpt-5.6-luna';
  process.env.CUSTOM_AI_PROVIDER = 'custom';
  process.env.DEFAULT_MODEL = 'custom/free way/gpt-5.6-luna';

  const cfg = buildOpenCodeConfig();
  assert.ok(cfg.model, 'model set');
  assert.ok(!cfg.model.includes(' '), `DEFAULT_MODEL sanitized, got ${cfg.model}`);
  assert.ok(cfg.model.startsWith('custom/'));
});

test('serialised config never contains the API key even with spaced model', () => {
  resetEnv();
  process.env.CUSTOM_AI_BASE_URL = 'https://example.com/v1';
  process.env.CUSTOM_AI_MODEL = 'free way/gpt-5.6-luna';
  process.env.CUSTOM_AI_API_KEY = 'sk-super-secret-spaced-model';
  const json = serialiseOpenCodeConfig();
  assert.ok(!json.includes('sk-super-secret-spaced-model'));
});
