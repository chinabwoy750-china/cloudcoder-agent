import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskPrompt } from '../src/agent/tasks.js';

test('plan mode asks for analysis without file mutations', () => {
  const prompt = buildTaskPrompt('Add a login page', 'plan', true);
  assert.match(prompt, /PLAN MODE/);
  assert.match(prompt, /Do not create, edit, delete, or overwrite files/);
  assert.match(prompt, /Add a login page/);
  assert.doesNotMatch(prompt, /then execute it in the workspace/);
});

test('build mode asks to implement and verify', () => {
  const prompt = buildTaskPrompt('Fix the build', 'build', true);
  assert.match(prompt, /BUILD MODE/);
  assert.match(prompt, /Implement the user request/);
  assert.match(prompt, /run appropriate tests or builds/);
  assert.match(prompt, /then execute it in the workspace/);
});

test('unknown mode safely defaults to build', () => {
  assert.match(buildTaskPrompt('Do work', 'other', false), /BUILD MODE/);
});
