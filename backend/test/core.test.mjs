import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHmac } from 'node:crypto';
import { createStore } from '../src/store.mjs';
import { encryptSecret, decryptSecret } from '../src/crypto.mjs';
import { verifyTelegramInitData } from '../src/auth.mjs';

const key = Buffer.alloc(32, 17);
const now = 1_800_000_000_000;
function fixture(t, clock = () => now) {
  const dir = mkdtempSync(join(tmpdir(), 'doodle-core-'));
  const dbPath = join(dir, 'test.sqlite');
  const store = createStore({ dbPath, masterKey: key, now: clock });
  t.after(() => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  for (const id of ['1', '2']) store.ensureUser({ id, displayName: `Fixture ${id}` });
  const spaces = ['1', '1', '2', '2'].map((id, i) => store.createSpace(id, { universityId: `u${i}`, name: `Space ${i}` }));
  const connections = spaces.map(s => store.createConnection(s.userId, s.id, { sourceUrl: 'https://fixture.example/', kind: 'lms' }));
  return { store, spaces, connections, dbPath };
}
const code = (fn, expected, status) => assert.throws(fn, e => e.code === expected && (!status || e.status === status) && e.message === expected);
const fetchedAt = new Date(now).toISOString();

test('all private resources enforce user and space boundaries, including mutations and search', t => {
  const { store: s, spaces: sp, connections: c } = fixture(t);
  const document = { id: 'same-external-id', url: 'https://fixture.example/doc', title: 'Schedule', text: 'calculus tomorrow', fetchedAt };
  c.forEach((conn, i) => {
    s.putSnapshot(conn.userId, conn.id, { kind: 'schedule', items: [{ id: 'same', title: `Math ${i}` }], fetchedAt, complete: true });
    s.putDocument(conn.userId, conn.spaceId, { ...document, connectionId: conn.id });
    s.appendMessage(conn.userId, conn.spaceId, { role: 'user', text: `private ${i}` });
  });
  assert.equal(s.listSnapshots('1', sp[0].id).length, 1);
  assert.equal(s.searchDocuments('1', sp[0].id, 'calculus').length, 1);
  assert.equal(s.listMessages('1', sp[0].id)[0].text, 'private 0');
  const job = s.enqueueJob('1', c[0].id, { type: 'sync' });
  const attempts = [
    () => s.getSpace('2', sp[0].id), () => s.deleteSpace('2', sp[0].id),
    () => s.listConnections('2', sp[0].id), () => s.getConnection('2', c[0].id),
    () => s.updateConnection('2', c[0].id, { status: 'ready' }), () => s.deleteConnection('2', c[0].id),
    () => s.readSecret('2', c[0].id), () => s.setSecret('2', c[0].id, {}),
    () => s.putSnapshot('2', c[0].id, {}), () => s.listSnapshots('2', sp[0].id),
    () => s.listDocuments('2', sp[0].id), () => s.searchDocuments('2', sp[0].id, 'calculus'),
    () => s.putDocument('1', sp[1].id, { ...document, connectionId: c[0].id }),
    () => s.appendMessage('2', sp[0].id, { role: 'user', text: 'attack' }),
    () => s.listMessages('2', sp[0].id), () => s.enqueueJob('2', c[0].id, { type: 'sync' }),
    () => s.getJob('2', job.id), () => s.getJob('1', 'missing'),
  ];
  attempts.forEach(fn => code(fn, 'NOT_FOUND', 404));
  const extra = s.createConnection('1', sp[0].id, { sourceUrl: 'https://other.example/', kind: 'lms' });
  s.putDocument('1', sp[0].id, { ...document, connectionId: extra.id });
  assert.equal(s.listDocuments('1', sp[0].id).length, 2);
  s.deleteConnection('1', c[0].id);
  assert.equal(s.listDocuments('1', sp[0].id).length, 1);
  assert.equal(s.searchDocuments('1', sp[0].id, 'calculus').length, 1);
  assert.equal(s.listSnapshots('1', sp[0].id).length, 0);
  code(() => s.getJob('1', job.id), 'NOT_FOUND');
  s.deleteSpace('1', sp[0].id);
  assert.equal(s.listSpaces('1').length, 1);
  code(() => s.getConnection('1', extra.id), 'NOT_FOUND');
});

test('AES-GCM secrets bind owner, space, connection and origin; DB and public records contain no plaintext', t => {
  const { store: s, connections: c, dbPath } = fixture(t);
  const secret = { origin: 'https://fixture.example', token: 'synthetic-credential-93a6e52c' };
  s.setSecret('1', c[0].id, secret);
  assert.deepEqual(s.readSecret('1', c[0].id), secret);
  const publicRecords = JSON.stringify([s.getConnection('1', c[0].id), s.listConnections('1', c[0].spaceId), s.enqueueJob('1', c[0].id, { type: 'sync' })]);
  assert.ok(!publicRecords.includes(secret.token)); assert.ok(!publicRecords.includes('envelope'));
  const db = new DatabaseSync(dbPath);
  const envelope = db.prepare('SELECT envelope FROM secrets WHERE connection_id=?').get(c[0].id).envelope;
  assert.ok(!envelope.includes(secret.token));
  for (const suffix of ['', '-wal']) { try { assert.ok(!readFileSync(dbPath + suffix).includes(Buffer.from(secret.token))); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  const context = { userId: '1', spaceId: c[0].spaceId, connectionId: c[0].id };
  code(() => decryptSecret(Buffer.alloc(32, 99), context, envelope), 'SECRET_UNAVAILABLE');
  for (const field of ['userId', 'spaceId', 'connectionId']) code(() => decryptSecret(key, { ...context, [field]: 'other' }, envelope), 'SECRET_UNAVAILABLE');
  db.prepare('INSERT INTO secrets VALUES(?,?)').run(c[1].id, envelope);
  code(() => s.readSecret('1', c[1].id), 'SECRET_UNAVAILABLE');
  db.close();
  code(() => s.setSecret('1', c[0].id, { ...secret, origin: 'https://evil.example' }), 'SECRET_ORIGIN_MISMATCH');
  assert.notEqual(encryptSecret(key, context, secret), encryptSecret(key, context, secret));
  s.close();
  const wrongKey = createStore({ dbPath, masterKey: Buffer.alloc(32, 99) });
  code(() => wrongKey.readSecret('1', c[0].id), 'SECRET_UNAVAILABLE'); wrongKey.close();
});

test('incomplete/invalid snapshots preserve previous complete snapshot across restart', t => {
  const { store: s, connections: c, dbPath } = fixture(t);
  const value = { kind: 'schedule', items: [{ id: 'a', title: 'Math' }], fetchedAt, complete: true };
  s.putSnapshot('1', c[0].id, value);
  assert.deepEqual(s.putSnapshot('1', c[0].id, { kind: 'schedule', complete: false }), { saved: false });
  code(() => s.putSnapshot('1', c[0].id, { ...value, items: [{ token: 'forbidden' }] }), 'SENSITIVE_METADATA');
  const other = s.createConnection('1', c[0].spaceId, { sourceUrl: 'https://other.example', kind: 'lms' });
  s.putSnapshot('1', other.id, value);
  s.close();
  const restarted = createStore({ dbPath, masterKey: key });
  const rows = restarted.listSnapshots('1', c[0].spaceId);
  assert.equal(rows.length, 2); assert.deepEqual(rows[0].items, value.items);
  assert.notEqual(rows[0].connectionId, rows[1].connectionId);
  restarted.close();
});

test('job dedupe, lease reclamation, stale fencing and disconnect cancellation survive restarts', t => {
  let time = now;
  const { store: s, connections: c, dbPath } = fixture(t, () => time);
  const job = s.enqueueJob('1', c[0].id, { type: 'sync' });
  assert.equal(s.enqueueJob('1', c[0].id, { type: 'sync' }).id, job.id);
  const first = s.claimJob('worker-a', { leaseMs: 1000 });
  assert.equal(first.id, job.id); assert.equal(s.claimJob('worker-b'), null);
  assert.ok(!('claimToken' in s.getJob('1', job.id)));
  time += 1001;
  code(() => s.finishJob(job.id, first.claimToken, { status: 'succeeded' }), 'STALE_CLAIM');
  s.close();
  const next = createStore({ dbPath, masterKey: key, now: () => time });
  const second = next.claimJob('worker-b', { leaseMs: 1000 });
  assert.notEqual(second.claimToken, first.claimToken); assert.equal(second.attempts, 2);
  code(() => next.finishJob(job.id, first.claimToken, { status: 'succeeded' }), 'STALE_CLAIM');
  assert.equal(next.finishJob(job.id, second.claimToken, { status: 'succeeded', result: { count: 2 } }).status, 'succeeded');
  const fresh = next.enqueueJob('1', c[0].id, { type: 'sync' }); assert.notEqual(fresh.id, job.id);
  const claim = next.claimJob('worker-c');
  next.deleteConnection('1', c[0].id);
  code(() => next.finishJob(claim.id, claim.claimToken, { status: 'succeeded' }), 'NOT_FOUND');
  code(() => next.putSnapshot('1', c[0].id, { kind: 'courses', items: [], fetchedAt, complete: true }), 'NOT_FOUND');
  assert.equal(next.claimJob('worker-d'), null);
  next.close();
});

test('FTS treats hostile syntax as literal tokens and index updates/deletes stay scoped', t => {
  const { store: s, connections: c } = fixture(t);
  const value = { id: 'doc', connectionId: c[0].id, url: 'https://fixture.example/doc', title: 'Math', text: 'calculus algebra', fetchedAt };
  s.putDocument('1', c[0].spaceId, value);
  for (const q of ['" OR * --', 'title:calculus', 'NEAR(calculus)', "'; DROP TABLE documents; --", '']) assert.doesNotThrow(() => s.searchDocuments('1', c[0].spaceId, q));
  assert.equal(s.searchDocuments('1', c[0].spaceId, 'calculus').length, 1);
  s.putDocument('1', c[0].spaceId, { ...value, text: 'geometry' });
  assert.equal(s.searchDocuments('1', c[0].spaceId, 'calculus').length, 0);
  assert.equal(s.searchDocuments('1', c[0].spaceId, 'geometry').length, 1);
});

test('shared adapters and job metadata reject secret-bearing keys', t => {
  const { store: s, connections: c } = fixture(t);
  const adapter = { id: 'fixture', origin: 'https://fixture.example', version: 1, recipe: { version: 1, format: 'json', path: '/', kind: 'schedule' }, capabilities: ['schedule'] };
  assert.equal(s.putAdapter(adapter).id, adapter.id);
  assert.equal(s.findAdapter(adapter.origin).version, '1');
  for (const name of ['token', 'password', 'cookies', 'credentials', 'csrf', 'headers', 'studentId']) code(() => s.putAdapter({ ...adapter, recipe: { ...adapter.recipe, [name]: 'synthetic' } }), 'SENSITIVE_METADATA');
  code(() => s.enqueueJob('1', c[0].id, { type: 'sync', payload: { token: 'synthetic' } }), 'SENSITIVE_METADATA');
  code(() => s.createConnection('1', c[0].spaceId, { sourceUrl: 'https://fixture.example/?token=synthetic', kind: 'lms' }), 'UNSAFE_SOURCE_URL');
});

function signed(fields, token = 'synthetic-bot-token') {
  const params = new URLSearchParams(fields);
  const data = [...params].sort(([a], [b]) => a < b ? -1 : 1).map(([k, v]) => `${k}=${v}`).join('\n');
  const key = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', key).update(data).digest('hex'));
  return params.toString();
}
test('Telegram verification rejects tampering, duplicate fields, expired/future and invalid IDs', () => {
  const fields = { auth_date: String(now / 1000), user: JSON.stringify({ id: 123, first_name: 'Fixture' }), query_id: 'synthetic' };
  const valid = signed(fields);
  const verify = raw => verifyTelegramInitData(raw, 'synthetic-bot-token', { now: () => now });
  assert.deepEqual(verify(valid), { id: '123', displayName: 'Fixture' });
  const invalid = [valid.replace('synthetic', 'tampered'), valid + '&user=%7B%7D', valid + '&hash=00', '', 'user=%ZZ', signed({ ...fields, auth_date: String(now / 1000 - 3601) }), signed({ ...fields, auth_date: String(now / 1000 + 31) }), signed({ ...fields, user: '{"id":-1}' }), signed({ ...fields, user: '{"id":"123"}' }), signed({ ...fields, user: '{"id":9007199254740992}' })];
  invalid.forEach(raw => code(() => verify(raw), 'UNAUTHORIZED', 401));
  code(() => verifyTelegramInitData(valid, 'wrong-token', { now: () => now }), 'UNAUTHORIZED');
});

test('renewal, simultaneous store handles and schema reopen preserve data without duplicate jobs', t => {
  let time = now;
  const { store: first, connections: c, dbPath } = fixture(t, () => time);
  const second = createStore({ dbPath, masterKey: key, now: () => time });
  t.after(() => second.close());
  const queued = first.enqueueJob('1', c[0].id, { type: 'sync' });
  assert.equal(second.enqueueJob('1', c[0].id, { type: 'sync' }).id, queued.id);
  const claim = first.claimJob('a', { leaseMs: 1000 });
  assert.equal(second.claimJob('b'), null);
  assert.equal(second.assertClaim(claim.id, claim.claimToken), true);
  time += 500;
  const renewed = second.renewClaim(claim.id, claim.claimToken, { leaseMs: 2000 });
  assert.equal(renewed.leaseUntil, time + 2000);
  code(() => first.renewClaim(claim.id, 'wrong'), 'STALE_CLAIM');
  time += 1000;
  assert.equal(first.claimJob('c'), null);
  assert.equal(first.assertClaim(claim.id, claim.claimToken), true);
  time += 1001;
  code(() => second.renewClaim(claim.id, claim.claimToken), 'STALE_CLAIM');
  const reclaimed = second.claimJob('d');
  code(() => first.assertClaim(claim.id, claim.claimToken), 'STALE_CLAIM');
  first.finishJob(reclaimed.id, reclaimed.claimToken, { status: 'failed', errorCode: 'SOURCE_TIMEOUT' });
  assert.equal(second.getJob('1', queued.id).status, 'failed');
  const db = new DatabaseSync(dbPath);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  db.close();
});

test('unsupported newer schema is rejected without deleting persisted records', t => {
  const { store: s, connections: c, dbPath } = fixture(t);
  s.close();
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA user_version=99'); db.close();
  code(() => createStore({ dbPath, masterKey: key }), 'UNSUPPORTED_SCHEMA');
  const preserved = new DatabaseSync(dbPath);
  assert.equal(preserved.prepare('SELECT id FROM connections WHERE id=?').get(c[0].id).id, c[0].id);
  preserved.close();
});

test('stable source error codes persist without allowing arbitrary exception text', t => {
  const { store: s, connections: c } = fixture(t);
  assert.equal(s.updateConnection('1', c[0].id, { status: 'user_action_required', errorCode: 'source_auth_required' }).errorCode, 'source_auth_required');
  code(() => s.updateConnection('1', c[0].id, { errorCode: 'credential=synthetic' }), 'INVALID_INPUT');
  const job = s.enqueueJob('1', c[0].id, { type: 'sync' });
  const claim = s.claimJob('fixture');
  assert.equal(s.finishJob(job.id, claim.claimToken, { status: 'failed', errorCode: 'source_timeout' }).errorCode, 'source_timeout');
});
