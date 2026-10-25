import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHmac } from 'node:crypto';
import { createStore } from '../src/store.mjs';
import { createApp } from '../src/http.mjs';
import { createLoginSessionManager } from '../src/login/session-manager.mjs';
import { createLoginRoutes } from '../src/login/routes.mjs';
import { createDevAuth } from '../src/dev-auth.mjs';
import { isLearnedRecipe, validateLearnedRecipe, READ_ONLY_POST_ALLOWLIST } from '../src/sources/learned.mjs';

// Parallel tasks A/B/C import these modules; this file pins the shape they must keep
// (docs/architecture/auth-sessions-contract.md). Behaviour beyond the disabled defaults is theirs.
const botToken = 'fixture-bot-token-only';
const NOW = Date.parse('2026-10-25T12:00:00Z');
const key = Buffer.alloc(32, 3);
function sign(id) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(NOW / 1000)), user: JSON.stringify({ id: Number(id), first_name: 'Fixture' }) });
  const data = [...params].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  params.set('hash', createHmac('sha256', createHmac('sha256', 'WebAppData').update(botToken).digest()).update(data).digest('hex'));
  return params.toString();
}

test('login manager keeps the contract surface; without a runtime it refuses to start', async () => {
  const store = createStore({ dbPath: ':memory:', masterKey: key });
  store.ensureUser({ id: 'u', displayName: 'U' });
  const manager = createLoginSessionManager({ store, factory: { available: () => false, open: async () => { throw new Error('no launch'); } } });
  for (const name of ['capabilities', 'authMethods', 'start', 'get', 'submitMfa', 'handoff', 'done', 'cancel', 'issueTicket', 'consumeTicket', 'attach', 'active', 'cancelForConnection', 'close']) assert.equal(typeof manager[name], 'function', name);
  assert.deepEqual(manager.capabilities(), { interactive: false, password: false });
  assert.deepEqual(manager.authMethods({ sourceUrl: 'https://edu.hse.ru/' }), []);
  assert.equal(manager.active('u', 'c'), null);
  assert.throws(() => manager.get('u', 'x'), { status: 404 });
  assert.equal(manager.consumeTicket('nope', 'x'), null);
  const routes = createLoginRoutes({});
  assert.equal(await routes.handle({}), false);
  let ended = ''; routes.upgrade({ url: '/api/v1/login/x/stream', headers: {} }, { end: text => { ended = text; } }, Buffer.alloc(0)); assert.match(ended, /^HTTP\/1\.1 404/);
  store.close();
  assert.equal(createDevAuth({}), null);
});

test('learned recipe stub recognises only version 2 and keeps the read-only POST allowlist as data', () => {
  assert.equal(isLearnedRecipe({ version: 2, type: 'learned' }), true);
  assert.equal(isLearnedRecipe({ version: 1, type: 'moodle' }), false);
  assert.equal(isLearnedRecipe(null), false);
  assert.throws(() => validateLearnedRecipe({ version: 1, type: 'moodle' }), { code: 'source_recipe_invalid' });
  assert.ok(Object.isFrozen(READ_ONLY_POST_ALLOWLIST));
  assert.deepEqual(READ_ONLY_POST_ALLOWLIST[0].methods.slice().sort(), ['core_calendar_get_action_events_by_timesort', 'core_course_get_enrolled_courses_by_timeline_classification']);
});

test('http mounts the login hooks: routes, authMethods, login state, dev identity and upgrade', async t => {
  const store = createStore({ dbPath: ':memory:', masterKey: key, now: () => NOW });
  const seen = [];
  const login = { ...createLoginSessionManager({}), authMethods: () => [{ id: 'remote_login', type: 'remote_login', label: 'Вход в браузере', fields: [] }],
    active: (userId, connectionId) => ({ id: 'L1', connectionId, owner: userId }), cancelForConnection: async id => { seen.push(['cancel', id]); } };
  const loginRoutes = { handle: async ctx => { if (ctx.url.pathname === '/api/v1/login/ping') { ctx.send(ctx.res, 200, { pong: ctx.userId }, ctx.requestId); return true; } return false; },
    upgrade: (_req, socket) => { seen.push(['upgrade']); socket.destroy(); } };
  const devAuth = { identify: req => (req.headers['x-dev'] === '1' ? { id: '99', displayName: 'Synthetic' } : null) };
  const server = createApp({ store, config: { botToken, publicBaseUrl: 'https://doodle.example', version: 'fixture' }, login, loginRoutes, devAuth, now: () => NOW });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const url = path => `http://127.0.0.1:${server.address().port}${path}`;
  const get = (path, headers) => fetch(url(path), { headers }).then(async r => ({ status: r.status, body: await r.json() }));
  assert.deepEqual((await get('/api/v1/login/ping', { 'x-telegram-init-data': sign(7) })).body, { pong: '7' });
  assert.deepEqual((await get('/api/v1/login/ping', { 'x-dev': '1' })).body, { pong: '99' });
  assert.equal((await get('/api/v1/login/ping', {})).status, 401);
  assert.equal((await get('/api/v1/login/ping', { 'x-dev': '1', 'x-telegram-init-data': 'bad' })).status, 401, 'dev identity never overrides present Telegram data');
  const init = { 'x-telegram-init-data': sign(7) };
  const space = (await fetch(url('/api/v1/spaces'), { method: 'POST', headers: { ...init, 'content-type': 'application/json' }, body: JSON.stringify({ universityId: 'hse', name: 'HSE' }) }).then(r => r.json())).space;
  const created = await fetch(url(`/api/v1/spaces/${space.id}/connections`), { method: 'POST', headers: { ...init, 'content-type': 'application/json' }, body: JSON.stringify({ sourceUrl: 'https://edu.hse.ru/', kind: 'lms' }) }).then(r => r.json());
  const detail = await get(`/api/v1/connections/${created.connection.id}`, init);
  assert.deepEqual(detail.body.authMethods.map(m => m.id), ['calendar_url', 'moodle_token', 'moodle_password', 'remote_login']);
  assert.equal(detail.body.login.connectionId, created.connection.id);
  const removed = await fetch(url(`/api/v1/connections/${created.connection.id}`), { method: 'DELETE', headers: init });
  assert.equal(removed.status, 200); assert.deepEqual(seen, [['cancel', created.connection.id]]);
});
