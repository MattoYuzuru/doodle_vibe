import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { AppError } from '../src/errors.mjs';
import { createStore } from '../src/store.mjs';
import { createApp } from '../src/http.mjs';
import { createWorker } from '../src/worker.mjs';
import { createSourceService } from '../src/sources/index.mjs';
import { createSafeRequest, validateSourceUrl } from '../src/sources/network.mjs';
import { describeAuthMethods, presetForOrigin } from '../src/sources/presets.mjs';
import { parseIcal, icalSnapshots } from '../src/sources/ical.mjs';
import { parseResponse } from '../src/sources/recipes.mjs';

// Every payload here is synthetic: invented names, ids and tokens, never an export.
const NOW = Date.parse('2026-10-25T12:00:00Z');
const key = Buffer.alloc(32, 9);
const EDU = 'https://edu.hse.ru';
const RUZ = 'https://ruz.hse.ru';
const FEED = `${EDU}/calendar/export_execute.php?userid=7&authtoken=SECRETFEED77&preset_what=all&preset_time=custom`;
const json = (data, extra = {}) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data), ...extra });
const ics = body => ({ status: 200, headers: { 'content-type': 'text/calendar; charset=utf-8' }, body });
const page = (body, extra = {}) => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body, ...extra });

const MOODLE_ICS = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Synthetic LMS//EN',
  'BEGIN:VEVENT', 'UID:101@lms.example', 'SUMMARY:Homework 1 is due', 'DTSTART:20261030T200000Z', 'DTEND:20261030T200000Z', 'CATEGORIES:Linear Algebra',
  'DESCRIPTION:Submit before the deadline\\, please', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:102@lms.example', 'SUMMARY:Consultation', 'DTSTART:20261028T090000Z', 'DTEND:20261028T103000Z', 'CATEGORIES:Linear Algebra', 'LOCATION:Room 305', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:103@lms.example', 'SUMMARY:Quiz closes', 'DTSTART:20261101T150000Z', 'CATEGORIES:Statistics', 'END:VEVENT',
  'BEGIN:VEVENT', 'UID:104@lms.example', 'SUMMARY:Cancelled', 'STATUS:CANCELLED', 'DTSTART:20261029T090000Z', 'END:VEVENT',
  'END:VCALENDAR', ''].join('\r\n');

function environment() {
  const store = createStore({ dbPath: ':memory:', masterKey: key, now: () => NOW });
  store.ensureUser({ id: 'u1', displayName: 'Synthetic' });
  store.ensureUser({ id: 'u2', displayName: 'Other' });
  const space = store.createSpace('u1', { universityId: 'hse', name: 'HSE' });
  return { store, space };
}
function connect(e, sourceUrl, kind = 'lms', user = 'u1') {
  return e.store.createConnection(user, e.space.id, { sourceUrl, kind });
}
function transport(table) {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    const entry = table[url] ?? table[new URL(url).origin + new URL(url).pathname];
    if (!entry) throw new AppError('source_unavailable', 502);
    return typeof entry === 'function' ? entry(url, options) : entry;
  };
  return { request, calls };
}
const service = (e, t) => createSourceService({ store: e.store, request: t.request, now: () => NOW });
const run = (svc, c, mode = 'sync') => svc[mode]({ userId: 'u1', connectionId: c.id });
const snapshot = (e, c, kind) => e.store.listSnapshots('u1', e.space.id, { kind }).find(s => s.connectionId === c.id);

test('known universities are data presets and describe credential forms in a stable order', () => {
  assert.equal(presetForOrigin(EDU).university.id, 'hse');
  assert.equal(presetForOrigin(RUZ).source.type, 'ruz');
  assert.equal(presetForOrigin('https://newlms.misis.ru').source.type, 'moodle');
  assert.equal(presetForOrigin('https://university.example'), null);
  assert.deepEqual(describeAuthMethods(EDU).map(m => m.id), ['calendar_url', 'moodle_token', 'moodle_password']);
  assert.deepEqual(describeAuthMethods('https://newlms.misis.ru').map(m => m.id), ['moodle_password', 'moodle_token', 'calendar_url']);
  assert.deepEqual(describeAuthMethods(RUZ).map(m => [m.id, m.type, m.fields]), [['ruz_identifier', 'identifier', ['identifier']]]);
  assert.deepEqual(describeAuthMethods('https://x.example', { version: 1, type: 'moodle' }).map(m => m.id), ['moodle_password', 'moodle_token', 'calendar_url']);
  assert.deepEqual(describeAuthMethods('https://x.example'), []);
});

