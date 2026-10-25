import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createStore } from '../src/store.mjs';
import { createApp } from '../src/http.mjs';
import { createDevAuth } from '../src/dev-auth.mjs';

const quiet = fn => { const write = process.stderr.write; process.stderr.write = () => true; try { return fn(); } finally { process.stderr.write = write; } };
const req = (host, origin) => ({ headers: { host, ...(origin ? { origin } : {}) } });

test('dev auth is off unless DOODLE_DEV_AUTH=1', () => {
  for (const env of [{}, { DOODLE_DEV_AUTH: '' }, { DOODLE_DEV_AUTH: '0' }]) assert.equal(createDevAuth(env), null);
  assert.throws(() => quiet(() => createDevAuth({ DOODLE_DEV_AUTH: 'true' })), { code: 'DEV_AUTH_REFUSED' });
});

test('dev auth refuses production-like or non-loopback configuration at startup', () => {
  const on = { DOODLE_DEV_AUTH: '1' };
  assert.ok(createDevAuth(on));
  assert.ok(createDevAuth({ ...on, HOST: '127.0.0.1' }));
  assert.ok(createDevAuth({ ...on, HOST: '::1' }));
  assert.ok(createDevAuth({ ...on, HOST: 'localhost' }));
  for (const bad of [{ NODE_ENV: 'production' }, { PUBLIC_BASE_URL: 'https://doodle.example' }, { HOST: '0.0.0.0' }, { HOST: '192.168.1.5' }, { HOST: 'doodle.example' }, { HOST: '::' }]) {
    assert.throws(() => quiet(() => createDevAuth({ ...on, ...bad })), { code: 'DEV_AUTH_REFUSED' }, JSON.stringify(bad));
  }
});

test('dev identity needs a loopback Host and the exact same-origin Origin', () => {
  const auth = createDevAuth({ DOODLE_DEV_AUTH: '1' });
  const user = auth.identify(req('127.0.0.1:18190'));
  assert.match(user.id, /^\d+$/); assert.ok(user.displayName);
  assert.deepEqual(auth.identify(req('localhost:18190', 'http://localhost:18190')), user);
  assert.deepEqual(auth.identify(req('[::1]:18190')), user);
  assert.equal(auth.identify(req('doodle.example')), null, 'DNS rebinding: foreign Host');
  assert.equal(auth.identify(req('127.0.0.1.evil.example:18190')), null);
  assert.equal(auth.identify(req('127.0.0.1:18190', 'http://127.0.0.1:3000')), null, 'another local port is another origin');
  assert.equal(auth.identify(req('127.0.0.1:18190', 'https://evil.example')), null);
  assert.equal(auth.identify({ headers: {} }), null);
  assert.equal(auth.allowsOrigin('http://127.0.0.1:18190'), true);
  assert.equal(auth.allowsOrigin('http://evil.example'), false);
  assert.equal(auth.allowsOrigin('https://127.0.0.1'), false);
});

test('http serves the synthetic user without Telegram data and still rejects foreign callers', async t => {
  const store = createStore({ dbPath: ':memory:', masterKey: Buffer.alloc(32, 5) });
  const devAuth = createDevAuth({ DOODLE_DEV_AUTH: '1' });
  const server = createApp({ store, config: { botToken: '', publicBaseUrl: '', version: 'fixture' }, devAuth });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, headers = {}) => fetch(base + path, { headers }).then(async r => ({ status: r.status, body: await r.json() }));
  const me = await call('/api/v1/me', { origin: base });
  assert.equal(me.status, 200); assert.equal(me.body.user.displayName, 'Локальный разработчик');
  assert.equal((await call('/api/v1/me', { origin: 'http://127.0.0.1:1' })).status, 401, 'foreign local origin is not the dev user');
  assert.equal((await call('/api/v1/me', { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('/api/v1/me', { 'x-telegram-init-data': 'broken' })).status, 401, 'present Telegram data is never replaced');
  const off = createApp({ store, config: { botToken: '', publicBaseUrl: '', version: 'fixture' } });
  off.listen(0, '127.0.0.1'); await once(off, 'listening');
  t.after(() => new Promise(resolve => off.close(resolve)));
  assert.equal((await fetch(`http://127.0.0.1:${off.address().port}/api/v1/me`).then(r => r.status)), 401, 'no flag, no dev user');
});
