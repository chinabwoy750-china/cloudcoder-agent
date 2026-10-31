import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { listMediaCapabilities } from '../src/media/adapters.js';

test('media capabilities report china-gpt endpoints without inventing providers', () => {
  const caps = listMediaCapabilities();
  assert.ok(Array.isArray(caps.providers));
  const china = caps.providers.find((p) => p.id === 'china-gpt');
  assert.ok(china);
  assert.equal(china.endpoints.image, '/v1/image-generation');
  assert.equal(china.endpoints.video, '/v1/video-generation');
  assert.equal(china.endpoints.audio, '/v1/audio');
});

test('integration modules and routes are wired', () => {
  const app = fs.readFileSync(new URL('../src/server/app.js', import.meta.url), 'utf8');
  assert.match(app, /mediaRouter/);
  assert.match(app, /integrationsRouter/);
  const gh = fs.readFileSync(new URL('../src/server/routes/github.js', import.meta.url), 'utf8');
  assert.match(gh, /repos\/:owner\/:repo\/branches/);
  const figma = fs.readFileSync(new URL('../src/integrations/figma.js', import.meta.url), 'utf8');
  assert.match(figma, /status: 'groundwork'/);
});