test('iCal parser handles folding, escapes, zones, all-day, cancelled events and bounded recurrence', () => {
  const text = [
    'BEGIN:VCALENDAR', 'X-WR-TIMEZONE:Europe/Moscow',
    'BEGIN:VEVENT', 'UID:a', 'SUMMARY:Algebra\\, part', ' two', 'DTSTART;TZID=Europe/Moscow:20261026T093000', 'DTEND;TZID=Europe/Moscow:20261026T110000', 'LOCATION:Aud 1\\;2', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b', 'SUMMARY:Floating', 'DTSTART:20261027T100000', 'DURATION:PT1H30M', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:c', 'SUMMARY:All day', 'DTSTART;VALUE=DATE:20261028', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:d', 'SUMMARY:Weekly', 'DTSTART;TZID=Europe/Moscow:20261026T180000', 'DTEND;TZID=Europe/Moscow:20261026T193000',
    'RRULE:FREQ=WEEKLY;BYDAY=MO,TH;COUNT=5', 'EXDATE;TZID=Europe/Moscow:20261029T180000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:d', 'RECURRENCE-ID;TZID=Europe/Moscow:20261102T180000', 'SUMMARY:Weekly moved', 'DTSTART;TZID=Europe/Moscow:20261103T180000', 'DTEND;TZID=Europe/Moscow:20261103T193000', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:e', 'SUMMARY:Gone', 'STATUS:CANCELLED', 'DTSTART:20261026T090000Z', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:old', 'SUMMARY:Ancient', 'DTSTART:20200101T090000Z', 'DTEND:20200101T100000Z', 'END:VEVENT',
    'END:VCALENDAR'].join('\r\n');
  const events = parseIcal(text, { now: NOW });
  const summary = events.map(e => [e.summary, new Date(e.startMs).toISOString(), new Date(e.endMs).toISOString()]);
  assert.deepEqual(summary, [
    ['Algebra, parttwo', '2026-10-26T06:30:00.000Z', '2026-10-26T08:00:00.000Z'],
    ['Weekly', '2026-10-26T15:00:00.000Z', '2026-10-26T16:30:00.000Z'],
    ['Floating', '2026-10-27T07:00:00.000Z', '2026-10-27T08:30:00.000Z'],
    ['All day', '2026-10-27T21:00:00.000Z', '2026-10-28T21:00:00.000Z'],
    ['Weekly moved', '2026-11-03T15:00:00.000Z', '2026-11-03T16:30:00.000Z'],
    ['Weekly', '2026-11-05T15:00:00.000Z', '2026-11-05T16:30:00.000Z'],
    ['Weekly', '2026-11-09T15:00:00.000Z', '2026-11-09T16:30:00.000Z'],
  ]);
  assert.equal(events[0].location, 'Aud 1;2');
  assert.throws(() => parseIcal('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Monthly\r\nDTSTART:20261026T090000Z\r\nRRULE:FREQ=MONTHLY\r\nEND:VEVENT\r\nEND:VCALENDAR', { now: NOW }), { code: 'source_format_unsupported' });
  assert.throws(() => parseIcal('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Broken\r\nDTSTART:2026-13-40\r\nEND:VEVENT\r\nEND:VCALENDAR', { now: NOW }), { code: 'source_response_invalid' });
  assert.throws(() => parseIcal('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Open', { now: NOW }), { code: 'source_response_invalid' });
  assert.throws(() => parseIcal('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Zone\r\nDTSTART;TZID=Nowhere/Land:20261026T090000\r\nEND:VEVENT\r\nEND:VCALENDAR', { now: NOW }), { code: 'source_format_unsupported' });
  assert.equal(parseResponse(ics(MOODLE_ICS)).format, 'ical');
  assert.equal(parseResponse({ status: 200, headers: { 'content-type': 'text/plain' }, body: MOODLE_ICS }).format, 'ical');
  assert.throws(() => parseResponse({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'hello' }), { code: 'source_format_unsupported' });
  const connection = { id: 'c1', sourceUrl: EDU + '/' };
  const snapshots = icalSnapshots(parseIcal(MOODLE_ICS, { now: NOW }), { mode: 'moodle', connection, fetchedAt: '2026-10-25T12:00:00.000Z', fallbackUrl: `${EDU}/calendar/view.php?view=upcoming` });
  assert.deepEqual(snapshots.deadlines.map(d => [d.title, d.dueAt]), [['Homework 1 is due', '2026-10-30T20:00:00.000Z'], ['Quiz closes', '2026-11-01T15:00:00.000Z']]);
  assert.deepEqual(snapshots.schedule.map(s => [s.title, s.startsAt, s.endsAt, s.location]), [['Consultation', '2026-10-28T09:00:00.000Z', '2026-10-28T10:30:00.000Z', 'Room 305']]);
  assert.deepEqual(snapshots.courses.map(c => c.title).sort(), ['Linear Algebra', 'Statistics']);
  assert.equal(snapshots.deadlines[0].courseId, snapshots.courses.find(c => c.title === 'Linear Algebra').id);
});

