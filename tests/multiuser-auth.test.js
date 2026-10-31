import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/db/users.js';
import { signSession, verifySession } from '../src/auth/session.js';
import { config } from '../src/config/env.js';

test('password hash verifies and rejects wrong password', () => {
  const { salt, hash } = hashPassword('correct-horse-battery-staple');
  assert.equal(verifyPassword('correct-horse-battery-staple', salt, hash), true);
  assert.equal(verifyPassword('wrong-password-here', salt, hash), false);
});

test('session cookie payload round-trips multi-user identity', () => {
  // signSession uses config.session.secret — ensure tests have something set
  if (!config.session?.secret) {
    process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-value-32chars!!';
  }
  const tokenParts = signSession({
    user: { id: '11111111-1111-1111-1111-111111111111', username: 'alice', role: 'user' },
    exp: Date.now() + 60_000,
  });
  const payload = verifySession(tokenParts);
  assert.ok(payload);
  assert.equal(payload.user.username, 'alice');
  assert.equal(payload.user.role, 'user');
  assert.equal(payload.user.id, '11111111-1111-1111-1111-111111111111');
});

test('expired session is rejected', () => {
  const token = signSession({
    user: { id: null, username: 'bob', role: 'admin' },
    exp: Date.now() - 1000,
  });
  assert.equal(verifySession(token), null);
});
