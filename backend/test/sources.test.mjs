import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { AppError } from '../src/errors.mjs';
import { createSourceService } from '../src/sources/index.mjs';
import { createSafeRequest, validateSourceUrl, isPublicAddress, resolvePublicAddress } from '../src/sources/network.mjs';
import { validateRecipe, parseCsv } from '../src/sources/recipes.mjs';

const origin = 'https://university.example';
const recipe = { version: 1, format: 'json', path: '$source', kind: 'schedule', itemsPath: 'events', fields: { id: 'id', title: 'title', startsAt: 'start', location: 'room' } };
const json = (data, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
const html = body => ({ status: 200, headers: { 'content-type': 'text/html' }, body });
const event = { id: 'class-1', title: 'Algebra', start: '2026-10-25T09:00:00+03:00', room: '101' };
function fixture(url = `${origin}/schedule`, overrides = {}) {
  const connection = { id: 'con-a', userId: 'alice', spaceId: 'space-a', sourceUrl: url, kind: 'url', ...overrides };
  const snapshots = new Map(), documents = new Map(), adapters = new Map(), updates = [], secrets = new Map();
  const get = (user, id) => { if (user !== connection.userId || id !== connection.id || connection.deleted) throw new AppError('not_found', 404); return { ...connection }; };
  const store = {
    getConnection: get,
    updateConnection(user, id, patch) { get(user, id); Object.assign(connection, patch); updates.push(patch); return { ...connection }; },
    getAdapter: id => adapters.get(id), findAdapter: site => [...adapters.values()].find(a => a.origin === site),
    putAdapter: adapter => { adapters.set(adapter.id, structuredClone(adapter)); return adapter; },
    putSnapshot(user, id, snapshot) { get(user, id); if (snapshot.complete) snapshots.set(snapshot.kind, structuredClone(snapshot)); },
    putDocument(user, space, document) { get(user, connection.id); assert.equal(space, connection.spaceId); documents.set(document.id, document); },
    readSecret(user, id) { get(user, id); return secrets.get(id) ?? null; },
    setSecret(user, id, value) { get(user, id); secrets.set(id, value); }
  };
  return { store, connection, snapshots, documents, adapters, updates, secrets };
}
const args = { userId: 'alice', connectionId: 'con-a' };

test('URL and address guard rejects local IPv4, IPv6, mapped and credential URLs', () => {
  for (const address of ['127.0.0.1', '10.2.3.4', '100.64.0.1', '169.254.169.254', '172.16.1.1', '192.168.0.1', '192.0.2.1', '198.19.1.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2001:0db8::1', '2001:0000::1', '2002:7f00:1::', '64:ff9b::7f00:1']) assert.equal(isPublicAddress(address), false, address);
  for (const value of ['http://example.com/', 'https://a:b@example.com/', 'https://2130706433/', 'https://0x7f000001/', 'https://[::ffff:127.0.0.1]/', 'https://example.com:8443/', 'https://example.com/?wstoken=abc', 'https://example.com/?API_KEY=abc', 'https://localhost/', 'https://test.internal/']) assert.throws(() => validateSourceUrl(value));
  assert.equal(validateSourceUrl(`${origin}/data?group=a`).origin, origin);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('DNS rejects mixed answers and pins a checked address to the socket', async () => {
  await assert.rejects(resolvePublicAddress('a.example', async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]), { code: 'source_address_unsafe' });
  let dns = 0, socketAddress, sent;
  const request = createSafeRequest({ resolver: async () => { dns++; return [{ address: '8.8.8.8', family: 4 }]; }, clientFactory: (_site, options) => {
    options.connect.lookup('university.example', {}, (_error, address) => { socketAddress = address; });
    return { request: async options => { sent = options; return { statusCode: 200, headers: { 'content-type': 'text/html' }, body: Readable.from(['ok']) }; }, destroy: async () => {} };
  } });
  assert.equal((await request(origin, { headers: { authorization: 'NEVER', cookie: 'NEVER' } })).body, 'ok');
  assert.equal(dns, 1); assert.equal(socketAddress, '8.8.8.8'); assert.equal(sent.headers.authorization, undefined); assert.equal(sent.headers.cookie, undefined);
});

test('redirects revalidate destination, cap hops and refuse authenticated forwarding', async () => {
  const destinations = []; let target = 'https://127.0.0.1/';
  const request = createSafeRequest({ resolver: async host => { destinations.push(host); return [{ address: '8.8.8.8', family: 4 }]; }, clientFactory: () => ({
    request: async () => ({ statusCode: 302, headers: { location: target }, body: Readable.from([]) }), destroy: async () => {}
  }) });
  await assert.rejects(request(origin), { code: 'source_url_unsafe' }); assert.equal(destinations.length, 1);
  target = 'https://other.example/';
  await assert.rejects(request(`${origin}/login/token.php`, { method: 'POST', authenticated: true, body: 'password=SYNTHETIC' }), { code: 'source_auth_redirect' });
  await assert.rejects(request(origin), { code: 'source_redirect_limit' });
  await assert.rejects(request(origin, { method: 'POST' }), { code: 'source_method_unsafe' });
  await assert.rejects(request(`${origin}/write.php`, { method: 'POST', authenticated: true }), { code: 'source_auth_endpoint_unsafe' });
});

test('transport enforces max bytes and maps timeout without upstream messages', async () => {
  const request = createSafeRequest({ resolver: async () => [{ address: '8.8.8.8', family: 4 }], clientFactory: () => ({
    request: async () => ({ statusCode: 200, headers: {}, body: Readable.from(['x'.repeat(1_048_577)]) }), destroy: async () => {}
  }) });
  await assert.rejects(request(origin), { code: 'source_too_large' });
  const timeout = createSafeRequest({ resolver: async () => [{ address: '8.8.8.8', family: 4 }], clientFactory: () => ({ request: async () => { throw Object.assign(new Error('PRIVATE'), { code: 'UND_ERR_HEADERS_TIMEOUT' }); }, destroy: async () => {} }) });
  await assert.rejects(timeout(origin), error => error.code === 'source_timeout' && !error.message.includes('PRIVATE'));
});

test('unknown university discovers immediately; proposer gets schema only and recipe is reused across users', async () => {
  const f = fixture(`${origin}/student-alice/schedule?student=123`); let observations = [], reads = 0;
  const service = createSourceService({ store: f.store, request: async () => { reads++; return json({ events: [{ ...event, password: 'PRIVATE', student123: 'Alice' }] }); }, proposeRecipe: async o => { observations.push(o); return recipe; }, now: () => 1792915200000 });
  const result = await service.discover(args);
  assert.equal(result.status, 'ready'); assert.equal(reads, 1);
  const stored = f.snapshots.get('schedule').items[0];
  assert.equal(stored.startsAt, '2026-10-25T06:00:00.000Z'); assert.equal(stored.connectionId, 'con-a'); assert.equal(stored.sourceUrl, f.connection.sourceUrl); assert.equal(stored.fetchedAt, '2026-10-25T08:00:00.000Z');
  const shared = JSON.stringify([...f.adapters.values()]); const prompt = JSON.stringify(observations);
  for (const value of ['student-alice', '123', 'PRIVATE', 'Alice']) { assert(!shared.includes(value)); assert(!prompt.includes(value)); }
  await service.sync(args); assert.equal(observations.length, 1);
  // Reuse the shared adapter on a completely different user/connection without sharing snapshots.
  const other = fixture(`${origin}/student-bob/schedule`, { id: 'con-b', userId: 'bob', spaceId: 'space-b' });
  for (const adapter of f.adapters.values()) other.store.putAdapter(adapter);
  const result2 = await createSourceService({ store: other.store, request: async () => json({ events: [event] }), proposeRecipe: () => { throw new Error('must reuse'); } }).sync({ userId: 'bob', connectionId: 'con-b' });
  assert.equal(result2.status, 'ready'); assert.notEqual(other.snapshots.get('schedule').items[0].id, stored.id);
});

test('ownership precedes all network/proposer/secret calls and disconnect during fetch prevents writes', async () => {
  const f = fixture(); let called = 0;
  const service = createSourceService({ store: f.store, request: async () => { called++; f.connection.deleted = true; return json({ events: [event] }); }, proposeRecipe: async () => recipe });
  assert.throws(() => service.sync({ ...args, userId: 'mallory' }), { status: 404 }); assert.equal(called, 0);
  await assert.rejects(service.discover(args), { status: 404 }); assert.equal(f.snapshots.size, 0); assert.equal(f.adapters.size, 0);
});

test('malformed candidate recipes cannot execute code, change endpoints or activate shared adapters', async () => {
  for (const patch of [{ path: '/student-123' }, { method: 'POST' }, { code: 'process.exit()' }, { fields: { id: '__proto__', title: 'title' } }, { itemsPath: 'constructor.prototype' }, { kind: 'schedule', fields: { id: 'id', title: 'title' } }]) {
    assert.throws(() => validateRecipe({ ...recipe, ...patch }), { code: 'source_recipe_invalid' });
    const f = fixture();
    const result = await createSourceService({ store: f.store, request: async () => json({ events: [event] }), proposeRecipe: async () => ({ ...recipe, ...patch }) }).discover(args);
    assert.equal(result.status, 'user_action_required'); assert.equal(f.snapshots.size, 0); assert.equal(f.adapters.size, 0);
  }
});

test('unmapped/ambiguous data and upstream failures preserve last complete snapshot', async () => {
  const f = fixture(); let response = json({ events: [event] });
  const service = createSourceService({ store: f.store, request: async () => response, proposeRecipe: async () => recipe });
  await service.discover(args); const previous = f.snapshots.get('schedule');
  for (const bad of [json({ events: [{ ...event, start: 'tomorrow' }] }), json({ events: [{ ...event, start: '2026-02-30T09:00:00Z' }] }), json({ events: [event, event] }), json({ events: [event, { title: 'missing id' }] }), json({}, 401), json({}, 403), json({}, 429), json({}, 503), { status: 200, headers: { 'content-type': 'application/json' }, body: 'INVALID' }]) {
    response = bad; const result = await service.sync(args); assert.notEqual(result.status, 'ready'); assert.deepEqual(f.snapshots.get('schedule'), previous);
  }
});

test('public HTML stores sanitized provenance and HSE-style SSO requests user action honestly', async () => {
  const f = fixture(); let response = html('<title>University FAQ</title><nav>menu</nav><script>secret();</script><p>Library opens at 9.</p><form>csrf=PRIVATE</form>');
  const service = createSourceService({ store: f.store, request: async () => response });
  assert.equal((await service.discover(args)).status, 'ready');
  const document = [...f.documents.values()][0]; assert.equal(document.text, 'University FAQ Library opens at 9.'); assert.equal(document.url, f.connection.sourceUrl);
  response = html('<form><input type="password"/>Sign in to SSO</form>');
  const result = await service.sync(args); assert.equal(result.status, 'user_action_required'); assert.equal(f.documents.size, 1);
  const hse = fixture('https://lms.hse.ru/');
  const redirect = await createSourceService({ store: hse.store, request: async () => ({ ...html('login'), url: 'https://sso.hse.ru/login' }) }).discover(args);
  assert.equal(redirect.status, 'user_action_required'); assert.equal(hse.documents.size, 0);
});

test('CSV quoted cells, explicit mapping, and malformed rows', async () => {
  const f = fixture();
  const candidate = { version: 1, path: '$source', format: 'csv', kind: 'courses', fields: { id: 'id', title: 'title' } };
  const result = await createSourceService({ store: f.store, request: async () => ({ status: 200, headers: { 'content-type': 'text/csv' }, body: 'id,title\r\n1,"Arts, science"\r\n2,"A ""quote"""' }), proposeRecipe: async () => candidate }).discover(args);
  assert.equal(result.status, 'ready'); assert.equal(f.snapshots.get('courses').items[0].title, 'Arts, science');
  for (const text of ['id,id\n1,2', 'id,title\n1', 'id,title\n1,"unclosed', '__proto__,title\n1,x']) assert.throws(() => parseCsv(text));
});

test('same-connection concurrent discovery/sync deduplicates across service instances', async () => {
  const f = fixture(); let release, reads = 0;
  const transport = async () => { reads++; await new Promise(r => { release = r; }); return html('<p>Public</p>'); };
  const a = createSourceService({ store: f.store, request: transport }), b = createSourceService({ store: f.store, request: transport });
  const first = a.discover(args), second = b.sync(args); assert.equal(first, second); release(); await first; assert.equal(reads, 1);
});

test('MISIS token/password flow stays executor-only and only calls bounded read functions', async () => {
  const f = fixture('https://newlms.misis.ru/'); const secret = { origin: 'https://newlms.misis.ru', username: 'synthetic', password: 'FAKE-PASSWORD' };
  f.secrets.set('con-a', secret); const calls = []; let proposed = false;
  const transport = async (url, options) => {
    calls.push({ url, options }); const p = new URLSearchParams(options.body);
    if (url.endsWith('/login/token.php')) return json({ token: 'FAKE-TOKEN-12345' });
    if (p.get('wsfunction') === 'core_webservice_get_site_info') return json({ userid: 42 });
    if (p.get('wsfunction') === 'core_enrol_get_users_courses') return json([{ id: 8, fullname: 'Physics' }]);
    if (p.get('wsfunction') === 'mod_assign_get_assignments') return json({ courses: [{ id: 8, assignments: [{ id: 9, cmid: 11, name: 'Homework', duedate: 1793000000 }] }] });
    throw new Error('unapproved function');
  };
  const service = createSourceService({ store: f.store, request: transport, proposeRecipe: () => { proposed = true; } });
  const result = await service.sync(args); assert.equal(result.status, 'ready'); assert.equal(proposed, false); assert.equal(calls.length, 4);
  assert(calls.every(c => c.url.startsWith(secret.origin) && c.options.authenticated && c.options.method === 'POST'));
  assert.deepEqual(f.secrets.get('con-a'), { origin: secret.origin, token: 'FAKE-TOKEN-12345' });
  for (const value of ['FAKE-PASSWORD', 'FAKE-TOKEN']) assert(!JSON.stringify({ result, snapshots: [...f.snapshots.values()], adapters: [...f.adapters.values()] }).includes(value));
  await service.sync(args); assert.equal(calls.filter(c => c.url.endsWith('/login/token.php')).length, 1);
});

test('credentials cannot cross origin and unavailable Moodle deadlines preserve prior data', async () => {
  const f = fixture('https://newlms.misis.ru/'); let calls = 0;
  f.secrets.set('con-a', { origin, token: 'FAKE-TOKEN-12345' });
  const denied = await createSourceService({ store: f.store, request: () => { calls++; } }).sync(args);
  assert.equal(denied.status, 'user_action_required'); assert.equal(calls, 0);
  f.secrets.set('con-a', { origin: 'https://newlms.misis.ru', token: 'FAKE-TOKEN-12345' });
  f.snapshots.set('deadlines', { previous: true });
  const result = await createSourceService({ store: f.store, request: async (_url, options) => {
    const fn = new URLSearchParams(options.body).get('wsfunction');
    if (fn === 'core_webservice_get_site_info') return json({ userid: 1 });
    if (fn === 'core_enrol_get_users_courses') return json([{ id: 8, fullname: 'Physics' }]);
    return json({}, 503);
  } }).sync(args);
  assert.equal(result.partial, true); assert.equal(result.status, 'error'); assert.deepEqual(f.snapshots.get('deadlines'), { previous: true }); assert.equal(f.snapshots.get('courses').items.length, 1);
});

test('conservative built-in JSON/CSV discovery works without a model and refuses ambiguous columns', async () => {
  const f = fixture();
  const service = createSourceService({ store: f.store, request: async () => json({ events: [event] }) });
  assert.equal((await service.discover(args)).status, 'ready');
  const ambiguous = fixture();
  const result = await createSourceService({ store: ambiguous.store, request: async () => json({ events: [{ ...event, name: 'Other name' }] }) }).discover(args);
  assert.equal(result.status, 'user_action_required'); assert.equal(ambiguous.snapshots.size, 0);
  const csv = fixture();
  assert.equal((await createSourceService({ store: csv.store, request: async () => ({ status: 200, headers: { 'content-type': 'text/csv' }, body: 'id,title,start\n1,Algebra,2026-10-25T09:00:00Z' }) }).discover(args)).status, 'ready');
});

test('paginated/partial public envelopes preserve the previous complete snapshot', async () => {
  const f = fixture(); let response = json({ events: [event] });
  const service = createSourceService({ store: f.store, request: async () => response });
  await service.discover(args); const previous = f.snapshots.get('schedule');
  for (const marker of [{ next: '/?page=2' }, { has_more: true }, { partial: true }, { complete: false }, { total_count: 2 }, { pagination: { page: 1, pages: 2 } }]) {
    response = json({ events: [{ ...event, title: 'Partial new data' }], ...marker });
    assert.equal((await service.sync(args)).status, 'user_action_required'); assert.deepEqual(f.snapshots.get('schedule'), previous);
  }
});

test('injected transports retain executor timeout boundaries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const pending = createSourceService({ store: f.store, request: () => new Promise(() => {}) }).discover(args);
  t.mock.timers.tick(10_001);
  const result = await pending;
  assert.equal(result.errorCode, 'source_timeout'); assert.equal(result.status, 'error'); assert.equal(f.snapshots.size, 0);
});

test('Moodle incomplete course responses and reflected active tokens never overwrite deadlines or leak tokens', async () => {
  const f = fixture('https://newlms.misis.ru/');
  f.secrets.set('con-a', { origin: 'https://newlms.misis.ru', token: 'FAKE-TOKEN-12345' });
  f.snapshots.set('deadlines', { previous: true });
  const service = createSourceService({ store: f.store, request: async (_url, options) => {
    const fn = new URLSearchParams(options.body).get('wsfunction');
    if (fn === 'core_webservice_get_site_info') return json({ userid: 1 });
    if (fn === 'core_enrol_get_users_courses') return json([{ id: 8, fullname: 'FAKE-TOKEN-12345 Physics' }]);
    return json({ courses: [] });
  } });
  const result = await service.sync(args); assert.equal(result.partial, true); assert.deepEqual(f.snapshots.get('deadlines'), { previous: true });
  assert(!JSON.stringify([...f.snapshots.values()]).includes('FAKE-TOKEN'));
});

test('configured OAuth transport binds one exact form endpoint and refuses credential redirects', async () => {
  let sent;
  const request = createSafeRequest({ boundAuthEndpoint: 'https://identity.example/oauth/token', resolver: async () => [{ address: '8.8.8.8', family: 4 }], clientFactory: () => ({
    request: async options => { sent = options; return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: Readable.from(['{"access_token":"SYNTHETIC"}']) }; }, destroy: async () => {}
  }) });
  const response = await request('https://identity.example/oauth/token', { method: 'POST', authenticated: true, body: 'grant_type=authorization_code&code=SYNTHETIC', headers: { authorization: 'NEVER', cookie: 'NEVER' } });
  assert.equal(response.status, 200); assert.equal(sent.headers['content-type'], 'application/x-www-form-urlencoded'); assert.equal(sent.headers.authorization, undefined);
  await assert.rejects(request('https://other.example/oauth/token', { method: 'POST', authenticated: true, body: 'code=SYNTHETIC' }), { code: 'source_auth_endpoint_unsafe' });
});