test('HSE Smart LMS: preset needs no network at discovery and offers calendar export first', async () => {
  const e = environment(); const t = transport({});
  const c = connect(e, `${EDU}/`);
  const result = await run(service(e, t), c, 'discover');
  assert.equal(result.status, 'user_action_required'); assert.equal(result.errorCode, 'source_auth_required');
  assert.deepEqual(result.authMethods, ['calendar_url', 'moodle_token', 'moodle_password']);
  assert.equal(t.calls.length, 0);
  assert.equal(e.store.getConnection('u1', c.id).status, 'user_action_required');
});

test('HSE calendar export: private feed is bound to origin, never redirected and never stored in public data', async () => {
  const e = environment(); const c = connect(e, `${EDU}/`);
  e.store.setSecret('u1', c.id, { origin: EDU, calendarUrl: FEED });
  const t = transport({ [FEED]: ics(MOODLE_ICS.replace('Consultation', 'Consultation SECRETFEED77')) });
  const result = await run(service(e, t), c);
  assert.equal(result.status, 'ready'); assert.deepEqual(result.counts, { courses: 2, deadlines: 2, schedule: 1 });
  assert.equal(t.calls.length, 1);
  assert.deepEqual(t.calls[0].options, { secretUrl: true, boundOrigin: EDU });
  const stored = JSON.stringify(['courses', 'deadlines', 'schedule'].map(kind => snapshot(e, c, kind)));
  assert.ok(!stored.includes('authtoken') && !stored.includes('SECRETFEED77') && !stored.includes('userid=7'));
  assert.ok(stored.includes('Consultation [redacted]'), 'tokens echoed in event text are scrubbed');
  assert.equal(JSON.stringify(e.store.getConnection('u1', c.id)).includes('SECRETFEED77'), false);
  // Other users never read the feed secret or snapshot.
  assert.throws(() => e.store.readSecret('u2', c.id), { status: 404 });
});

test('calendar export failures ask for a new link and keep the previous snapshot', async () => {
  const e = environment(); const c = connect(e, `${EDU}/`);
  e.store.setSecret('u1', c.id, { origin: EDU, calendarUrl: FEED });
  let reply = ics(MOODLE_ICS);
  const t = transport({ [FEED]: () => reply }); const svc = service(e, t);
  assert.equal((await run(svc, c)).status, 'ready');
  const before = snapshot(e, c, 'deadlines').items.length;
  reply = page('Invalid authentication');
  const revoked = await run(svc, c);
  assert.equal(revoked.status, 'user_action_required'); assert.equal(revoked.errorCode, 'source_auth_required');
  reply = { status: 302, headers: { location: 'https://evil.example/' }, body: '' };
  assert.equal((await run(svc, c)).status, 'error');
  assert.equal(snapshot(e, c, 'deadlines').items.length, before);
  for (const calendarUrl of ['https://evil.example/calendar/export_execute.php?authtoken=x', `${EDU}/admin/delete.php?authtoken=x`, 'http://edu.hse.ru/calendar/export_execute.php?x=1']) {
    e.store.setSecret('u1', c.id, { origin: EDU, calendarUrl });
    const calls = t.calls.length;
    assert.equal((await run(svc, c)).errorCode, 'source_auth_required');
    assert.equal(t.calls.length, calls, 'invalid feed URL never reaches the network');
  }
});

