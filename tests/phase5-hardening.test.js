import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const files = fs.readFileSync(new URL('../src/server/routes/files.js', import.meta.url), 'utf8');
const snapshots = fs.readFileSync(new URL('../src/workspace/snapshots.js', import.meta.url), 'utf8');
const settings = fs.readFileSync(new URL('../src/server/routes/settings.js', import.meta.url), 'utf8');
test('snapshot API requires explicit confirmation before destructive restore', () => {
  assert.match(files, /snapshots\/\:snapshotId\/restore/);
  assert.match(files, /req\.body\?\.confirm !== true/);
  assert.match(snapshots, /MAX_FILES = 1500/);
  assert.match(snapshots, /MAX_BYTES = 30 \* 1024 \* 1024/);
  assert.match(snapshots, /entry\.isSymbolicLink\(\)/);
});
test('snapshots skip dependency and git directories', () => {
  assert.match(snapshots, /new Set\(\['\.git', 'node_modules'/);
  assert.match(snapshots, /Snapshot does not belong to this workspace/);
});
test('diagnostics avoid returning credential values', () => {
  assert.match(settings, /router\.get\('\/diagnostics'/);
  assert.match(settings, /apiKeyConfigured: Boolean/);
  assert.doesNotMatch(settings.match(/router\.get\('\/diagnostics'[\s\S]*?\n  \}\);/)?.[0] || '', /apiKey:\s*process\.env/);
});
