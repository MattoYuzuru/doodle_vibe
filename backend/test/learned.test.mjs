import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.mjs';
import { SEED_RECIPES } from '../src/sources/learned-seeds.mjs';
import { validateLearnedRecipe, learnFromObservations, learnAndActivate, canaryLearnedRecipe, syncLearned, activateLearnedRecipe, findLearnedAdapter,
  rollbackLearnedRecipe, ensureSeedRecipe, learnedAdapterId, observationShapes, inspectSessionResponse, parseTemplate } from '../src/sources/learned.mjs';
import { startServer, fixtureRequest, lmsHandler, observe, sessionOf, PEOPLE, ORIGIN, NOW } from './fixtures/session-sync/server.mjs';

const base = () => ({ version: 2, type: 'learned', origin: ORIGIN, revision: 1, learnedAt: '2026-10-25T12:00:00.000Z', auth: { type: 'cookie' },
  endpoints: [{ id: 'courses', kind: 'courses', request: { method: 'GET', path: '/api/courses', query: { limit: '50' } },
    response: { itemsPath: '/items', fields: { id: { path: '/id' }, title: { path: '/name' } } } }],
  validation: { requireKinds: ['courses'] } });
const withEndpoint = patch => { const recipe = base(); Object.assign(recipe.endpoints[0], patch); return recipe; };
const invalid = recipe => assert.throws(() => validateLearnedRecipe(recipe), { code: 'source_recipe_invalid' });
const connection = { id: 'conn-1', sourceUrl: `${ORIGIN}/` };

test('seed recipes (ЦУ, ВШЭ Moodle AJAX) and a minimal recipe pass lint and are returned as clean copies', () => {
  const recipe = base();
  const clean = validateLearnedRecipe(recipe);
  assert.deepEqual(clean, recipe); assert.notEqual(clean, recipe);
  for (const seed of Object.values(SEED_RECIPES)) assert.equal(validateLearnedRecipe({ ...seed, revision: 1, learnedAt: '2026-10-25T00:00:00Z' }).type, 'learned');
});

test('lint rejects personal data, tokens, URLs, code and unsafe methods (contract §5)', () => {
  const pathWith = path => withEndpoint({ request: { method: 'GET', path } });
  const queryWith = query => withEndpoint({ request: { method: 'GET', path: '/api/x', query } });
  for (const path of ['/api/users/ann.synthetic@mail.example/courses', '/api/users/4821001/courses', '/api/x/eyJhbGciOiJIUzI1NiJ9.abc', '/api/x/123e4567-e89b-12d3-a456-426614174000',
    '/api/+7 912 345 67 89', 'https://other.example/api', '//other.example/api', '/api/../admin', '/api/x?token=1', '/api/x#frag', '/api/%2e%2e/x', 'api/x', '/api/{', '/api/{bad name}', '/api/{plusDaysUnix:9999}']) invalid(pathWith(path));
  for (const query of [{ code: 'ann.synthetic@mail.example' }, { access_token: 'x' }, { userId: '{uid}' }, { sesskey: 'abc123def456' }, { key: 'a'.repeat(20) + '1'.repeat(14) }, { 'bad key!': '1' }, { limit: 50 }]) invalid(queryWith(query));
  invalid({ ...base(), extra: 1 });
  invalid({ ...base(), origin: 'http://lms.example.edu' });
  invalid({ ...base(), origin: `${ORIGIN}/path` });
  invalid({ ...base(), auth: { type: 'bearer', token: 'x'.repeat(20) } });
  invalid({ ...base(), validation: { requireKinds: ['schedule'] } });
  invalid(withEndpoint({ kind: 'deadlines' }));                                   // deadlines need dueAt
  invalid(withEndpoint({ response: { itemsPath: '/__proto__', fields: { id: { path: '/id' }, title: { path: '/name' } } } }));
  invalid(withEndpoint({ response: { itemsPath: '/items', fields: { id: { path: '/id' }, title: { path: '/name', transform: 'eval' } } } }));
  invalid(withEndpoint({ response: { itemsPath: '/items', fields: { id: { path: '/(a+)+$' }, title: { path: '/name' } } } })); // no regular expressions
  invalid(withEndpoint({ request: { method: 'GET', path: '/api/x', query: { q: '{missing}' } } }));                              // parameter nobody provides
  invalid({ ...base(), bootstrap: [{ id: 'me', method: 'GET', path: '/api/me', extract: { userId: '/id' } }] });                  // `userId` would be refused by the store
  invalid({ ...base(), endpoints: Array.from({ length: 11 }, (_, i) => ({ ...base().endpoints[0], id: `e${i}` })) });
  invalid(withEndpoint({ pagination: { type: 'page', param: 'page', limit: 10, maxPages: 4 } }));
});