test('secret feed transport: token query allowed only for GET on the bound origin, no redirects, no credentials', async () => {
  assert.throws(() => validateSourceUrl(FEED), { code: 'source_url_secret' });
  assert.equal(validateSourceUrl(FEED, { allowSecretQuery: true }).origin, EDU);
  let sent; let status = 200;
  const request = createSafeRequest({ resolver: async () => [{ address: '8.8.8.8', family: 4 }], clientFactory: () => ({
    request: async options => { sent = options; return { statusCode: status, headers: status === 200 ? { 'content-type': 'text/calendar' } : { location: 'https://other.example/' }, body: Readable.from(['BEGIN:VCALENDAR']) }; }, destroy: async () => {},
  }) });
  assert.equal((await request(FEED, { secretUrl: true, boundOrigin: EDU, headers: { authorization: 'NEVER', cookie: 'NEVER' } })).status, 200);
  assert.ok(sent.path.includes('authtoken')); assert.equal(sent.headers.authorization, undefined); assert.equal(sent.headers.cookie, undefined); assert.match(sent.headers.accept, /text\/calendar/);
  await assert.rejects(request(FEED, { secretUrl: true, boundOrigin: 'https://other.example' }), { code: 'source_auth_origin_unsafe' });
  await assert.rejects(request(FEED, { secretUrl: true }), { code: 'source_auth_origin_unsafe' });
  await assert.rejects(request(FEED, { secretUrl: true, boundOrigin: EDU, method: 'POST', authenticated: true }), { code: 'source_method_unsafe' });
  await assert.rejects(request(FEED, { secretUrl: true, authenticated: true, boundOrigin: EDU }), { code: 'source_method_unsafe' });
  await assert.rejects(request(FEED), { code: 'source_url_secret' });
  status = 302;
  await assert.rejects(request(FEED, { secretUrl: true, boundOrigin: EDU }), { code: 'source_auth_redirect' });
});

test('Moodle token/password on a preset or detected origin still goes through bounded web-service reads', async () => {
  const e = environment(); const c = connect(e, `${EDU}/`);
  e.store.setSecret('u1', c.id, { origin: EDU, username: 'synthetic', password: 'FAKE-PASSWORD-1' });
  const t = transport({
    [`${EDU}/login/token.php`]: json({ error: 'Invalid login', errorcode: 'invalidlogin' }),
  });
  const result = await run(service(e, t), c);
  assert.equal(result.status, 'user_action_required'); assert.equal(result.errorCode, 'source_auth_required');
  assert.equal(t.calls.length, 1); assert.equal(t.calls[0].url, `${EDU}/login/token.php`);
});

test('RUZ: preset adapter asks for an identifier without network and shows the network-only note', async () => {
  const e = environment(); const t = transport({});
  const c = connect(e, `${RUZ}/`, 'schedule');
  const result = await run(service(e, t), c, 'discover');
  assert.equal(result.errorCode, 'source_auth_required'); assert.deepEqual(result.authMethods, ['ruz_identifier']);
  assert.equal(t.calls.length, 0);
  assert.deepEqual(describeAuthMethods(RUZ)[0].notes, ['university_network_only']);
});

const lesson = (oid, date, begin, end, name, extra = {}) => ({ lessonOid: oid, date, beginLesson: begin, endLesson: end, discipline: name, auditorium: 'Room 101', building: 'Main building', kindOfWork: 'Lecture', lecturer: 'Synthetic Lecturer', ...extra });
const week = '2026.10.18';
function ruzTable({ search = [{ id: '555', label: 'Synthetic Student', description: 'student@edu.hse.ru', type: 'student' }], lessons = [lesson(9001, '2026.10.27', '10:30', '11:50', 'Calculus'), lesson(9002, '2026.10.28', '9:00', '10:20', 'Algebra')] } = {}) {
  return {
    [`${RUZ}/api/search?term=${encodeURIComponent('student@edu.hse.ru')}&type=student`]: () => json(search),
    [`${RUZ}/api/schedule/student/555?start=${week}&finish=2026.12.20&lng=1`]: () => json(lessons),
  };
}

