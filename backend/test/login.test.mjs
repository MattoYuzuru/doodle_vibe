import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.mjs';
import { createApp } from '../src/http.mjs';
import { createBrowserFactory } from '../src/login/browser.mjs';
import { createLoginSessionManager } from '../src/login/session-manager.mjs';
import { loginPresetFor } from '../src/login/presets.mjs';
import { createLoginRoutes } from '../src/login/routes.mjs';
import { createHostPolicy } from '../src/login/policy.mjs';
import { startEgressProxy } from '../src/login/egress-proxy.mjs';
import { startFixture, connectStream, USER, PASSWORD, OTP, CALENDAR_TOKEN } from './fixtures/login/servers.mjs';

// Real Chromium against a synthetic HTTPS fixture on loopback. Nothing here touches a
// university: hosts are mapped to the fixture inside the egress proxy.
const masterKey = Buffer.alloc(32, 21);
const chromium = createBrowserFactory().available();
const skip = !chromium && process.env.REQUIRE_CHROMIUM !== '1' ? 'Chromium is not installed (set REQUIRE_CHROMIUM=1 to turn this into a failure)' : false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, ms = 40_000) {
  const end = Date.now() + ms;
  for (;;) { const value = await fn(); if (value) return value; if (Date.now() > end) throw new Error('timeout waiting for condition'); await sleep(100); }
}
async function environment(t, fixtureOptions = {}, limits = {}, { sourceUrl = 'https://edu.hse.ru/', presetFor, learn } = {}) {
  const fixture = await startFixture(fixtureOptions);
  const dir = mkdtempSync(join(tmpdir(), 'doodle-login-test-'));
  const dbPath = join(dir, 'state.sqlite');
  const store = createStore({ dbPath, masterKey });
  store.ensureUser({ id: 'u1', displayName: 'U1' }); store.ensureUser({ id: 'u2', displayName: 'U2' });
  const space = store.createSpace('u1', { universityId: 'x', name: 'X' });
  const manager = createLoginSessionManager({ store, factory: createBrowserFactory(fixture.factoryOptions), limits, presetFor, learn });
  t.after(async () => { await manager.close(); await fixture.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const connection = store.createConnection('u1', space.id, { sourceUrl, kind: 'lms' });
  const wait = (id, statuses) => until(() => { const login = manager.get('u1', id); return statuses.includes(login.status) ? login : null; });
  return { fixture, store, manager, connection, space, dbPath, dir, wait };
}
const password = { mode: 'password', username: USER, password: PASSWORD };
const bytes = path => (existsSync(path) ? readFileSync(path) : Buffer.alloc(0));
function assertNoPlaintext(e, ...secrets) {
  for (const file of [e.dbPath, `${e.dbPath}-wal`, `${e.dbPath}-shm`]) for (const secret of secrets) assert.ok(!bytes(file).includes(Buffer.from(secret)), `${file} must not contain ${secret.slice(0, 4)}…`);
}

test('host policy: exact hosts, suffixes, IP literals and the distinct-host cap', () => {
  const policy = createHostPolicy({ hosts: ['edu.hse.ru', '*.sso.example.ru'], suffixes: ['uni.ru'], maxHosts: 3 });
  for (const host of ['edu.hse.ru', 'EDU.HSE.RU.', 'a.sso.example.ru', 'uni.ru', 'lms.uni.ru']) assert.equal(policy.allows(host, { contact: false }), true, host);
  for (const host of ['evil.example', 'hse.ru', 'edu.hse.ru.evil.example', '127.0.0.1', '[::1]', 'localhost', 'a b.uni.ru', 'sso.example.ru']) assert.equal(policy.allows(host, { contact: false }), false, host);
  assert.equal(policy.allows('edu.hse.ru'), true); assert.equal(policy.allows('a.uni.ru'), true); assert.equal(policy.allows('b.uni.ru'), true);
  assert.equal(policy.allows('c.uni.ru'), false, 'fourth distinct host is refused');
  assert.equal(policy.allows('a.uni.ru'), true, 'known host stays allowed');
});

test('egress proxy: CONNECT only, allowlisted public hosts, pinned address, no IP literals or other ports', async t => {
  const upstream = net.createServer(socket => socket.end('hello')); await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const dialed = [];
  const proxy = await startEgressProxy({ policy: createHostPolicy({ hosts: ['edu.hse.ru', 'private.hse.ru'] }),
    resolver: async host => [{ address: host === 'private.hse.ru' ? '10.0.0.5' : '93.184.216.34', family: 4 }],
    dial: (address, port, host) => { dialed.push([address, port, host]); return net.connect(upstream.address().port, '127.0.0.1'); } });
  t.after(async () => { await proxy.close(); upstream.close(); });
  const connect = target => new Promise(resolve => {
    const socket = net.connect(proxy.port, '127.0.0.1', () => socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    let data = ''; socket.on('data', chunk => { data += chunk; if (data.includes('hello') || /\r\n\r\n$/.test(data) && !data.includes('200')) socket.destroy(); }); socket.on('close', () => resolve(data));
  });
  assert.match(await connect('edu.hse.ru:443'), /^HTTP\/1\.1 200[\s\S]*hello/);
  assert.deepEqual(dialed, [['93.184.216.34', 443, 'edu.hse.ru']]);
  for (const target of ['evil.example:443', 'edu.hse.ru:80', '127.0.0.1:443', 'private.hse.ru:443', 'edu.hse.ru:443@evil.example']) assert.match(await connect(target), /^HTTP\/1\.1 403/, target);
  assert.equal(dialed.length, 1); assert.equal(proxy.stats.allowed, 1); assert.ok(proxy.stats.denied >= 5);
  const plain = await fetch(`http://127.0.0.1:${proxy.port}/`).then(r => r.status); assert.equal(plain, 403);
});

test('unavailable runtime answers LOGIN_UNAVAILABLE and offers no login methods', async () => {
  const store = createStore({ dbPath: ':memory:', masterKey });
  store.ensureUser({ id: 'u1', displayName: 'U' });
  const space = store.createSpace('u1', { universityId: 'x', name: 'X' });
  const connection = store.createConnection('u1', space.id, { sourceUrl: 'https://edu.hse.ru/', kind: 'lms' });
  const manager = createLoginSessionManager({ store, factory: { available: () => false, open: async () => { throw new Error('must not launch'); } } });
  assert.deepEqual(manager.capabilities(), { interactive: false, password: false });
  assert.deepEqual(manager.authMethods(connection), []);
  await assert.rejects(manager.start('u1', connection.id, { mode: 'interactive' }), { code: 'LOGIN_UNAVAILABLE', status: 409 });
  await assert.rejects(manager.start('u1', connection.id, password), { code: 'LOGIN_UNAVAILABLE' });
  await assert.rejects(manager.start('u2', connection.id, { mode: 'interactive' }), { status: 404 });
  const withFactory = createLoginSessionManager({ store, factory: { available: () => true, open: async () => { throw new Error('boom'); } } });
  assert.deepEqual(withFactory.authMethods(connection).map(m => m.id), ['sso_password', 'remote_login']);
  const other = store.createConnection('u1', space.id, { sourceUrl: 'https://lms.unknown-uni.ru/', kind: 'lms' });
  assert.deepEqual(withFactory.authMethods(other).map(m => m.id), ['remote_login']);
  await assert.rejects(withFactory.start('u1', other.id, password), { code: 'LOGIN_UNAVAILABLE' }, 'password mode needs a preset');
  const failing = await withFactory.start('u1', connection.id, { mode: 'interactive' });
  await until(() => withFactory.get('u1', failing.id).status === 'failed');
  assert.equal(store.getConnection('u1', connection.id).status, 'user_action_required');
  store.close();
});

test('password login without MFA stores an encrypted session and never the password', { skip }, async t => {
  const e = await environment(t);
  const started = await e.manager.start('u1', e.connection.id, { ...password, keepCalendar: true });
  assert.equal(started.mode, 'password'); assert.ok(['starting', 'filling'].includes(started.status));
  assert.ok(!JSON.stringify(started).includes(PASSWORD));
  const login = await e.wait(started.id, ['succeeded', 'failed']);
  assert.equal(login.status, 'succeeded', login.errorCode);
  const secret = e.store.readSecret('u1', e.connection.id);
  assert.equal(secret.origin, 'https://edu.hse.ru');
  assert.equal(secret.session.version, 2);
  const moodle = secret.session.cookies.find(c => c.name === 'MoodleSession');
  assert.ok(moodle && moodle.secure && moodle.httpOnly && moodle.domain === 'edu.hse.ru');
  assert.ok(secret.session.cookies.every(c => ['edu.hse.ru', 'saml.hse.ru'].includes(c.domain.replace(/^\./, ''))));
  assert.ok(Date.parse(secret.session.expiresAt) > Date.now() && Date.parse(secret.session.expiresAt) <= Date.now() + 12 * 3600_000 + 1000);
  assert.match(secret.session.calendarUrl, new RegExp(`^https://edu\\.hse\\.ru/calendar/export_execute\\.php\\?.*authtoken=${CALENDAR_TOKEN}`));
  assert.equal(secret.calendarUrl, secret.session.calendarUrl);
  assert.equal(e.store.getConnection('u1', e.connection.id).status, 'pending');
  assert.equal(e.store.claimJob('w').type, 'sync');
  assert.equal(e.manager.active('u1', e.connection.id), null);
  assert.ok(!JSON.stringify(e.manager.get('u1', started.id)).includes(PASSWORD));
  assertNoPlaintext(e, PASSWORD, USER, moodle.value, CALENDAR_TOKEN);
  assert.equal(e.fixture.state.hits['evil.example'] ?? 0, 0);
});

test('password login with MFA: pause, wrong code keeps the context, right code finishes; code is never stored', { skip }, async t => {
  const e = await environment(t, { mfa: true });
  const started = await e.manager.start('u1', e.connection.id, password);
  const waiting = await e.wait(started.id, ['awaiting_mfa', 'failed']);
  assert.equal(waiting.status, 'awaiting_mfa'); assert.deepEqual(waiting.mfa, { kind: 'totp', attemptsLeft: 3 });
  assert.equal(waiting.url, 'https://saml.hse.ru/realms/hse/login-actions/authenticate');
  assert.equal(e.manager.active('u1', e.connection.id)?.id, started.id);
  await assert.rejects(e.manager.submitMfa('u2', started.id, OTP), { status: 404 });
  await assert.rejects(e.manager.submitMfa('u1', started.id, 'x'), { code: 'INVALID_INPUT' });
  await e.manager.submitMfa('u1', started.id, '000000');
  const retry = await e.wait(started.id, ['awaiting_mfa', 'failed']);
  assert.equal(retry.status, 'awaiting_mfa'); assert.equal(retry.mfa.attemptsLeft, 2);
  await assert.rejects(e.manager.submitMfa('u1', 'nope', OTP), { status: 404 });
  await e.manager.submitMfa('u1', started.id, OTP);
  const done = await e.wait(started.id, ['succeeded', 'failed']);
  assert.equal(done.status, 'succeeded', done.errorCode);
  assert.ok(e.store.readSecret('u1', e.connection.id).session.cookies.some(c => c.name === 'MoodleSession'));
  assert.equal(e.fixture.state.passwordPosts, 1, 'the password was submitted exactly once');
  assertNoPlaintext(e, PASSWORD, USER, OTP);
  await assert.rejects(e.manager.submitMfa('u1', started.id, OTP), { code: 'LOGIN_NOT_WAITING_MFA' });
});

test('three wrong codes fail with mfa_failed; an unanswered code expires and destroys the context', { skip }, async t => {
  const e = await environment(t, { mfa: true }, { mfaMs: 1500 });
  const first = await e.manager.start('u1', e.connection.id, password);
  await e.wait(first.id, ['awaiting_mfa']);
  for (const code of ['111111', '222222', '333333']) { await e.wait(first.id, ['awaiting_mfa']); await e.manager.submitMfa('u1', first.id, code); await until(() => e.manager.get('u1', first.id).status !== 'filling'); }
  const failed = e.manager.get('u1', first.id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.errorCode, 'mfa_failed');
  assert.equal(e.store.getConnection('u1', e.connection.id).errorCode, 'mfa_failed');
  const second = await e.manager.start('u1', e.connection.id, password);
  await e.wait(second.id, ['awaiting_mfa']);
  const expired = await e.wait(second.id, ['expired']);
  assert.equal(expired.errorCode, 'mfa_expired');
  await assert.rejects(e.manager.submitMfa('u1', second.id, OTP), { code: 'LOGIN_NOT_WAITING_MFA' });
});

test('wrong password fails with source_login_failed, marks the connection and triggers the cooldown', { skip }, async t => {
  const e = await environment(t);
  for (let attempt = 0; attempt < 3; attempt++) {
    const started = await e.manager.start('u1', e.connection.id, { ...password, password: 'wrong-password-value' });
    const login = await e.wait(started.id, ['failed', 'succeeded']);
    assert.equal(login.errorCode, 'source_login_failed');
  }
  assert.equal(e.store.getConnection('u1', e.connection.id).errorCode, 'source_login_failed');
  assert.equal(e.store.readSecret('u1', e.connection.id), null);
  await assert.rejects(e.manager.start('u1', e.connection.id, password), { code: 'LOGIN_COOLDOWN', status: 429 });
  assertNoPlaintext(e, 'wrong-password-value');
});

test('bot protection or an unknown login page hands the browser to the person; nothing is bypassed', { skip }, async t => {
  const e = await environment(t, { bot: true });
  const started = await e.manager.start('u1', e.connection.id, password);
  const login = await e.wait(started.id, ['awaiting_user', 'failed']);
  assert.equal(login.status, 'awaiting_user'); assert.equal(login.errorCode, 'source_bot_protection');
  assert.ok(login.idleExpiresAt);
  assert.equal(e.fixture.state.passwordPosts, 0, 'the password was not typed into a captcha page');
  assert.equal((await e.manager.cancel('u1', started.id)).status, 'cancelled');
  const e2 = await environment(t, { unknown: true }, { fillingMs: 4000 });
  const unknown = await e2.manager.start('u1', e2.connection.id, password);
  const result = await e2.wait(unknown.id, ['failed', 'awaiting_user', 'succeeded', 'expired']);
  assert.equal(result.status, 'awaiting_user'); assert.equal(result.errorCode, 'source_login_unrecognized');
  assert.equal(e2.fixture.state.passwordPosts, 0);
});

test('redirects to a foreign host are blocked by the egress proxy, not just by routing', { skip }, async t => {
  const e = await environment(t);
  const handle = await createBrowserFactory(e.fixture.factoryOptions).open({ policy: createHostPolicy({ hosts: ['edu.hse.ru'] }) });
  t.after(() => handle.close());
  await handle.page.goto('https://edu.hse.ru/redirect-away', { timeout: 15_000 }).catch(() => {});
  assert.equal(e.fixture.state.hits['evil.example'] ?? 0, 0);
  assert.equal(await handle.page.goto('https://evil.example/', { timeout: 10_000 }).catch(() => 'blocked'), 'blocked');
  assert.equal(handle.proxy.stats.denied > 0, true);
  assert.equal(e.fixture.state.hits['evil.example'] ?? 0, 0);
  assert.ok(!(handle.safeUrl() ?? '').includes('?'));
});

test('one session per user: a new start cancels the previous, capacity and rate limits answer 429', { skip }, async t => {
  const e = await environment(t, {}, { maxSessions: 1, startsPerMinute: 4 });
  const first = await e.manager.start('u1', e.connection.id, { mode: 'interactive' });
  await e.wait(first.id, ['awaiting_user']);
  const second = await e.manager.start('u1', e.connection.id, { mode: 'interactive' });
  assert.equal(e.manager.get('u1', first.id).status, 'cancelled');
  await e.wait(second.id, ['awaiting_user']);
  assert.equal(e.manager.active('u1', e.connection.id).id, second.id);
  const other = e.store.createConnection('u2', e.store.createSpace('u2', { universityId: 'y', name: 'Y' }).id, { sourceUrl: 'https://edu.hse.ru/', kind: 'lms' });
  await assert.rejects(e.manager.start('u2', other.id, { mode: 'interactive' }), { code: 'LOGIN_BUSY', status: 429 });
  assert.throws(() => e.manager.get('u2', second.id), { status: 404 });
  await e.manager.start('u1', e.connection.id, { mode: 'interactive' }); await e.manager.start('u1', e.connection.id, { mode: 'interactive' });
  await assert.rejects(e.manager.start('u1', e.connection.id, { mode: 'interactive' }), { code: 'RATE_LIMITED', status: 429 });
  await e.manager.cancelForConnection(e.connection.id);
  assert.equal(e.manager.active('u1', e.connection.id), null);
});

test('interactive login through the stream: ticket, frames, keyboard input, automatic capture', { skip }, async t => {
  const e = await environment(t);
  const store = e.store;
  const server = createApp({ store, config: { botToken: 'fixture-bot-token-only', publicBaseUrl: 'https://doodle.example', version: 'x' }, login: e.manager,
    loginRoutes: createLoginRoutes({ login: e.manager, config: { publicBaseUrl: 'https://doodle.example' } }), devAuth: { identify: () => ({ id: 'u1', displayName: 'U1' }) } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port; const base = `http://127.0.0.1:${port}`;
  const call = async (path, method = 'GET', body) => { const r = await fetch(base + path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
  const started = await call(`/api/v1/connections/${e.connection.id}/login`, 'POST', { mode: 'interactive' });
  assert.equal(started.status, 201); const id = started.body.login.id;
  assert.equal((await call(`/api/v1/connections/${e.connection.id}/login`, 'POST', { mode: 'interactive', password: 'x' })).status, 400);
  assert.equal((await call(`/api/v1/connections/${e.connection.id}/login`, 'POST', { mode: 'sideways' })).status, 409);
  await e.wait(id, ['awaiting_user']);
  const detail = await call(`/api/v1/connections/${e.connection.id}`);
  assert.equal(detail.body.login.id, id);
  const ticket = (await call(`/api/v1/login/${id}/ticket`, 'POST', {})).body;
  assert.match(ticket.ticket, /^[A-Za-z0-9_-]{20,}$/); assert.equal(ticket.path, `/api/v1/login/${id}/stream`);
  assert.equal((await connectStream({ port, path: `${ticket.path}?ticket=${ticket.ticket}`, origin: 'https://attacker.example' })).status, 403);
  const fresh = ticket; // a refused origin must not burn the ticket, a successful upgrade must
  const live = await connectStream({ port, path: `${fresh.path}?ticket=${fresh.ticket}`, origin: 'https://doodle.example' });
  assert.equal(live.status, 101); t.after(() => live.close());
  const hello = await live.waitFor(f => f.opcode === 1 && JSON.parse(f.data).type === 'hello');
  assert.deepEqual(Object.keys(JSON.parse(hello.data)).sort(), ['height', 'type', 'width']);
  const frame = await live.waitFor(f => f.opcode === 2); assert.deepEqual([...frame.data.subarray(0, 2)], [0xff, 0xd8]);
  assert.equal((await connectStream({ port, path: `${fresh.path}?ticket=${fresh.ticket}`, origin: 'https://doodle.example' })).status, 401, 'tickets are single use');
  // Keyboard-only sign in, exactly what a person does in the frame.
  live.send({ type: 'text', text: USER }); live.send({ type: 'key', action: 'down', key: 'Tab' }); live.send({ type: 'key', action: 'up', key: 'Tab' });
  live.send({ type: 'text', text: PASSWORD }); live.send({ type: 'key', action: 'down', key: 'Enter' }); live.send({ type: 'key', action: 'up', key: 'Enter' });
  const finished = await until(() => { const l = e.manager.get('u1', id); return ['succeeded', 'failed', 'expired'].includes(l.status) ? l : null; });
  assert.equal(finished.status, 'succeeded', finished.errorCode);
  await live.waitFor(f => f.opcode === 1 && JSON.parse(f.data).type === 'closed');
  assert.ok(e.store.readSecret('u1', e.connection.id).session.cookies.some(c => c.name === 'MoodleSession'));
  assertNoPlaintext(e, PASSWORD, USER);
  assert.equal((await call(`/api/v1/login/${id}/cancel`, 'POST', {})).status, 200);
  assert.equal((await call('/api/v1/login/missing')).status, 404);
});

test('interactive login on a bearer-token SPA stores the observed Authorization token with its expiry', { skip }, async t => {
  // A university whose SPA sends a bearer token: success needs the observed Authorization header, not a probe.
  const bearerPreset = origin => ({ ...loginPresetFor(origin), success: { pathPrefixes: ['/learn'], requireBearer: true } });
  const e = await environment(t, { jwtSeconds: 3600 }, {}, { sourceUrl: 'https://my.centraluniversity.ru/', presetFor: bearerPreset });
  const started = await e.manager.start('u1', e.connection.id, { mode: 'interactive' });
  await e.wait(started.id, ['awaiting_user']);
  const sink = { frame() {}, json() {}, close() {}, buffered: 0 };
  const viewer = e.manager.attach('u1', started.id, sink);
  await sleep(500);
  await viewer.input({ type: 'key', action: 'down', key: 'Enter' }); await viewer.input({ type: 'key', action: 'up', key: 'Enter' });
  const done = await e.wait(started.id, ['succeeded', 'failed', 'expired']);
  assert.equal(done.status, 'succeeded', done.errorCode);
  const { session } = e.store.readSecret('u1', e.connection.id);
  assert.equal(session.bearer.scheme, 'Bearer'); assert.equal(session.bearer.source, 'localStorage'); assert.equal(session.bearer.key, 'access_token');
  assert.equal(session.bearer.host, 'my.centraluniversity.ru');
  const exp = Date.parse(session.bearer.expiresAt); assert.ok(exp > Date.now() + 3000_000 && exp < Date.now() + 3700_000);
  assert.equal(Date.parse(session.expiresAt), exp, 'session expiry follows the JWT');
  assertNoPlaintext(e, session.bearer.token);
});

test('input is validated, rate limited and only accepted while a person is expected to type', { skip }, async t => {
  const e = await environment(t, {}, { inputPerSecond: 5, maxViolations: 3 });
  const started = await e.manager.start('u1', e.connection.id, { mode: 'interactive' });
  await e.wait(started.id, ['awaiting_user']);
  const closed = []; const statuses = [];
  const viewer = e.manager.attach('u1', started.id, { frame() {}, json: v => statuses.push(v), close: reason => closed.push(reason), buffered: 0 });
  for (let i = 0; i < 40; i++) await viewer.input({ type: 'mouse', action: 'move', x: 5, y: 5 });
  await viewer.input({ type: 'navigate', url: 'https://evil.example/' });
  await viewer.input({ type: 'key', action: 'down', key: '../../etc' });
  assert.ok(closed.includes('violations'));
  assert.equal(e.fixture.state.hits['evil.example'] ?? 0, 0);
  const size = await e.manager.attach('u1', started.id, { frame() {}, json: v => statuses.push(v), close() {}, buffered: 0 });
  await size.input({ type: 'resize', width: 5000, height: 5000 });
  assert.ok(statuses.some(v => v.type === 'hello' && v.width <= 480 && v.height <= 900));
});

test('websocket endpoint: handshake validation, masked frames only, size cap, ping/pong, fragmentation', async t => {
  const { acceptWebSocket } = await import('../src/login/websocket.mjs');
  const { createServer } = await import('node:http');
  const { createHash, randomBytes } = await import('node:crypto');
  const received = []; let closedWith = null;
  const server = createServer(); server.on('upgrade', (req, socket, head) => {
    acceptWebSocket(req, socket, head, { maxMessage: 64, onMessage: (kind, data) => received.push([kind, data.toString()]), onClose: code => { closedWith = code; } });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const port = server.address().port;
  const open = (headers = {}) => new Promise(resolve => {
    const key = randomBytes(16).toString('base64');
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`GET / HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: ${headers.version ?? '13'}\r\nSec-WebSocket-Key: ${headers.key ?? key}\r\n\r\n`));
    let data = Buffer.alloc(0); socket.on('data', chunk => { data = Buffer.concat([data, chunk]); });
    resolve({ socket, key, data: () => data });
  });
  const frame = (opcode, payload, { fin = true, mask = true } = {}) => {
    const body = Buffer.from(payload); const key = randomBytes(4);
    const masked = mask ? Buffer.from(body.map((b, i) => b ^ key[i & 3])) : body;
    return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, (mask ? 0x80 : 0) | body.length]), mask ? key : Buffer.alloc(0), masked]);
  };
  const bad = await open({ version: '8' }); await sleep(150); assert.match(bad.data().toString(), /^HTTP\/1\.1 400/); bad.socket.destroy();
  const ws = await open(); await sleep(150);
  assert.match(ws.data().toString(), /^HTTP\/1\.1 101/);
  assert.match(ws.data().toString(), new RegExp(`sec-websocket-accept: ${createHash('sha1').update(ws.key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64').replace(/[+/]/g, '\\$&')}`));
  ws.socket.write(frame(1, 'hello')); ws.socket.write(frame(1, 'a', { fin: false })); ws.socket.write(frame(0, 'b', { fin: true })); ws.socket.write(frame(9, 'p'));
  await sleep(200);
  assert.deepEqual(received, [['text', 'hello'], ['text', 'ab']]);
  assert.ok(ws.data().includes(Buffer.from([0x8a, 0x01, 0x70])), 'ping answered with pong');
  ws.socket.write(frame(1, 'x'.repeat(100)));
  await sleep(200); assert.equal(closedWith, 1009);
  const unmasked = await open(); await sleep(150); closedWith = null; unmasked.socket.write(frame(1, 'hi', { mask: false })); await sleep(200);
  assert.equal(closedWith, 1002); assert.ok(unmasked.data().includes(Buffer.from([0x88, 0x02, 0x03, 0xea])), 'protocol error close frame (1002)');
});

test('owner login check: scripted password+MFA run prints cookie names only and runs the first sync', { skip }, async t => {
  const { runLoginCheck, parseArgs } = await import('../src/login-check.mjs');
  assert.deepEqual(parseArgs(['--university', 'hse', '--mode', 'interactive', '--headed']), { university: 'hse', mode: 'interactive', headed: true, keepCalendar: false, envFile: null, db: null, help: false });
  assert.throws(() => parseArgs(['--mode', 'telepathy']), /--mode/); assert.throws(() => parseArgs(['--password', 'x']), /Unknown option/);
  const fixture = await startFixture({ mfa: true }); t.after(() => fixture.close());
  const store = createStore({ dbPath: ':memory:', masterKey }); t.after(() => store.close());
  const printed = []; const asked = []; const answers = [USER, OTP]; const secrets = [PASSWORD];
  const io = { print: line => printed.push(line), ask: async question => { asked.push(question); return answers.shift(); }, askSecret: async question => { asked.push(question); return secrets.shift(); } };
  const request = async () => ({ status: 401, headers: { 'content-type': 'application/json' }, body: '{}' });
  const result = await runLoginCheck({ store, io, university: 'hse', mode: 'password', keepCalendar: true, factory: createBrowserFactory(fixture.factoryOptions), request });
  assert.equal(result.status, 'succeeded');
  const output = printed.join('\n');
  assert.match(output, /cookies \d+ \[.*MoodleSession.*\]/); assert.match(output, /первая синхронизация по сессии: user_action_required \(source_session_expired\)/);
  for (const forbidden of [PASSWORD, OTP, CALENDAR_TOKEN]) assert.ok(!output.includes(forbidden) && !asked.join('\n').includes(forbidden), forbidden);
  assert.ok(output.includes('awaiting_mfa')); assert.deepEqual([answers, secrets], [[], []]);
  const none = await runLoginCheck({ store, io, university: 'mars', mode: 'password', factory: createBrowserFactory(fixture.factoryOptions) });
  assert.equal(none.errorCode, 'unknown_university');
});

const signIn = async (e, started) => {
  await e.wait(started.id, ['awaiting_user']);
  const viewer = e.manager.attach('u1', started.id, { frame() {}, json() {}, close() {}, buffered: 0 });
  await sleep(500);
  await viewer.input({ type: 'key', action: 'down', key: 'Enter' }); await viewer.input({ type: 'key', action: 'up', key: 'Enter' });
  return e.wait(started.id, ['succeeded', 'failed', 'expired']);
};

test('ЦУ preset: cookie gateway session is recognised by the /api/account/me probe; a different account clears the former data', { skip }, async t => {
  const e = await environment(t, {}, {}, { sourceUrl: 'https://my.centraluniversity.ru/' });
  const first = await signIn(e, await e.manager.start('u1', e.connection.id, { mode: 'interactive' }));
  assert.equal(first.status, 'succeeded', first.errorCode);
  const secret = e.store.readSecret('u1', e.connection.id);
  assert.ok(secret.session.cookies.some(c => c.name === 'sid' && c.httpOnly && c.domain === 'my.centraluniversity.ru'));
  assert.match(secret.session.identityDigest, /^[0-9a-f]{32}$/);
  const keep = { kind: 'courses', items: [{ id: 'c1', title: 'Old course' }], fetchedAt: new Date().toISOString(), complete: true };
  e.store.putSnapshot('u1', e.connection.id, keep);
  const again = await signIn(e, await e.manager.start('u1', e.connection.id, { mode: 'interactive' }));
  assert.equal(again.status, 'succeeded');
  assert.equal(e.store.listSnapshots('u1', e.space.id, { kind: 'courses' }).length, 1, 're-login by the same account keeps the data');
  assert.equal(e.store.readSecret('u1', e.connection.id).session.identityDigest, secret.session.identityDigest);
  e.fixture.state.sub = 'cu-2';
  const other = await signIn(e, await e.manager.start('u1', e.connection.id, { mode: 'interactive' }));
  assert.equal(other.status, 'succeeded');
  assert.equal(e.store.listSnapshots('u1', e.space.id, { kind: 'courses' }).length, 0, 'a different account never inherits the former data');
  assert.notEqual(e.store.readSecret('u1', e.connection.id).session.identityDigest, secret.session.identityDigest);
});

test('API responses seen during the login are handed to learn() in memory and never persisted', { skip }, async t => {
  const handed = [];
  const e = await environment(t, {}, {}, { sourceUrl: 'https://my.centraluniversity.ru/', learn: async args => { handed.push(args); } });
  const done = await signIn(e, await e.manager.start('u1', e.connection.id, { mode: 'interactive' }));
  assert.equal(done.status, 'succeeded', done.errorCode);
  await until(() => handed.length);
  assert.equal(handed[0].userId, 'u1'); assert.equal(handed[0].connectionId, e.connection.id);
  const seen = handed[0].observations.find(o => o.url.endsWith('/api/me'));
  assert.deepEqual([seen.method, seen.status, seen.body.title], ['GET', 200, 'Fixture course']);
  assertNoPlaintext(e, 'Fixture course');
});

test('HSE success needs a signed-in Moodle page: an anonymous MoodleSession cookie alone is not a login', { skip }, async t => {
  const e = await environment(t);
  const { createHostPolicy: policyOf } = await import('../src/login/policy.mjs');
  const { successDetails } = await import('../src/login/flow.mjs');
  const handle = await createBrowserFactory(e.fixture.factoryOptions).open({ policy: policyOf({ hosts: ['edu.hse.ru', 'saml.hse.ru'] }) });
  t.after(() => handle.close());
  e.fixture.state.sessions.add('anonymous-cookie');
  await handle.context.addCookies([{ name: 'MoodleSession', value: 'anonymous-cookie', domain: 'edu.hse.ru', path: '/', secure: true, httpOnly: true }]);
  await handle.page.goto('https://edu.hse.ru/my/', { timeout: 15_000 });
  assert.equal((await successDetails(handle, loginPresetFor('https://edu.hse.ru'), 'https://edu.hse.ru')).ok, true, 'M.cfg.userId is set on the fixture page');
  await handle.page.goto('https://edu.hse.ru/redirect-away', { timeout: 15_000 }).catch(() => {});
  await handle.page.goto('data:text/html,<p>no moodle</p>').catch(() => {});
  assert.equal((await successDetails(handle, loginPresetFor('https://edu.hse.ru'), 'https://edu.hse.ru')).ok, false);
});