test('POST exists only as the code allowlist of read-only Moodle methods', () => {
  const post = (path, methodname, extra = {}) => withEndpoint({ request: { method: 'POST', path, query: { info: methodname },
    body: [{ index: 0, methodname, args: { limit: 10 }, ...extra }] } });
  validateLearnedRecipe(post('/lib/ajax/service.php', 'core_course_get_enrolled_courses_by_timeline_classification'));
  invalid(post('/lib/ajax/service.php', 'core_message_send_instant_messages'));
  invalid(post('/api/graphql', 'core_course_get_enrolled_courses_by_timeline_classification'));
  invalid(post('/lib/ajax/service.php', 'core_course_get_enrolled_courses_by_timeline_classification', { extra: true }));
  invalid(withEndpoint({ request: { method: 'POST', path: '/lib/ajax/service.php', body: [] } }));
  invalid(withEndpoint({ request: { method: 'DELETE', path: '/api/x' } }));
  invalid(withEndpoint({ request: { method: 'GET', path: '/api/x', body: [{ a: 1 }] } }));
  invalid(withEndpoint({ request: { method: 'POST', path: '/lib/ajax/service.php', query: { info: 'core_calendar_get_action_events_by_timesort' },
    body: [{ index: 0, methodname: 'core_course_get_enrolled_courses_by_timeline_classification', args: {} }] } }));
});

test('literals equal to an observed value are refused; templates are parsed strictly', () => {
  const recipe = withEndpoint({ request: { method: 'GET', path: '/api/groups/Alpha7', query: { limit: '50' } } });
  validateLearnedRecipe(recipe);
  assert.throws(() => validateLearnedRecipe(recipe, { observedValues: new Set(['Alpha7']) }), { code: 'source_recipe_invalid' });
  assert.deepEqual(parseTemplate('/a/{uid}/{today}/{plusDaysUnix:7}').map(part => part.param ?? part.builtin ?? part.literal), ['/a/', 'uid', '/', 'today', '/', 'plusDaysUnix']);
});

test('learning from observations builds a shared recipe without a single personal value', async () => {
  const server = await startServer(lmsHandler());
  try {
    const observations = await observe(server.port, PEOPLE.A);
    const recipe = await learnFromObservations(observations, { origin: ORIGIN, now: NOW });
    assert.deepEqual(recipe.bootstrap, [{ id: 'me', method: 'GET', path: '/api/me', extract: { uid: '/id' } }]);
    assert.deepEqual(recipe.endpoints.map(endpoint => [endpoint.kind, endpoint.request.path, endpoint.request.query]),
      [['courses', '/api/users/{uid}/courses', { limit: '2' }], ['deadlines', '/api/users/{uid}/deadlines', { from: '{nowUnix}' }], ['schedule', '/api/schedule', { date: '{today}' }]]);
    assert.deepEqual(recipe.endpoints[0].pagination, { type: 'offset', param: 'offset', limit: 2, maxPages: 3 });
    const text = JSON.stringify(recipe);
    for (const personal of ['4821', 'Ann', 'ann.s', 'mail.example', PEOPLE.A.sid, 'Linear', 'Homework', '1792']) assert.equal(text.includes(personal), false, personal);
    assert.deepEqual(validateLearnedRecipe(recipe), recipe);
    // The model-facing view is shape only.
    const shapes = JSON.stringify(observationShapes(observations, { origin: ORIGIN }));
    for (const personal of ['4821', 'Ann', 'mail.example', 'Linear Algebra', 'Homework 1']) assert.equal(shapes.includes(personal), false, personal);
    assert.match(shapes, /"displayName":"string"/);
  } finally { await server.close(); }
});

