import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
const agent = fs.readFileSync(new URL('../src/server/routes/agent.js', import.meta.url), 'utf8');

test('snapshot UI controls exist', () => {
  assert.match(html, /id="snapshot-list"/);
  assert.match(html, /id="btn-snapshot"/);
  assert.match(ui, /refreshSnapshots/);
  assert.match(ui, /snapshots\/\$\{encodeURIComponent\(s\.id\)\}\/restore/);
});

test('agent build mode creates pre-agent snapshot', () => {
  assert.match(agent, /createWorkspaceSnapshot/);
  assert.match(agent, /pre-agent/);
});

test('visual text field and persistence path exist', () => {
  assert.match(html, /id="visual-text"/);
  assert.match(ui, /universal-modder-visual-text\.json/);
});
