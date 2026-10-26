import { test, before, after } from 'node:test';
import assert from 'node:assert';

process.env.CLOUDCODER_USERNAME = 'testuser';
process.env.CLOUDCODER_PASSWORD = 'testpass';
process.env.OPENCODE_SERVER_PASSWORD = 'test-opencode-pass';
process.env.SESSION_SECRET = 'y'.repeat(64);

const { createApp } = await import('../src/server/app.js');

let server, base;
before(async () => {
  const app = createApp();
  await new Promise((r) => {
    server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); });
  });
});
after(() => server?.close());

test('GET /health reports not-ready when OpenCode is down', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.service, 'cloudcoder-agent');
  assert.equal(body.opencode, 'not-ready');
});

test('GET /api/status requires auth', async () => {
  assert.equal((await fetch(`${base}/api/status`)).status, 401);
});

test('GET /api/status works with basic auth', async () => {
  const creds = Buffer.from('testuser:testpass').toString('base64');
  const res = await fetch(`${base}/api/status`, { headers: { Authorization: `Basic ${creds}` } });
  assert.equal(res.status, 200);
});

test('login sets a session cookie and /api/auth/me accepts it', async () => {
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'testuser', password: 'testpass' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.ok(cookie.includes('cc_session='));
  const me = await fetch(`${base}/api/auth/me`, { headers: { Cookie: cookie.split(';')[0] } });
  assert.equal(me.status, 200);
});

test('login rejects bad credentials', async () => {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'testuser', password: 'nope' }),
  });
  assert.equal(res.status, 401);
});