test('a personal value that cannot be templated drops the endpoint instead of leaking into the recipe', async () => {
  const observations = [
    { method: 'GET', url: `${ORIGIN}/api/me`, status: 200, body: { id: 'u-4821', displayName: 'Ann' } },
    { method: 'GET', url: `${ORIGIN}/api/feed?owner=ann.synthetic@mail.example`, status: 200, body: [{ id: 1, name: 'x', start: '2026-10-26T09:00:00Z' }] },
    { method: 'GET', url: `${ORIGIN}/api/courses?term=autumn&access_token=zzzzzzzz1`, status: 200, body: { items: [{ id: 2, name: 'y' }] } },
    { method: 'GET', url: `${ORIGIN}/api/rooms/1234567/events`, status: 200, body: [{ id: 3, title: 'z', start: '2026-10-26T09:00:00Z' }] },
    { method: 'POST', url: `${ORIGIN}/api/courses`, status: 200, body: { items: [] } },
    { method: 'GET', url: 'https://other.example/api/x', status: 200, body: [{ id: 1, name: 'x' }] },
    { method: 'GET', url: `${ORIGIN}/logout`, status: 200, body: [{ id: 1, name: 'x' }] },
  ];
  assert.equal(await learnFromObservations(observations, { origin: ORIGIN, now: NOW }), null);
  // a shape-only model proposal goes through the same lint
  const hostile = { ...base(), endpoints: [withEndpoint({ request: { method: 'GET', path: '/api/users/ann.synthetic@mail.example/x' } }).endpoints[0]] };
  assert.equal(await learnFromObservations(observations, { origin: ORIGIN, now: NOW, propose: async () => hostile }), null);
  const clean = await learnFromObservations(observations, { origin: ORIGIN, now: NOW, propose: async shapes => { assert.ok(Array.isArray(shapes)); return base(); } });
  assert.equal(clean.endpoints[0].request.path, '/api/courses');
});

test('canary runs on the observer session, activation writes revisions and an identical recipe is not versioned twice', async () => {
  const server = await startServer(lmsHandler());
  const store = createStore({ dbPath: ':memory:', masterKey: Buffer.alloc(32, 5), now: () => NOW });
  try {
    const request = fixtureRequest(server.port);
    const session = sessionOf(PEOPLE.A);
    const observations = await observe(server.port, PEOPLE.A);
    const first = await learnAndActivate({ store, observations, session, request, origin: ORIGIN, now: NOW });
    assert.equal(first.created, true);
    assert.equal(first.adapter.id, learnedAdapterId(ORIGIN, 1));
    assert.equal(first.adapter.version, '1');
    assert.deepEqual(first.adapter.capabilities.sort(), ['courses', 'deadlines', 'schedule']);
    const again = await learnAndActivate({ store, observations, session, request, origin: ORIGIN, now: NOW + 1000 });
    assert.equal(again.created, false); assert.equal(findLearnedAdapter(store, ORIGIN).recipe.revision, 1);
    // A canary that finds no items refuses activation and stores nothing new.
    const empty = await startServer(request => { const reply = lmsHandler()(request); return request.url.startsWith('/api/users/') ? { body: reply.body.data ? { data: { items: [] } } : [] } : reply; });
    await assert.rejects(canaryLearnedRecipe({ recipe: first.recipe, session, request: fixtureRequest(empty.port), now: NOW }), { code: 'source_recipe_invalid' });
    await empty.close();
    // Expired session at canary time.
    await assert.rejects(canaryLearnedRecipe({ recipe: first.recipe, session: { ...session, expiresAt: '2026-10-25T11:59:00Z' }, request, now: NOW }), { code: 'source_session_expired' });
  } finally { store.close(); await server.close(); }
});

test('revisions: newest wins, rollback is a new revision naming rollbackOf, old revisions stay', () => {
  const store = createStore({ dbPath: ':memory:', masterKey: Buffer.alloc(32, 5), now: () => NOW });
  try {
    const one = activateLearnedRecipe(store, base(), { now: NOW });
    const changed = base(); changed.endpoints[0].response.itemsPath = '/rows';
    const two = activateLearnedRecipe(store, changed, { now: NOW + 1 });
    assert.deepEqual([one.recipe.revision, two.recipe.revision], [1, 2]);
    assert.equal(findLearnedAdapter(store, ORIGIN).recipe.response ?? findLearnedAdapter(store, ORIGIN).recipe.endpoints[0].response.itemsPath, '/rows');
    const back = rollbackLearnedRecipe(store, ORIGIN, { now: NOW + 2 });
    assert.equal(back.recipe.revision, 3); assert.equal(back.recipe.rollbackOf, 1);
    assert.equal(findLearnedAdapter(store, ORIGIN).recipe.endpoints[0].response.itemsPath, '/items');
    assert.ok(store.getAdapter(learnedAdapterId(ORIGIN, 2)), 'the failed revision is kept');
    assert.equal(rollbackLearnedRecipe(createStore({ dbPath: ':memory:', masterKey: Buffer.alloc(32, 5) }), ORIGIN), null);
    // seeds are installed once per origin and never replace a learned revision
    const seeded = ensureSeedRecipe(store, 'https://edu.hse.ru', { now: NOW });
    assert.equal(seeded.recipe.revision, 1); assert.equal(ensureSeedRecipe(store, 'https://edu.hse.ru').adapter.id, seeded.adapter.id);
    assert.equal(ensureSeedRecipe(store, 'https://unknown.example'), null);
  } finally { store.close(); }
});

