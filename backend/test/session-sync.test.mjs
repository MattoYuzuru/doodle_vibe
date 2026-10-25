import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.mjs';
import { createSourceService } from '../src/sources/index.mjs';
import { findLearnedAdapter, activateLearnedRecipe, learnedAdapterId, resetRecipeHealth } from '../src/sources/learned.mjs';
import { startServer, fixtureRequest, lmsHandler, observe, sessionOf, PEOPLE, ORIGIN, NOW } from './fixtures/session-sync/server.mjs';

const key = Buffer.alloc(32, 7);
function environment(users = ['u1']) {
  const clock = { now: NOW };
  const store = createStore({ dbPath: ':memory:', masterKey: key, now: () => clock.now });
  const spaces = {};
  for (const id of users) { store.ensureUser({ id, displayName: `User ${id}` }); spaces[id] = store.createSpace(id, { universityId: 'x', name: 'Uni' }); }
  const connect = (userId, person, { origin = ORIGIN, session = sessionOf(person) } = {}) => {
    const connection = store.createConnection(userId, spaces[userId].id, { sourceUrl: `${origin}/`, kind: 'lms' });
    store.setSecret(userId, connection.id, { origin, session });
    return connection;
  };
  return { store, clock, connect, spaces };
}
const snapshot = (e, userId, connection, kind) => e.store.listSnapshots(userId, connection.spaceId, { kind }).find(item => item.connectionId === connection.id);
const titles = (e, userId, connection, kind) => snapshot(e, userId, connection, kind)?.items.map(item => item.title);

test('sync by stored session: one learned recipe, each user gets only their own data, no credential lands in the database', async t => {
  resetRecipeHealth();
  const server = await startServer(lmsHandler());
  const e = environment(['u1', 'u2']);
  t.after(async () => { e.store.close(); await server.close(); });
  const service = createSourceService({ store: e.store, request: fixtureRequest(server.port), now: () => NOW });
  const a = e.connect('u1', PEOPLE.A); const b = e.connect('u2', PEOPLE.B);
  assert.deepEqual(await service.learn({ userId: 'u1', connectionId: a.id, observations: await observe(server.port, PEOPLE.A) }), { learned: true, created: true, revision: 1, adapterId: learnedAdapterId(ORIGIN, 1) });
  const ra = await service.sync({ userId: 'u1', connectionId: a.id });
  const rb = await service.sync({ userId: 'u2', connectionId: b.id });
  assert.equal(ra.status, 'ready'); assert.equal(rb.status, 'ready');
  assert.deepEqual(ra.counts, { courses: 3, deadlines: 2, schedule: 1 });
  assert.equal(ra.adapterId, rb.adapterId);
  assert.equal(e.store.getConnection('u2', b.id).adapterId, learnedAdapterId(ORIGIN, 1));
  assert.deepEqual(titles(e, 'u1', a, 'courses'), ['Linear Algebra', 'Statistics', 'Databases']);
  assert.deepEqual(titles(e, 'u2', b, 'courses'), ['Optimization']);
  const stored = JSON.stringify([e.store.listSnapshots('u1', a.spaceId), e.store.listSnapshots('u2', b.spaceId), e.store.getAdapter(learnedAdapterId(ORIGIN, 1)), e.store.getConnection('u1', a.id)]);
  for (const secret of [PEOPLE.A.sid, PEOPLE.B.sid, 'ann.synthetic@mail.example', 'bob.synthetic']) assert.equal(stored.includes(secret), false, secret);
  assert.equal(e.store.getAdapter(learnedAdapterId(ORIGIN, 1)).recipe.bootstrap[0].extract.uid, '/id');
});

