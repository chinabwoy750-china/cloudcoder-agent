import { test, before } from 'node:test';
import assert from 'node:assert';

process.env.CLOUDCODER_USERNAME = 'admin';
process.env.CLOUDCODER_PASSWORD = 'secret123';
process.env.OPENCODE_SERVER_PASSWORD = 'internal';
process.env.SESSION_SECRET = 'x'.repeat(64);

const { basicAuth } = await import('../src/auth/basic.js');
const { signSession, verifySession, parseCookies } = await import('../src/auth/session.js');

function mockRes() {
  return {
    statusCode: 200, headers: {},
    set(k, v) { this.headers[k] = v; return this; },
    append(k, v) { (this.headers[k] ||= []).push(v); return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

test('rejects missing Authorization header', () => {
  const req = { headers: {}, method: 'GET', path: '/api' };
  const res = mockRes();
  let called = false;
  basicAuth(req, res, () => { called = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(called, false);
});

test('accepts valid credentials', () => {
  const creds = Buffer.from('admin:secret123').toString('base64');
  const req = { headers: { authorization: `Basic ${creds}` }, method: 'GET', path: '/api' };
  const res = mockRes();
  let called = false;
  basicAuth(req, res, () => { called = true; });
  assert.equal(called, true);
});

test('rejects wrong password', () => {
  const creds = Buffer.from('admin:wrong').toString('base64');
  const res = mockRes();
  let called = false;
  basicAuth({ headers: { authorization: `Basic ${creds}` }, method: 'GET', path: '/api' }, res, () => { called = true; });
  assert.equal(res.statusCode, 401);
  assert.equal(called, false);
});

test('session round-trips', () => {
  const token = signSession({ user: 'admin', exp: Date.now() + 10000 });
  const payload = verifySession(token);
  assert.equal(payload.user, 'admin');
});

test('tampered session is rejected', () => {
  const token = signSession({ user: 'admin', exp: Date.now() + 10000 });
  assert.equal(verifySession(token.slice(0, -2) + 'xx'), null);
});

test('expired session is rejected', () => {
  assert.equal(verifySession(signSession({ user: 'admin', exp: Date.now() - 1 })), null);
});

test('parses cookies', () => {
  const cookies = parseCookies({ headers: { cookie: 'a=1; cc_session=abc.def; b=2' } });
  assert.equal(cookies.cc_session, 'abc.def');
});
