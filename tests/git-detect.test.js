import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectProjectType } from '../src/git/detect.js';

let tmp;
before(async () => { tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-detect-')); });
after(async () => { await fs.rm(tmp, { recursive: true, force: true }); });

async function mk(name, contents) {
  const dir = path.join(tmp, name);
  await fs.mkdir(dir, { recursive: true });
  for (const [file, body] of Object.entries(contents)) await fs.writeFile(path.join(dir, file), body);
  return dir;
}

test('detects Node.js', async () => {
  const r = await detectProjectType(await mk('node', { 'package.json': '{}', 'package-lock.json': '{}' }));
  assert.equal(r.type, 'node');
  assert.equal(r.packageManager, 'npm');
});
test('detects Next.js', async () => {
  assert.equal((await detectProjectType(await mk('next', { 'package.json': '{}', 'next.config.js': '' }))).type, 'node-next');
});
test('detects Vite', async () => {
  assert.equal((await detectProjectType(await mk('vite', { 'package.json': '{}', 'vite.config.ts': '' }))).type, 'node-vite');
});
test('detects Python + poetry', async () => {
  const r = await detectProjectType(await mk('py', { 'pyproject.toml': '', 'poetry.lock': '' }));
  assert.equal(r.type, 'python');
  assert.equal(r.packageManager, 'poetry');
});
test('detects Go', async () => {
  assert.equal((await detectProjectType(await mk('go', { 'go.mod': 'module x' }))).type, 'go');
});
test('detects Rust', async () => {
  assert.equal((await detectProjectType(await mk('rs', { 'Cargo.toml': '' }))).type, 'rust');
});
test('detects Maven', async () => {
  assert.equal((await detectProjectType(await mk('mvn', { 'pom.xml': '' }))).type, 'java-maven');
});
test('detects PHP', async () => {
  assert.equal((await detectProjectType(await mk('php', { 'composer.json': '{}' }))).type, 'php');
});
test('detects static site', async () => {
  assert.equal((await detectProjectType(await mk('static', { 'index.html': '<html></html>' }))).type, 'static');
});
test('returns unknown for empty dir', async () => {
  assert.equal((await detectProjectType(await mk('empty', {}))).type, 'unknown');
});