test('expiry signs end in user_action_required + source_session_expired, keep snapshots, ask for no login and stop the scheduler', async t => {
  resetRecipeHealth();
  const state = {};
  const server = await startServer(lmsHandler(state));
  const e = environment();
  t.after(async () => { e.store.close(); await server.close(); });
  const service = createSourceService({ store: e.store, request: fixtureRequest(server.port), now: () => e.clock.now });
  const c = e.connect('u1', PEOPLE.A);
  await service.learn({ userId: 'u1', connectionId: c.id, observations: await observe(server.port, PEOPLE.A) });
  assert.equal((await service.sync({ userId: 'u1', connectionId: c.id })).status, 'ready');
  e.clock.now += 2 * 3600_000 - 3600_000 * 1.5; // keep inside the session lifetime
  const before = JSON.stringify(e.store.listSnapshots('u1', c.spaceId));
  assert.equal(e.store.listDueConnections({ olderThanMs: 60_000 }).length, 1, 'a ready connection is polled');
  for (const mode of ['expired', 'redirect', 'loginpath', 'html']) {
    state.mode = mode; server.requests.length = 0;
    const result = await service.sync({ userId: 'u1', connectionId: c.id });
    assert.equal(result.status, 'user_action_required', mode); assert.equal(result.errorCode, 'source_session_expired', mode);
    assert.equal(e.store.getConnection('u1', c.id).errorCode, 'source_session_expired');
    assert.equal(JSON.stringify(e.store.listSnapshots('u1', c.spaceId)), before, `${mode}: snapshots untouched`);
    assert.ok(server.requests.every(r => r.method === 'GET' && !/login|auth|sso|signin/.test(r.url)), `${mode}: no sign-in request`);
    assert.ok(server.requests.length <= 2, `${mode}: stops at the first sign`);
  }
  e.clock.now += 3600_000;
  assert.deepEqual(e.store.listDueConnections({ olderThanMs: 60_000 }), [], 'the scheduler no longer polls it');
  // Known expiry costs no request; a new login (replaceSession) makes sync work again.
  state.mode = undefined; server.requests.length = 0;
  e.clock.now = Date.parse('2026-10-26T00:00:01Z');
  assert.equal((await service.sync({ userId: 'u1', connectionId: c.id })).errorCode, 'source_session_expired');
  assert.equal(server.requests.length, 0);
  e.store.setSecret('u1', c.id, { origin: ORIGIN, session: sessionOf(PEOPLE.A, { expiresAt: '2026-10-27T00:00:00.000Z' }) });
  assert.equal((await service.sync({ userId: 'u1', connectionId: c.id })).status, 'ready');
  assert.equal(e.store.getConnection('u1', c.id).errorCode, null);
});

test('format drift keeps the last snapshot; three different users roll the shared revision back, one user alone does not', async t => {
  resetRecipeHealth();
  const server = await startServer(lmsHandler());
  const e = environment(['u1', 'u2', 'u3']);
  t.after(async () => { e.store.close(); await server.close(); });
  const service = createSourceService({ store: e.store, request: fixtureRequest(server.port), now: () => NOW });
  const conns = { u1: e.connect('u1', PEOPLE.A), u2: e.connect('u2', PEOPLE.B), u3: e.connect('u3', PEOPLE.A) };
  await service.learn({ userId: 'u1', connectionId: conns.u1.id, observations: await observe(server.port, PEOPLE.A) });
  assert.equal((await service.sync({ userId: 'u1', connectionId: conns.u1.id })).status, 'ready');
  const good = findLearnedAdapter(e.store, ORIGIN).recipe;
  const bad = structuredClone(good); bad.endpoints[0].response.itemsPath = '/rows'; bad.endpoints[1].response.itemsPath = '/rows'; bad.endpoints[2].response.itemsPath = '/rows';
  activateLearnedRecipe(e.store, bad, { now: NOW + 1 });
  assert.equal(findLearnedAdapter(e.store, ORIGIN).recipe.revision, 2);
  const before = JSON.stringify(e.store.listSnapshots('u1', conns.u1.spaceId));
  for (let i = 0; i < 3; i++) {
    const result = await service.sync({ userId: 'u1', connectionId: conns.u1.id });
    assert.deepEqual([result.status, result.errorCode], ['error', 'source_format_changed']);
  }
  assert.equal(JSON.stringify(e.store.listSnapshots('u1', conns.u1.spaceId)), before, 'a format break does not replace the snapshot');
  assert.equal(findLearnedAdapter(e.store, ORIGIN).recipe.revision, 2, 'one user failing three times is not enough');
  await service.sync({ userId: 'u2', connectionId: conns.u2.id });
  assert.equal(findLearnedAdapter(e.store, ORIGIN).recipe.revision, 2);
  await service.sync({ userId: 'u3', connectionId: conns.u3.id });
  const latest = findLearnedAdapter(e.store, ORIGIN).recipe;
  assert.deepEqual([latest.revision, latest.rollbackOf], [3, 1]);
  assert.ok(e.store.getAdapter(learnedAdapterId(ORIGIN, 2)), 'the broken revision is kept');
  assert.equal((await service.sync({ userId: 'u2', connectionId: conns.u2.id })).status, 'ready');
  assert.deepEqual(titles(e, 'u2', conns.u2, 'courses'), ['Optimization']);
});

