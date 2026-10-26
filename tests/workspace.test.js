import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-ws-'));
process.env.WORKSPACE_ROOT = tmpRoot;
process.env.CLOUDCODER_USERNAME = 'u';
process.env.CLOUDCODER_PASSWORD = 'p';
process.env.OPENCODE_SERVER_PASSWORD = 'o';
process.env.SESSION_SECRET = 'z'.repeat(64);

const ws = await import('../src/workspace/manager.js');
const files = await import('../src/workspace/files.js');

after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

test('creates and resolves a workspace', async () => {
  const { id, dir } = await ws.createWorkspace();
  assert.equal(await ws.resolveWorkspace(id), dir);
});

test('rejects traversal ids', async () => {
  await assert.rejects(() => ws.resolveWorkspace('../../etc'), /not found|escapes root/);
});

test('resolveInside refuses traversal', async () => {
  const { dir } = await ws.createWorkspace();
  assert.throws(() => ws.resolveInside(dir, '../../etc/passwd'), /escapes workspace/);
  assert.ok(ws.resolveInside(dir, 'a/b.txt').startsWith(dir));
});

test('removes a workspace', async () => {
  const { id } = await ws.createWorkspace();
  await ws.removeWorkspace(id);
  await assert.rejects(() => ws.resolveWorkspace(id), /not found/);
});

test('lists workspaces', async () => {
  const { id } = await ws.createWorkspace();
  assert.ok((await ws.listWorkspaces()).includes(id));
  await ws.removeWorkspace(id);
});

test('write/read/list/delete files', async () => {
  const { id } = await ws.createWorkspace();
  await files.writeFile(id, 'src/a.txt', 'hello');
  const read = await files.readFile(id, 'src/a.txt');
  assert.equal(read.content.toString(), 'hello');
  const list = await files.listFiles(id);
  assert.ok(list.some((f) => f.path === 'src/a.txt'));
  await files.deleteFile(id, 'src/a.txt', { confirmed: true });
  await assert.rejects(() => files.readFile(id, 'src/a.txt'));
});

test('file deletion requires confirmation', async () => {
  const { id } = await ws.createWorkspace();
  await files.writeFile(id, 'x.txt', 'x');
  await assert.rejects(() => files.deleteFile(id, 'x.txt', {}), /confirmed=true/);
});

test('denies access to secret files', async () => {
  const { id } = await ws.createWorkspace();
  await files.writeFile(id, 'safe.txt', 'ok');
  await fs.writeFile(path.join(await ws.resolveWorkspace(id), '.env'), 'SECRET=1');
  await assert.rejects(() => files.readFile(id, '.env'), /not accessible/);
});

test('saveUpload sanitizes filenames', async () => {
  const { id } = await ws.createWorkspace();
  const r = await files.saveUpload(id, '../../evil.sh', Buffer.from('x'));
  assert.ok(!r.path.includes('..'));
  assert.ok(r.path.startsWith('evil.sh') || r.path.endsWith('evil.sh'));
});
