import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import archiver from 'archiver';

const execFileAsync = promisify(execFile);

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-zip-'));
process.env.WORKSPACE_ROOT = tmpRoot;
process.env.CLOUDCODER_USERNAME = 'u';
process.env.CLOUDCODER_PASSWORD = 'p';
process.env.OPENCODE_SERVER_PASSWORD = 'o';
process.env.SESSION_SECRET = 'q'.repeat(64);

const { extractZip } = await import('../src/workspace/zip.js');

after(async () => { await fs.rm(tmpRoot, { recursive: true, force: true }); });

async function buildZip(entries, outPath) {
  const fsSync = await import('node:fs');
  await new Promise((resolve, reject) => {
    const output = fsSync.createWriteStream(outPath);
    const archive = archiver('zip');
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    for (const [name, content] of Object.entries(entries)) archive.append(content, { name });
    archive.finalize();
  });
  return outPath;
}

/** Build a zip that preserves raw entry names (including ../ and absolute paths). */
async function buildRawZip(entryName, content, outPath) {
  const py = `
import zipfile, sys
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    z.writestr(sys.argv[2], sys.argv[3].encode())
`;
  await execFileAsync('python3', ['-c', py, outPath, entryName, content]);
  return outPath;
}

test('extracts a normal zip', async () => {
  const zip = await buildZip({ 'a.txt': 'hello', 'dir/b.txt': 'world' }, path.join(tmpRoot, 'ok.zip'));
  const dest = await fs.mkdtemp(path.join(tmpRoot, 'out-'));
  const r = await extractZip(zip, dest);
  assert.equal(r.entries, 2);
  assert.equal(await fs.readFile(path.join(dest, 'a.txt'), 'utf8'), 'hello');
  assert.equal(await fs.readFile(path.join(dest, 'dir/b.txt'), 'utf8'), 'world');
});

test('rejects zip-slip traversal', async () => {
  const zip = await buildRawZip('../../escape.txt', 'pwned', path.join(tmpRoot, 'slip.zip'));
  const dest = await fs.mkdtemp(path.join(tmpRoot, 'out2-'));
  await assert.rejects(() => extractZip(zip, dest), /traversal|absolute|invalid relative path/i);
  assert.ok(!(await fs.access(path.join(tmpRoot, '..', 'escape.txt')).then(() => true, () => false)));
});

test('rejects absolute paths', async () => {
  const zip = await buildRawZip('/etc/passwd', 'x', path.join(tmpRoot, 'abs.zip'));
  const dest = await fs.mkdtemp(path.join(tmpRoot, 'out3-'));
  await assert.rejects(() => extractZip(zip, dest), /absolute/i);
});

test('enforces the entry cap', async () => {
  const entries = {};
  for (let i = 0; i < 30; i++) entries[`f${i}.txt`] = 'x';
  const zip = await buildZip(entries, path.join(tmpRoot, 'many.zip'));
  const dest = await fs.mkdtemp(path.join(tmpRoot, 'out4-'));
  await assert.rejects(() => extractZip(zip, dest, { maxEntries: 5 }), /more than 5 entries/);
});

test('enforces the byte cap', async () => {
  const zip = await buildZip({ 'big.txt': 'x'.repeat(100000) }, path.join(tmpRoot, 'big.zip'));
  const dest = await fs.mkdtemp(path.join(tmpRoot, 'out5-'));
  await assert.rejects(() => extractZip(zip, dest, { maxBytes: 1000 }), /expands beyond/);
});