test('a drifted API in one endpoint stores the healthy kinds and reports the format break', async t => {
  resetRecipeHealth();
  const state = {};
  const server = await startServer(lmsHandler(state));
  const e = environment();
  t.after(async () => { e.store.close(); await server.close(); });
  const service = createSourceService({ store: e.store, request: fixtureRequest(server.port), now: () => NOW });
  const c = e.connect('u1', PEOPLE.A);
  await service.learn({ userId: 'u1', connectionId: c.id, observations: await observe(server.port, PEOPLE.A) });
  await service.sync({ userId: 'u1', connectionId: c.id });
  const oldCourses = JSON.stringify(snapshot(e, 'u1', c, 'courses'));
  state.mode = 'drift';
  const result = await service.sync({ userId: 'u1', connectionId: c.id });
  assert.deepEqual([result.status, result.errorCode, result.partial], ['error', 'source_format_changed', true]);
  assert.equal(JSON.stringify(snapshot(e, 'u1', c, 'courses')), oldCourses);
  assert.deepEqual(titles(e, 'u1', c, 'schedule'), ['Lecture: Algebra'], 'the untouched endpoint still refreshes');
});

test('moodle AJAX seed for edu.hse.ru: sesskey from the page, read-only POST with typed args, session beats the typed token flow', async t => {
  resetRecipeHealth();
  const HSE = 'https://edu.hse.ru';
  const state = { login: false };
  const server = await startServer(request => {
    const url = new URL(request.url, 'http://x');
    if (request.cookie !== 'MoodleSession=moodlecookie12345') return { status: 303, headers: { location: '/login/index.php' }, body: '' };
    if (url.pathname === '/my/') return { body: '<html><script>var M = {cfg: {"wwwroot":"https://edu.hse.ru","sesskey":"Ab12Cd34Ef","userId":7}};</script></html>' };
    if (url.pathname === '/lib/ajax/service.php') {
      const [call] = JSON.parse(request.body);
      if (url.searchParams.get('sesskey') !== 'Ab12Cd34Ef' || url.searchParams.get('info') !== call.methodname || request.contentType !== 'application/json') return { body: [{ error: true, exception: { errorcode: 'invalidsesskey' } }] };
      if (state.login) return { body: [{ error: true, exception: { errorcode: 'servicerequireslogin', message: 'Route requires login' } }] };
      if (call.methodname === 'core_course_get_enrolled_courses_by_timeline_classification') return { body: [{ error: false, data: { courses: [{ id: 3, fullname: 'Алгебра', viewurl: `${HSE}/course/view.php?id=3` }], nextoffset: 0 } }] };
      return { body: [{ error: false, data: { events: [{ id: 90, name: 'Сдать задание', timesort: 1793000000, course: { id: 3 }, url: `${HSE}/mod/assign/view.php?id=5` }] } }] };
    }
    return { status: 404, body: '' };
  });
  const e = environment();
  t.after(async () => { e.store.close(); await server.close(); });
  const service = createSourceService({ store: e.store, request: fixtureRequest(server.port), now: () => NOW });
  const session = { ...sessionOf(PEOPLE.A), cookies: [{ name: 'MoodleSession', value: 'moodlecookie12345', domain: 'edu.hse.ru', path: '/', secure: true, httpOnly: true }] };
  const c = e.connect('u1', PEOPLE.A, { origin: HSE, session });
  const result = await service.sync({ userId: 'u1', connectionId: c.id });
  assert.deepEqual([result.status, result.adapterId, result.counts], ['ready', learnedAdapterId(HSE, 1), { courses: 1, deadlines: 1 }]);
  assert.deepEqual(titles(e, 'u1', c, 'courses'), ['Алгебра']);
  const snap = snapshot(e, 'u1', c, 'deadlines').items[0];
  assert.equal(snap.dueAt, new Date(1793000000 * 1000).toISOString()); assert.equal(snap.url, `${HSE}/mod/assign/view.php?id=5`);
  const posts = server.requests.filter(r => r.method === 'POST');
  assert.equal(posts.length, 2);
  const events = JSON.parse(posts[1].body)[0].args;
  assert.deepEqual([events.timesortfrom, events.timesortto, events.limitnum, events.limittononsuspendedevents], [NOW / 1000, NOW / 1000 + 56 * 86400, 50, true]);
  assert.ok(server.requests.every(r => r.cookie === 'MoodleSession=moodlecookie12345'));
  state.login = true;
  assert.equal((await service.sync({ userId: 'u1', connectionId: c.id })).errorCode, 'source_session_expired');
});