test('RUZ: email resolves one student, schedule is Moscow time, id is cached in the encrypted secret only', async () => {
  const e = environment(); const c = connect(e, `${RUZ}/`, 'schedule');
  e.store.setSecret('u1', c.id, { origin: RUZ, identifier: 'student@edu.hse.ru' });
  const t = transport(ruzTable()); const svc = service(e, t);
  const first = await run(svc, c);
  assert.equal(first.status, 'ready'); assert.deepEqual(first.counts, { schedule: 2 });
  const items = snapshot(e, c, 'schedule').items;
  assert.deepEqual(items.map(i => [i.title, i.startsAt, i.endsAt, i.location, i.description]), [
    ['Calculus', '2026-10-27T07:30:00.000Z', '2026-10-27T08:50:00.000Z', 'Room 101, Main building', 'Lecture · Synthetic Lecturer'],
    ['Algebra', '2026-10-28T06:00:00.000Z', '2026-10-28T07:20:00.000Z', 'Room 101, Main building', 'Lecture · Synthetic Lecturer'],
  ]);
  assert.ok(items.every(i => i.connectionId === c.id && i.sourceUrl === `${RUZ}/` && i.fetchedAt === new Date(NOW).toISOString()));
  const publicData = JSON.stringify([items, e.store.getConnection('u1', c.id)]);
  assert.ok(!publicData.includes('555') && !publicData.includes('student@'));
  assert.equal(e.store.readSecret('u1', c.id).studentId, '555');
  assert.equal(t.calls.length, 2);
  await run(svc, c);
  assert.equal(t.calls.length, 3, 'second sync skips the person search');
  assert.ok(t.calls.every(call => call.options === undefined));
});

test('RUZ: numeric id skips search; ambiguous, missing and malformed answers never guess or erase data', async () => {
  const e = environment(); const c = connect(e, `${RUZ}/`, 'schedule');
  e.store.setSecret('u1', c.id, { origin: RUZ, identifier: '555' });
  const t = transport(ruzTable()); const svc = service(e, t);
  assert.equal((await run(svc, c)).status, 'ready'); assert.equal(t.calls.length, 1);
  const stored = snapshot(e, c, 'schedule').items.length;
  // A second person sharing the e-mail-like label stays ambiguous.
  const two = [{ id: '1', label: 'Ivan A', description: 'a', type: 'student' }, { id: '2', label: 'Ivan B', description: 'b', type: 'student' }];
  e.store.setSecret('u1', c.id, { origin: RUZ, identifier: 'student@edu.hse.ru' });
  const ambiguous = await run(service(e, transport(ruzTable({ search: two }))), c);
  assert.equal(ambiguous.status, 'user_action_required'); assert.equal(ambiguous.errorCode, 'source_identifier_ambiguous');
  const missing = await run(service(e, transport(ruzTable({ search: [] }))), c);
  assert.equal(missing.errorCode, 'source_identifier_not_found');
  // Exact label/description match disambiguates; a mere substring of a name does not.
  const exact = await run(service(e, transport(ruzTable({ search: [...two, { id: '555', label: 'Student', description: 'student@edu.hse.ru', type: 'student' }] }))), c);
  assert.equal(exact.status, 'ready');
  e.store.setSecret('u1', c.id, { origin: RUZ, identifier: '555' });
  for (const lessons of [{}, null, [{ discipline: 'No time', date: '2026.10.27' }], [lesson(1, '2026.10.27', '12:00', '11:00', 'Backwards')]]) {
    const result = await run(service(e, transport(ruzTable({ lessons }))), c);
    assert.equal(result.status, 'error'); assert.equal(result.errorCode, 'source_response_invalid');
  }
  assert.equal(snapshot(e, c, 'schedule').items.length, stored);
});

test('RUZ outside the university network is reported as an actionable restriction', async () => {
  const e = environment(); const c = connect(e, `${RUZ}/`, 'schedule');
  e.store.setSecret('u1', c.id, { origin: RUZ, identifier: '555' });
  const stub = page('<title>Schedule</title><p>Access only from the internal network</p>', { url: 'https://www.hse.ru/eduland/schedule/?start=1' });
  const result = await run(service(e, transport({ [`${RUZ}/api/schedule/student/555?start=${week}&finish=2026.12.20&lng=1`]: () => stub })), c);
  assert.equal(result.status, 'user_action_required'); assert.equal(result.errorCode, 'source_network_restricted');
  const html = await run(service(e, transport({ [`${RUZ}/api/schedule/student/555?start=${week}&finish=2026.12.20&lng=1`]: () => page('<p>stub</p>', { url: `${RUZ}/api/x` }) })), c);
  assert.equal(html.errorCode, 'source_network_restricted');
});

