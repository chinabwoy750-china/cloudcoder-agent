import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../src/ui/index.html', import.meta.url), 'utf8');
const ui = fs.readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
const routes = fs.readFileSync(new URL('../src/server/routes/files.js', import.meta.url), 'utf8');

test('visual editor controls exist without removing preview and settings', () => {
  for (const id of ['visual-edit-toggle','visual-editor','visual-selector','visual-save','visual-reset']) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /id="preview-frame"/); assert.match(html, /data-view="settings"/);
});
test('visual selection messages are scoped to the preview iframe and selector-validated', () => {
  assert.match(ui, /event\.source !== frame\.contentWindow/);
  assert.match(ui, /um-visual-select/);
  assert.match(ui, /universal-modder-visual\.css/);
});
test('visual overrides are served from the workspace root', () => {
  assert.match(routes, /visual-overrides\.css/);
  assert.match(routes, /\.universal-modder-visual\.css/);
});
