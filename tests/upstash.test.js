import test from 'node:test';
import assert from 'node:assert/strict';
import { isUpstashConfigured, redisGetJson, redisSetJson, redisPing } from '../src/storage/upstash.js';

test('Upstash adapter is disabled until URL and token are configured', () => {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  assert.equal(isUpstashConfigured(), false);
  if (url !== undefined) process.env.UPSTASH_REDIS_REST_URL = url;
  if (token !== undefined) process.env.UPSTASH_REDIS_REST_TOKEN = token;
});

test('Upstash adapter sends authenticated JSON commands and parses results', async () => {
  const oldUrl = process.env.UPSTASH_REDIS_REST_URL;
  const oldToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  const oldPrefix = process.env.UPSTASH_REDIS_PREFIX;
  const oldFetch = globalThis.fetch;
  const calls = [];
  process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-secret';
  process.env.UPSTASH_REDIS_PREFIX = 'test-app';
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    const command = JSON.parse(options.body)[0];
    return new Response(JSON.stringify({ result: command === 'GET' ? JSON.stringify({ hello: 'world' }) : command === 'PING' ? 'PONG' : 'OK' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    assert.equal(isUpstashConfigured(), true);
    await redisSetJson('runtime-settings', { hello: 'world' });
    assert.deepEqual(await redisGetJson('runtime-settings'), { hello: 'world' });
    assert.equal(await redisPing(), true);
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-secret');
    assert.deepEqual(calls[0].body, ['SET', 'test-app:runtime-settings', JSON.stringify({ hello: 'world' })]);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = oldUrl;
    if (oldToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = oldToken;
    if (oldPrefix === undefined) delete process.env.UPSTASH_REDIS_PREFIX; else process.env.UPSTASH_REDIS_PREFIX = oldPrefix;
  }
});

test('Upstash adapter rejects non-HTTPS endpoints', async () => {
  const oldUrl = process.env.UPSTASH_REDIS_REST_URL;
  const oldToken = process.env.UPSTASH_REDIS_REST_TOKEN;
  process.env.UPSTASH_REDIS_REST_URL = 'http://example.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-secret';
  try { await assert.rejects(redisPing(), /must use HTTPS/); }
  finally {
    if (oldUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL; else process.env.UPSTASH_REDIS_REST_URL = oldUrl;
    if (oldToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN; else process.env.UPSTASH_REDIS_REST_TOKEN = oldToken;
  }
});