test('universal detection: any Moodle is identified by its web-service error shape, even behind SSO redirects', async () => {
  for (const redirected of [false, true]) {
    const e = environment(); const c = connect(e, 'https://lms.other.example/');
    const t = transport({
      'https://lms.other.example/': redirected ? page('<p>Sign in with SSO</p>', { url: 'https://sso.other.example/login' }) : page('<title>Welcome</title><a href="/login/hselogin.php">Sign in</a>'),
      'https://lms.other.example/login/token.php': json({ error: 'Missing parameter', errorcode: 'missingparam', stacktrace: null, debuginfo: null, reproductionlink: null }),
    });
    const result = await run(service(e, t), c, 'discover');
    assert.equal(result.status, 'user_action_required'); assert.equal(result.errorCode, 'source_auth_required');
    assert.match(result.adapterId, /^moodle:/); assert.deepEqual(result.authMethods, ['moodle_password', 'moodle_token', 'calendar_url']);
    assert.deepEqual(e.store.getAdapter(result.adapterId).recipe, { version: 1, type: 'moodle' });
    // A second user at the same origin reuses the adapter without another probe.
    const other = e.store.createConnection('u1', e.space.id, { sourceUrl: 'https://lms.other.example/', kind: 'lms' });
    const before = t.calls.length;
    assert.equal((await run(service(e, t), other, 'discover')).errorCode, 'source_auth_required'); assert.equal(t.calls.length, before);
  }
  const e = environment(); const c = connect(e, 'https://shop.example/');
  const t = transport({ 'https://shop.example/': page('<title>Shop</title><p>Hello</p>'), 'https://shop.example/login/token.php': json({ ok: true }) });
  assert.equal((await run(service(e, t), c, 'discover')).status, 'ready', 'a non-Moodle site stays a public document source');
  const web = connect(e, 'https://blog.example/', 'website'); const w = transport({ 'https://blog.example/': page('<title>Blog</title><p>Text</p>') });
  await run(service(e, w), web, 'discover'); assert.equal(w.calls.length, 1, 'only LMS-kind sources are probed');
});

test('known non-Moodle LMS products are named instead of being guessed at', async () => {
  const e = environment(); const c = connect(e, 'https://learn.example/');
  const t = transport({ 'https://learn.example/': page('<title>Login</title><link href="https://x.instructure.com/a.css">'), 'https://learn.example/login/token.php': page('nope') });
  const result = await run(service(e, t), c, 'discover');
  assert.equal(result.status, 'user_action_required'); assert.equal(result.errorCode, 'source_lms_unsupported'); assert.equal(result.lms, 'canvas');
});