test('syncLearned: bootstrap parameter per user, pagination, dates, ids and secrets never in items', async () => {
  const server = await startServer(lmsHandler());
  try {
    const request = fixtureRequest(server.port);
    const recipe = await learnFromObservations(await observe(server.port, PEOPLE.A), { origin: ORIGIN, now: NOW });
    const run = async person => syncLearned({ recipe, session: sessionOf(person), request, connection, fetchedAt: '2026-10-25T12:00:00.000Z', now: NOW });
    const a = await run(PEOPLE.A); const b = await run(PEOPLE.B);
    const kinds = outcome => Object.fromEntries(outcome.snapshots.map(snapshot => [snapshot.kind, snapshot.items]));
    assert.deepEqual(kinds(a).courses.map(item => item.title), ['Linear Algebra', 'Statistics', 'Databases']);   // two pages of limit 2
    assert.deepEqual(kinds(b).courses.map(item => item.title), ['Optimization']);
    assert.deepEqual(kinds(a).deadlines.map(item => item.dueAt), ['2026-10-30T20:00:00.000Z', '2026-11-02T07:00:00.000Z']);
    assert.equal(kinds(a).deadlines[0].courseId, kinds(a).courses[0].id, 'course ids line up across kinds');
    assert.equal(kinds(a).schedule[0].location, '305');
    assert.equal(kinds(a).courses[0].id.startsWith('conn-1:'), true);
    assert.equal(JSON.stringify([a, b]).includes(PEOPLE.A.sid), false);
    const mine = server.requests.filter(r => r.cookie === `sid=${PEOPLE.B.sid}`).map(r => r.url);
    assert.ok(mine.some(url => url.startsWith('/api/users/7310/courses')) && !mine.some(url => url.includes('4821')), 'user B only ever asks for their own id');
    assert.deepEqual(server.requests.filter(r => r.cookie !== `sid=${PEOPLE.A.sid}` && r.cookie !== `sid=${PEOPLE.B.sid}`), []);
    assert.deepEqual([...new Set(server.requests.map(r => r.method))], ['GET']);
  } finally { await server.close(); }
});

test('response classification: expiry signs of contract §6 versus format drift', () => {
  const json = (data, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
  const sign = response => assert.throws(() => inspectSessionResponse(response, { origin: ORIGIN }), { code: 'source_session_expired' });
  sign({ status: 401, headers: {}, body: '' }); sign({ status: 403, headers: {}, body: '' });
  sign({ status: 302, headers: { location: 'https://sso.example.edu/x' }, body: '' });
  for (const location of ['/login/index.php', '/auth/realms/r', '/sso/start', '/oidc/x', '/signin']) sign({ status: 302, headers: { location }, body: '' });
  for (const code of ['servicerequireslogin', 'invalid_token', 'token_expired', 'unauthorized']) sign(json([{ error: true, exception: { errorcode: code } }]));
  sign(json({ error: 'invalid_token' }));
  sign({ status: 200, headers: { 'content-type': 'text/html' }, body: '<form><input type="password"></form>' });
  assert.throws(() => inspectSessionResponse({ status: 200, headers: { 'content-type': 'text/html' }, body: '<p>maintenance</p>' }, { origin: ORIGIN }), { code: 'source_format_changed' });
  assert.throws(() => inspectSessionResponse({ status: 302, headers: { location: '/courses' }, body: '' }, { origin: ORIGIN }), { code: 'source_unavailable' });
  assert.throws(() => inspectSessionResponse({ status: 429, headers: {}, body: '' }, { origin: ORIGIN }), { code: 'source_rate_limited' });
  assert.equal(inspectSessionResponse(json([{ title: 'a course named unauthorized' }]), { origin: ORIGIN }).format, 'json');
});

test('values read from a bootstrap response cannot redirect the request (dot segments, separators, odd types)', async () => {
  const recipe = { ...base(), bootstrap: [{ id: 'me', method: 'GET', path: '/api/me', extract: { uid: '/id' } }],
    endpoints: [{ ...base().endpoints[0], request: { method: 'GET', path: '/api/users/{uid}/courses' } }] };
  for (const id of ['..', '.', 'a/b', 'x?y', 'a b', '', null, { a: 1 }, 'z'.repeat(65)]) {
    const server = await startServer(request => ({ body: request.url === '/api/me' ? { id } : { items: [{ id: 1, name: 'c' }] } }));
    try {
      await assert.rejects(syncLearned({ recipe, session: sessionOf(PEOPLE.A), request: fixtureRequest(server.port), connection, fetchedAt: '2026-10-25T12:00:00.000Z', now: NOW }), { code: 'source_format_changed' }, JSON.stringify(id));
      assert.deepEqual(server.requests.map(r => r.url), ['/api/me']);
    } finally { await server.close(); }
  }
});
