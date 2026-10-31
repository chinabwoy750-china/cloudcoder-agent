import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskPrompt, buildRepairPrompt } from '../src/agent/tasks.js';
import { diffFingerprints } from '../src/agent/verify.js';

test('buildTaskPrompt plan mode forbids file changes', () => {
  const p = buildTaskPrompt('Add a login page', 'plan', true);
  assert.match(p, /PLAN MODE/);
  assert.match(p, /Do not create, edit, delete/);
  assert.match(p, /Add a login page/);
});

test('buildTaskPrompt build mode asks for verification', () => {
  const p = buildTaskPrompt('Fix the navbar', 'build', true);
  assert.match(p, /BUILD MODE/);
  assert.match(p, /verification passed or failed/);
});

test('diffFingerprints detects added changed removed', () => {
  const before = [
    { path: 'a.js', size: 10, mtimeMs: 1 },
    { path: 'b.js', size: 10, mtimeMs: 1 },
  ];
  const after = [
    { path: 'a.js', size: 11, mtimeMs: 2 },
    { path: 'c.js', size: 5, mtimeMs: 3 },
  ];
  const d = diffFingerprints(before, after);
  assert.deepEqual(d.changed, ['a.js']);
  assert.deepEqual(d.added, ['c.js']);
  assert.deepEqual(d.removed, ['b.js']);
  assert.equal(d.totalTouched, 3);
});

test('buildRepairPrompt includes failure context', () => {
  const text = buildRepairPrompt({
    diff: { totalTouched: 2, changed: ['src/app.js'], added: [] },
    actions: [{ action: 'build', ok: false, results: [{ cmd: 'npm', code: 1, stderr: 'error TS' }] }],
    successCriteria: { reason: 'Verification command failed' },
  });
  assert.match(text, /BUILD REPAIR MODE/);
  assert.match(text, /src\/app\.js/);
  assert.match(text, /error TS/);
});