test('universal detection: a public iCal feed on any host becomes a schedule source and an ical adapter', async () => {
  const e = environment(); const c = connect(e, 'https://timetable.other.example/group-1.ics', 'schedule');
  const feed = ics(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:p1', 'SUMMARY:Physics', 'DTSTART:20261027T080000Z', 'DTEND:20261027T093000Z', 'LOCATION:Lab', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
  const t = transport({ 'https://timetable.other.example/group-1.ics': feed });
  const svc = service(e, t);
  const result = await run(svc, c, 'discover');
  assert.equal(result.status, 'ready'); assert.deepEqual(result.counts, { schedule: 1 }); assert.match(result.adapterId, /^ical:/);
  const [item] = snapshot(e, c, 'schedule').items;
  assert.equal(item.title, 'Physics'); assert.equal(item.startsAt, '2026-10-27T08:00:00.000Z'); assert.equal(item.url, 'https://timetable.other.example/group-1.ics');
  // Periodic sync uses the stored typed adapter with the same executor.
  assert.equal((await run(svc, e.store.getConnection('u1', c.id))).status, 'ready');
  const empty = connect(e, 'https://timetable.third.example/empty.ics', 'schedule');
  const none = await run(service(e, transport({ 'https://timetable.third.example/empty.ics': ics('BEGIN:VCALENDAR\r\nEND:VCALENDAR') })), empty, 'discover');
  assert.equal(none.errorCode, 'source_mapping_required');
});

test('a private iCal feed on a non-Moodle host is read from encrypted storage and never published', async () => {
  const e = environment(); const c = connect(e, 'https://timetable.other.example/', 'schedule');
  e.store.putAdapter({ id: 'ical:x', origin: 'https://timetable.other.example', version: 1, recipe: { version: 1, type: 'ical' }, capabilities: ['schedule'] });
  e.store.updateConnection('u1', c.id, { adapterId: 'ical:x' });
  const url = 'https://timetable.other.example/private.ics?key=PRIVATEKEY12345678';
  e.store.setSecret('u1', c.id, { origin: 'https://timetable.other.example', calendarUrl: url });
  const feed = ics(['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:p1', 'SUMMARY:Seminar PRIVATEKEY12345678', 'DTSTART:20261027T080000Z', 'DTEND:20261027T093000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'));
  const t = transport({ [url]: feed });
  const result = await run(service(e, t), e.store.getConnection('u1', c.id));
  assert.equal(result.status, 'ready'); assert.deepEqual(t.calls[0].options, { secretUrl: true, boundOrigin: 'https://timetable.other.example' });
  assert.ok(!JSON.stringify(snapshot(e, c, 'schedule')).includes('PRIVATEKEY'));
});

// --- HTTP: new credential forms and authMethods ---
const botToken = 'fixture-bot-token-only';
function sign(id) {
  const params = new URLSearchParams({ auth_date: String(Math.floor(NOW / 1000)), user: JSON.stringify({ id: Number(id), first_name: `Fixture ${id}` }) });
  const data = [...params].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  params.set('hash', createHmac('sha256', createHmac('sha256', 'WebAppData').update(botToken).digest()).update(data).digest('hex'));
  return params.toString();
}

test('HTTP: HSE connection exposes authMethods and accepts exactly one credential form', async t => {
  const store = createStore({ dbPath: ':memory:', masterKey: key, now: () => NOW });
  const table = { ...ruzTable(), [FEED]: ics(MOODLE_ICS) };
  const net = transport(table);
  const createSources = guarded => createSourceService({ store: guarded, request: net.request, now: () => NOW });
  const worker = createWorker({ store, createSources, now: () => NOW });
  const server = createApp({ store, config: { botToken, publicBaseUrl: 'https://doodle.example', version: 'fixture' }, createSources, now: () => NOW });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await worker.stop(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const api = async (path, { method = 'GET', body, id = '1' } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: { 'x-telegram-init-data': sign(id), ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const space = (await api('/api/v1/spaces', { method: 'POST', body: { universityId: 'hse', name: 'ВШЭ' } })).body.space;
  const lms = (await api(`/api/v1/spaces/${space.id}/connections`, { method: 'POST', body: { sourceUrl: `${EDU}/`, kind: 'lms' } })).body;
  const schedule = (await api(`/api/v1/spaces/${space.id}/connections`, { method: 'POST', body: { sourceUrl: `${RUZ}/`, kind: 'schedule' } })).body;
  await worker.tick(); await worker.tick();
  for (const created of [lms, schedule]) {
    const job = (await api(`/api/v1/jobs/${created.job.id}`)).body.job;
    assert.equal(job.status, 'succeeded'); assert.equal(job.result.status, 'user_action_required');
  }
  const detail = await api(`/api/v1/connections/${lms.connection.id}`);
  assert.deepEqual(detail.body.authMethods.map(m => [m.id, m.type, m.fields]), [['calendar_url', 'calendar_url', ['calendarUrl']], ['moodle_token', 'token', ['token']], ['moodle_password', 'password', ['username', 'password']]]);
  assert.deepEqual((await api(`/api/v1/connections/${schedule.connection.id}`)).body.authMethods.map(m => m.id), ['ruz_identifier']);
  // Exactly one form; foreign origin and foreign feed hosts are rejected before storage.
  const bad = [{ origin: EDU, calendarUrl: FEED, token: 'abcdefgh12' }, { origin: EDU, calendarUrl: 'https://evil.example/x.ics' }, { origin: EDU, calendarUrl: 'http://edu.hse.ru/x.ics' }, { origin: EDU }, { origin: EDU, identifier: '' }, { origin: EDU, username: 'u' }];
  for (const body of bad) assert.equal((await api(`/api/v1/connections/${lms.connection.id}/auth`, { method: 'POST', body })).status, 400);
  assert.equal((await api(`/api/v1/connections/${lms.connection.id}/auth`, { method: 'POST', body: { origin: RUZ, calendarUrl: FEED } })).body.error.code, 'SECRET_ORIGIN_MISMATCH');
  assert.equal(store.readSecret('1', lms.connection.id), null);
  const saved = await api(`/api/v1/connections/${lms.connection.id}/auth`, { method: 'POST', body: { origin: EDU, calendarUrl: FEED } });
  assert.equal(saved.status, 202);
  assert.equal((await api(`/api/v1/connections/${schedule.connection.id}/auth`, { method: 'POST', body: { origin: RUZ, identifier: 'student@edu.hse.ru' } })).status, 202);
  await worker.tick(); await worker.tick();
  const deadlines = await api(`/api/v1/spaces/${space.id}/deadlines`);
  assert.deepEqual(deadlines.body.items.map(i => i.title), ['Homework 1 is due', 'Quiz closes']);
  assert.equal((await api(`/api/v1/spaces/${space.id}/courses`)).body.items.length, 2);
  const sched = (await api(`/api/v1/spaces/${space.id}/schedule`)).body.items.map(i => i.title).sort();
  assert.deepEqual(sched, ['Algebra', 'Calculus', 'Consultation']);
  const everything = JSON.stringify([deadlines.body, (await api(`/api/v1/connections/${lms.connection.id}`)).body, (await api(`/api/v1/spaces/${space.id}/connections`)).body]);
  assert.ok(!everything.includes('SECRETFEED77') && !everything.includes('student@edu.hse.ru') && !everything.includes('authtoken'));
  // Another user cannot see or alter this connection.
  assert.equal((await api(`/api/v1/connections/${lms.connection.id}`, { id: '2' })).status, 404);
  assert.equal((await api(`/api/v1/connections/${lms.connection.id}/auth`, { method: 'POST', id: '2', body: { origin: EDU, calendarUrl: FEED } })).status, 404);
});

test('live check: preset discovery, hidden credential prompts and printed items never echo secrets', async () => {
  const { runLiveCheck, parseArgs } = await import('../src/live-check.mjs');
  assert.deepEqual(parseArgs(['--university', 'hse', '--url', 'https://a.example/x.ics', '--limit', '3']), { universities: ['hse'], urls: ['https://a.example/x.ics'], documents: [], envFile: null, db: null, limit: 3, help: false });
  assert.throws(() => parseArgs(['--password', 'x']), /Unknown option/);
  assert.throws(() => parseArgs(['--limit', '-1']), /--limit/);
  const store = createStore({ dbPath: ':memory:', masterKey: key, now: () => NOW });
  const net = transport({ ...ruzTable(), [FEED]: ics(MOODLE_ICS) });
  const printed = []; const visible = ['1', '1', 'student@edu.hse.ru']; const secrets = [FEED]; const asked = [];
  const io = { print: line => printed.push(line), ask: async question => { asked.push(question); return visible.shift() ?? ''; }, askSecret: async question => { asked.push(question); return secrets.shift(); } };
  const report = await runLiveCheck({ store, io, universities: ['hse', 'unknown'], request: net.request, now: () => NOW });
  store.close();
  assert.deepEqual(report.map(r => [r.status, r.counts]), [['ready', { courses: 2, deadlines: 2, schedule: 1 }], ['ready', { schedule: 2 }]]);
  const output = printed.join('\n');
  for (const expected of ['Homework 1 is due', 'Calculus', 'Linear Algebra', 'Неизвестный пресет «unknown»']) assert.ok(output.includes(expected), expected);
  for (const forbidden of ['SECRETFEED77', 'authtoken', 'student@edu.hse.ru']) assert.ok(!output.includes(forbidden) && !asked.join('\n').includes(forbidden), forbidden);
  assert.ok(asked.some(question => question.includes('calendarUrl') && question.includes('скрыт')));
  assert.deepEqual(visible, []); assert.deepEqual(secrets, []);
});