test('session transport (network.mjs): cookie scoping, bearer, no redirects, POST only on named paths', async t => {
  const server = await startServer(request => (request.url === '/go' ? { status: 302, headers: { location: 'https://evil.example/steal' }, body: '' } : { body: { ok: true } }));
  t.after(() => server.close());
  const request = fixtureRequest(server.port);
  const cookie = (name, value, extra = {}) => ({ name, value, domain: 'lms.example.edu', path: '/', secure: true, httpOnly: false, ...extra });
  const session = extra => ({ origin: ORIGIN, auth: 'cookie', postPaths: ['/lib/ajax/service.php'], now: NOW, ...extra });
  await request(`${ORIGIN}/api/x`, { session: session({ cookies: [cookie('a', '1'), cookie('b', '2', { domain: 'other.example' }), cookie('c', '3', { path: '/admin' }), cookie('d', '4', { expires: NOW / 1000 - 5 }),
    cookie('e', 'x;y=z'), cookie('f', '6', { domain: '.example.edu' }), cookie('g', '7', { domain: '.edu' }), cookie('h', '8', { path: '/api' }), cookie('i', '9', { path: '/apix' })] }) });
  assert.equal(server.requests.at(-1).cookie, 'a=1; f=6; h=8');
  assert.equal(server.requests.at(-1).authorization, undefined);
  await request(`${ORIGIN}/api/x`, { session: session({ auth: 'bearer', cookies: [cookie('a', '1')], bearer: { token: 'tok.synthetic-12345', host: 'lms.example.edu' } }) });
  assert.deepEqual([server.requests.at(-1).authorization, server.requests.at(-1).cookie], ['Bearer tok.synthetic-12345', undefined]);
  const count = server.requests.length;
  await assert.rejects(request(`${ORIGIN}/api/x`, { session: session({ auth: 'bearer', bearer: { token: 'tok.synthetic-12345', host: 'elsewhere.example' } }) }), { code: 'source_session_expired' });
  await assert.rejects(request(`${ORIGIN}/api/x`, { session: session({ cookies: [cookie('b', '2', { domain: 'other.example' })] }) }), { code: 'source_session_expired' });
  await assert.rejects(request(`${ORIGIN}/api/x`, { session: session({ cookies: [cookie('a', '1')], origin: 'https://other.example' }) }), { code: 'source_auth_origin_unsafe' });
  await assert.rejects(request(`${ORIGIN}/api/x`, { method: 'POST', body: '[]', session: session({ cookies: [cookie('a', '1')] }) }), { code: 'source_method_unsafe' });
  await assert.rejects(request(`${ORIGIN}/api/x`, { method: 'DELETE', session: session({ cookies: [cookie('a', '1')] }) }), { code: 'source_method_unsafe' });
  await assert.rejects(request(`${ORIGIN}/api/x`, { session: session({ cookies: [cookie('a', '1')] }), authenticated: true, headers: { authorization: 'Bearer abcdefgh12' }, boundOrigin: ORIGIN }), { code: 'source_method_unsafe' });
  assert.equal(server.requests.length, count, 'every refusal happens before any network I/O');
  await request(`${ORIGIN}/lib/ajax/service.php?sesskey=abc&info=core_calendar_get_action_events_by_timesort`, { method: 'POST', body: '[]', session: session({ cookies: [cookie('a', '1')] }) });
  assert.deepEqual([server.requests.at(-1).method, server.requests.at(-1).contentType], ['POST', 'application/json']);
  const redirect = await request(`${ORIGIN}/go`, { session: session({ cookies: [cookie('a', '1')] }) });
  assert.deepEqual([redirect.status, redirect.headers.location, server.requests.at(-1).url], [302, 'https://evil.example/steal', '/go']);
  assert.equal(server.requests.filter(r => r.url === '/steal').length, 0, 'the redirect is reported, never followed with the session');
});
