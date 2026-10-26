import { test } from 'node:test';
import assert from 'node:assert';
import { redact } from '../src/utils/redact.js';

test('redacts OpenAI-style keys', () => {
  const out = redact('key sk-abcdefghijklmnopqrstuvwxyz123456');
  assert.ok(!out.includes('sk-abcdefghijklmnopqrstuvwxyz123456'));
  assert.ok(out.includes('[REDACTED]'));
});
test('redacts Anthropic keys', () => {
  assert.ok(!redact('ANTHROPIC_API_KEY=sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxx').includes('sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxxxx'));
});
test('redacts GitHub PATs', () => {
  assert.ok(!redact('token ghp_abcdefghijklmnopqrstuvwxyz0123456789').includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
  assert.ok(!redact('github_pat_11ABCDEFG0123456789_abcdefghijklmnop').includes('github_pat_11ABCDEFG0123456789_abcdefghijklmnop'));
});
test('redacts Telegram bot tokens', () => {
  const t = '1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
  assert.ok(!redact(`bot ${t}`).includes(t));
});
test('redacts Bearer tokens', () => {
  assert.ok(redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test').includes('[REDACTED]'));
});
test('redacts credentials in URLs', () => {
  assert.ok(!redact('https://user:secretpass@github.com/x/y.git').includes('secretpass'));
});
test('leaves normal text intact', () => {
  const s = 'Hello world, normal log line.';
  assert.equal(redact(s), s);
});
