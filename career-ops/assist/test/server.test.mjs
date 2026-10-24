import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate token + rate state from the real service before importing anything.
const tmp = path.join(os.tmpdir(), `assist-test-${process.pid}`);
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
process.env.ASSIST_DATA = tmp;
process.env.ASSIST_TOKEN = 'test-token-abc123';
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const { createServer, ROUTES } = await import('../assist-server.mjs');
const { tokenEqual, rateLimit, resetRateLimits, tokenFingerprint, loadToken } = await import('../auth.mjs');

function listen(handlers = {}) {
  const srv = createServer(handlers);
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    resolve({ srv, base: `http://127.0.0.1:${port}`, close: () => srv.close() });
  }));
}
const AUTH = { Authorization: 'Bearer\u0020test-token-abc123' };

test('no route accepts a write verb — the core invariant of this service', () => {
  assert.ok(ROUTES.length > 0);
  for (const r of ROUTES) {
    assert.ok(['GET', 'POST'].includes(r.method), `${r.path} uses ${r.method}`);
    assert.equal(r.write, false, `${r.path} is marked as writing`);
  }
  // POST here means "I am sending a body". If a future route needs to mutate, it does not
  // belong in this service at all — the tracker keeps one writer.
  assert.equal(ROUTES.filter((r) => ['PUT', 'PATCH', 'DELETE'].includes(r.method)).length, 0);
});

test('/health is public and reports liveness without leaking user data', async () => {
  const { base, close } = await listen();
  const r = await fetch(base + '/health');
  const b = await r.json();
  close();
  assert.equal(r.status, 200);
  assert.equal(b.ok, true);
  assert.equal(b.app, 'career-ops-assist');
  // It may name the root path, but must not carry a token or profile content.
  assert.equal(JSON.stringify(b).includes('test-token'), false);
});

test('every non-health route rejects a missing or wrong token', async () => {
  const { base, close } = await listen({ application: (c) => c.json(200, { ok: true }) });
  const paths = ['/api/assist/application/1230', '/api/assist/context'];
  for (const p of paths) {
    assert.equal((await fetch(base + p)).status, 401, `${p} allowed an unauthenticated request`);
    assert.equal((await fetch(base + p, { headers: { Authorization: 'Bearer\u0020wrong' } })).status, 401);
  }
  const r = await fetch(base + '/api/assist/answers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  close();
  assert.equal(r.status, 401);
});

test('the token is accepted three ways — header, x-assist-token, and ?token=', async () => {
  const { base, close } = await listen({ application: (c) => c.json(200, { ok: true, ref: c.ref }) });
  const p = '/api/assist/application/1230';
  assert.equal((await fetch(base + p, { headers: AUTH })).status, 200);
  assert.equal((await fetch(base + p, { headers: { 'x-assist-token': 'test-token-abc123' } })).status, 200);
  // The query form exists because EventSource cannot set headers on a streaming GET.
  assert.equal((await fetch(base + p + '?token=test-token-abc123')).status, 200);
  close();
});

test('tokenEqual is exact and does not throw on length mismatch', () => {
  assert.ok(tokenEqual('abc', 'abc'));
  assert.equal(tokenEqual('abc', 'abd'), false);
  // Hashing to fixed width first matters: timingSafeEqual throws on differing lengths, and
  // catching that throw would leak the length through timing.
  assert.equal(tokenEqual('short', 'a-much-longer-token-value'), false);
  assert.equal(tokenEqual(undefined, 'x'), false);
  assert.ok(tokenEqual('', ''));
});

test('a persisted token survives a restart and is written 0600', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assist-tok-'));
  const prevData = process.env.ASSIST_DATA, prevTok = process.env.ASSIST_TOKEN;
  process.env.ASSIST_DATA = dir; delete process.env.ASSIST_TOKEN;
  const first = loadToken();
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(loadToken(), first, 'a second load must not mint a new token');
  const mode = fs.statSync(path.join(dir, 'assist-token.txt')).mode & 0o777;
  assert.equal(mode, 0o600, `token file is ${mode.toString(8)}, expected 600`);
  process.env.ASSIST_DATA = prevData; process.env.ASSIST_TOKEN = prevTok;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rate limiting is per token and recovers after the window', () => {
  resetRateLimits();
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) assert.ok(rateLimit('tokenA', 5, t0 + i).ok);
  assert.equal(rateLimit('tokenA', 5, t0 + 6).ok, false, '6th call in-window must be refused');
  assert.ok(rateLimit('tokenB', 5, t0 + 7).ok, 'a different token has its own budget');
  assert.ok(rateLimit('tokenA', 5, t0 + 61_000).ok, 'the window must reset');
});

test('a 429 carries Retry-After so a client can back off correctly', async () => {
  resetRateLimits();
  process.env.ASSIST_RATE_MAX = '2';
  const { base, close } = await listen({ context: (c) => c.json(200, { ok: true }) });
  let last;
  for (let i = 0; i < 4; i++) last = await fetch(base + '/api/assist/context', { headers: AUTH });
  close();
  delete process.env.ASSIST_RATE_MAX;
  resetRateLimits();
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get('retry-after')) > 0);
});

test('malformed JSON is a 400, not a 500', async () => {
  resetRateLimits();
  const { base, close } = await listen({ answers: (c) => c.json(200, { ok: true }) });
  const r = await fetch(base + '/api/assist/answers', {
    method: 'POST', headers: { ...AUTH, 'Content-Type': 'application/json' }, body: '{not json',
  });
  const b = await r.json();
  close();
  assert.equal(r.status, 400);
  assert.match(b.error, /JSON/);
});

test('an unbuilt handler returns 501, distinguishable from a wrong URL (404)', async () => {
  resetRateLimits();
  const { base, close } = await listen({});
  assert.equal((await fetch(base + '/api/assist/context', { headers: AUTH })).status, 501);
  assert.equal((await fetch(base + '/api/assist/nope', { headers: AUTH })).status, 404);
  close();
});

test('write verbs cannot reach any route', async () => {
  resetRateLimits();
  const { base, close } = await listen({ answers: (c) => c.json(200, { ok: true }) });
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const r = await fetch(base + '/api/assist/answers', { method, headers: AUTH });
    assert.ok([404, 405].includes(r.status), `${method} returned ${r.status}`);
  }
  close();
});

test('the token fingerprint used in logs is not reversible to the token', () => {
  const fp = tokenFingerprint('test-token-abc123');
  assert.equal(fp.length, 8);
  assert.equal(fp.includes('test'), false);
  assert.equal(tokenFingerprint('test-token-abc123'), fp, 'must be stable for log correlation');
});
