import { test, before, after } from 'node:test';
import assert from 'node:assert';

process.env.CLOUDCODER_USERNAME = 'sec';
process.env.CLOUDCODER_PASSWORD = 'secpass';
process.env.OPENCODE_SERVER_PASSWORD = 'o';
process.env.SESSION_SECRET = 's'.repeat(64);

const { createApp } = await import('../src/server/app.js');

let server, base;
before(async () => {
  const app = createApp();
  await new Promise((r) => {
    server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); });
  });
});
after(() => server?.close());

const basic = 'Basic ' + Buffer.from('sec:secpass').toString('base64');

test('security headers are present', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.ok(res.headers.get('content-security-policy').includes("default-src 'self'"));
});

test('cross-origin requests are rejected', async () => {
  const res = await fetch(`${base}/health`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(res.status, 403);
});

test('cookie-authenticated mutation without CSRF header is rejected', async () => {
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'sec', password: 'secpass' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const res = await fetch(`${base}/api/workspaces`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(res.status, 403);
});

test('cookie-authenticated mutation with CSRF header succeeds', async () => {
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'sec', password: 'secpass' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const res = await fetch(`${base}/api/workspaces`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-CloudCoder-CSRF': '1' },
    body: '{}',
  });
  assert.equal(res.status, 201);
});

test('oversized JSON body is rejected', async () => {
  const res = await fetch(`${base}/api/status`, {
    method: 'GET',
    headers: { Authorization: basic, 'Content-Type': 'application/json' },
  });
  assert.equal(res.status, 200);
  const big = await fetch(`${base}/api/workspaces`, {
    method: 'POST',
    headers: { Authorization: basic, 'Content-Type': 'application/json' },
    body: JSON.stringify({ pad: 'x'.repeat(3 * 1024 * 1024) }),
  });
  assert.equal(big.status, 413);
});

test('path traversal in file read is blocked', async () => {
  const create = await fetch(`${base}/api/workspaces`, {
    method: 'POST', headers: { Authorization: basic, 'Content-Type': 'application/json' }, body: '{}',
  });
  const { workspaceId } = await create.json();
  const res = await fetch(`${base}/api/workspaces/${workspaceId}/file?path=${encodeURIComponent('../../etc/passwd')}`, {
    headers: { Authorization: basic },
  });
  assert.equal(res.status, 400);
});

test('delete requires explicit confirmation', async () => {
  const create = await fetch(`${base}/api/workspaces`, {
    method: 'POST', headers: { Authorization: basic, 'Content-Type': 'application/json' }, body: '{}',
  });
  const { workspaceId } = await create.json();
  const res = await fetch(`${base}/api/workspaces/${workspaceId}`, {
    method: 'DELETE', headers: { Authorization: basic },
  });
  assert.equal(res.status, 400);
});

test('GitHub routes return 503 without a token', async () => {
  const res = await fetch(`${base}/api/github/me`, { headers: { Authorization: basic } });
  assert.equal(res.status, 503);
});

test('rate limiting kicks in', async () => {
  let limited = false;
  for (let i = 0; i < 40; i++) {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'x', password: 'y' }),
    });
    if (res.status === 429) { limited = true; break; }
  }
  assert.ok(limited, 'expected a 429 after repeated failed logins');
});
