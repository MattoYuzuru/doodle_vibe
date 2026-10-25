import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from './errors.mjs';
import { encryptSecret, decryptSecret, validateMasterKey } from './crypto.mjs';

const fail = (code = 'INVALID_INPUT', status = 400) => { throw new AppError(code, status); };
const string = (value, max = 1000) => { if (typeof value !== 'string' || !value.trim() || value.length > max) fail(); return value; };
const json = value => { try { const encoded = JSON.stringify(value); if (encoded === undefined || encoded.length > 2_000_000) fail(); return encoded; } catch { fail(); } };
const parse = value => JSON.parse(value);
const own = (object, key) => Object.hasOwn(object, key);
const forbiddenKey = /^(?:password|passwd|secret|cookie|cookies|authorization|token|access_?token|refresh_?token|csrf|headers|credentials|session|sessionid|userId|studentId|email)$/i;
function publicData(value, depth = 0) {
  if (depth > 20) fail();
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) { if (forbiddenKey.test(key)) fail('SENSITIVE_METADATA'); publicData(child, depth + 1); }
  }
  return value;
}
function url(value) {
  string(value, 4096);
  try { const parsed = new URL(value); if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) fail(); return parsed; } catch { fail(); }
}
const timestamp = value => { if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) fail(); return new Date(value).toISOString(); };
const limitValue = value => { if (!Number.isSafeInteger(value) || value < 1 || value > 200) fail(); return value; };

export function createStore({ dbPath, masterKey, now = Date.now }) {
  validateMasterKey(masterKey);
  const key = Buffer.from(masterKey);
  string(dbPath, 4096);
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  if (dbPath !== ':memory:') chmodSync(dbPath, 0o600);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
  // Serialize migration inspection with schema changes across independent processes.
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) fail('UNSUPPORTED_SCHEMA', 500);
    if (version === 0) {
    db.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE spaces (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, university_id TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX spaces_owner ON spaces(user_id);
      CREATE TABLE adapters (id TEXT PRIMARY KEY, origin TEXT NOT NULL, version TEXT NOT NULL, recipe TEXT NOT NULL, capabilities TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX adapters_origin ON adapters(origin);
      CREATE TABLE connections (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, source_url TEXT NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, status TEXT NOT NULL, error_code TEXT, adapter_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX connections_space ON connections(user_id,space_id);
      CREATE TABLE secrets (connection_id TEXT PRIMARY KEY REFERENCES connections(id) ON DELETE CASCADE, envelope TEXT NOT NULL);
      CREATE TABLE snapshots (id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE, kind TEXT NOT NULL, items TEXT NOT NULL, fetched_at TEXT NOT NULL, UNIQUE(connection_id,kind));
      CREATE TABLE documents (id TEXT PRIMARY KEY, external_id TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE, url TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, fetched_at TEXT NOT NULL, UNIQUE(connection_id,external_id));
      CREATE VIRTUAL TABLE documents_fts USING fts5(title,text,content='documents',content_rowid='rowid');
      CREATE TRIGGER documents_insert AFTER INSERT ON documents BEGIN INSERT INTO documents_fts(rowid,title,text) VALUES(new.rowid,new.title,new.text); END;
      CREATE TRIGGER documents_delete AFTER DELETE ON documents BEGIN INSERT INTO documents_fts(documents_fts,rowid,title,text) VALUES('delete',old.rowid,old.title,old.text); END;
      CREATE TRIGGER documents_update AFTER UPDATE ON documents BEGIN INSERT INTO documents_fts(documents_fts,rowid,title,text) VALUES('delete',old.rowid,old.title,old.text); INSERT INTO documents_fts(rowid,title,text) VALUES(new.rowid,new.title,new.text); END;
      CREATE TABLE messages (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, role TEXT NOT NULL, text TEXT NOT NULL, sources TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE, connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE, type TEXT NOT NULL, payload TEXT NOT NULL, dedupe_key TEXT NOT NULL, status TEXT NOT NULL, error_code TEXT, result TEXT, worker_id TEXT, claim_token TEXT, lease_until INTEGER, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX jobs_active ON jobs(connection_id,type,dedupe_key) WHERE status IN ('queued','running');
      PRAGMA user_version=1;`);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK'); db.close(); key.fill(0);
    if (error instanceof AppError) throw error;
    throw new AppError('STORAGE_ERROR', 500);
  }
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const at = () => new Date(now()).toISOString();
  let transactionDepth = 0, savepointSequence = 0;
  const tx = fn => {
    const nested = transactionDepth > 0;
    const savepoint = `store_tx_${++savepointSequence}`;
    db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    transactionDepth++;
    try {
      const result = fn();
      db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      if (nested) db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`);
      else db.exec('ROLLBACK');
      throw error;
    } finally { transactionDepth--; }
  };
  const user = id => { const row = get('SELECT * FROM users WHERE id=?', String(id)); if (!row) fail('NOT_FOUND', 404); return row; };
  const space = (id, sid) => { const row = get('SELECT * FROM spaces WHERE user_id=? AND id=?', String(id), sid); if (!row) fail('NOT_FOUND', 404); return row; };
  const connection = (id, cid) => { const row = get('SELECT c.* FROM connections c JOIN spaces s ON s.id=c.space_id AND s.user_id=c.user_id WHERE c.user_id=? AND c.id=?', String(id), cid); if (!row) fail('NOT_FOUND', 404); return row; };
  const spaceRecord = r => ({ id: r.id, userId: r.user_id, universityId: r.university_id, name: r.name, createdAt: r.created_at });
  const connectionRecord = r => ({ id: r.id, userId: r.user_id, spaceId: r.space_id, sourceUrl: r.source_url, kind: r.kind, label: r.label, status: r.status, errorCode: r.error_code, adapterId: r.adapter_id, createdAt: r.created_at, updatedAt: r.updated_at });
  const documentRecord = r => ({ id: r.id, externalId: r.external_id, userId: r.user_id, spaceId: r.space_id, connectionId: r.connection_id, url: r.url, title: r.title, text: r.text, fetchedAt: r.fetched_at });
  const jobRecord = (r, claim = false) => ({ id: r.id, userId: r.user_id, spaceId: r.space_id, connectionId: r.connection_id, type: r.type, payload: parse(r.payload), status: r.status, errorCode: r.error_code, result: r.result ? parse(r.result) : null, attempts: r.attempts, createdAt: r.created_at, updatedAt: r.updated_at, ...(claim ? { claimToken: r.claim_token, leaseUntil: r.lease_until } : {}) });
  const adapterRecord = r => r ? ({ id: r.id, origin: r.origin, version: r.version, recipe: parse(r.recipe), capabilities: parse(r.capabilities), createdAt: r.created_at }) : null;
  const api = {
    ensureUser({ id, displayName = '' }) {
      id = string(id, 100); if (typeof displayName !== 'string' || displayName.length > 200) fail();
      run('INSERT INTO users VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name', id, displayName, at());
      return api.getUser(id);
    },
    getUser(id) { const r = user(id); return { id: r.id, displayName: r.display_name, createdAt: r.created_at }; },
    createSpace(id, { universityId, name }) { user(id); string(universityId, 200); string(name, 200); const sid = randomUUID(); run('INSERT INTO spaces VALUES(?,?,?,?,?)', sid, String(id), universityId, name, at()); return api.getSpace(id, sid); },
    listSpaces(id) { user(id); return all('SELECT * FROM spaces WHERE user_id=? ORDER BY created_at,id', String(id)).map(spaceRecord); },
    getSpace(id, sid) { return spaceRecord(space(id, sid)); },
    deleteSpace(id, sid) { space(id, sid); run('DELETE FROM spaces WHERE user_id=? AND id=?', String(id), sid); return { deleted: true }; },
    createConnection(id, sid, { sourceUrl, kind, label = '' }) {
      space(id, sid); url(sourceUrl); string(kind, 100); if (typeof label !== 'string' || label.length > 200) fail();
      // Credentials and signed URL parameters belong exclusively in encrypted secret storage.
      const parsedUrl = url(sourceUrl); if (parsedUrl.search || parsedUrl.hash) fail('UNSAFE_SOURCE_URL');
      const cid = randomUUID(), time = at();
      run('INSERT INTO connections VALUES(?,?,?,?,?,?,?,?,?,?,?)', cid, String(id), sid, parsedUrl.href, kind, label, 'pending', null, null, time, time);
      return api.getConnection(id, cid);
    },
    listConnections(id, sid) { space(id, sid); return all('SELECT * FROM connections WHERE user_id=? AND space_id=? ORDER BY created_at,id', String(id), sid).map(connectionRecord); },
    getConnection(id, cid) { return connectionRecord(connection(id, cid)); },
    updateConnection(id, cid, changes) {
      const c = connection(id, cid);
      const status = own(changes, 'status') ? string(changes.status, 100) : c.status;
      const error = own(changes, 'errorCode') ? changes.errorCode : c.error_code;
      if (error !== null && (typeof error !== 'string' || !/^[A-Za-z0-9_]{1,100}$/.test(error))) fail();
      const aid = own(changes, 'adapterId') ? changes.adapterId : c.adapter_id;
      if (aid !== null && !get('SELECT id FROM adapters WHERE id=?', aid)) fail('INVALID_ADAPTER');
      run('UPDATE connections SET status=?,error_code=?,adapter_id=?,updated_at=? WHERE id=? AND user_id=?', status, error, aid, at(), cid, String(id));
      return api.getConnection(id, cid);
    },
    deleteConnection(id, cid) { connection(id, cid); run('DELETE FROM connections WHERE id=? AND user_id=?', cid, String(id)); return { deleted: true }; },
    setSecret(id, cid, value) {
      const c = connection(id, cid);
      if (!value || typeof value !== 'object' || Array.isArray(value) || value.origin !== new URL(c.source_url).origin) fail('SECRET_ORIGIN_MISMATCH');
      json(value);
      const envelope = encryptSecret(key, { userId: c.user_id, spaceId: c.space_id, connectionId: cid }, value);
      run('INSERT INTO secrets VALUES(?,?) ON CONFLICT(connection_id) DO UPDATE SET envelope=excluded.envelope', cid, envelope);
      return { saved: true };
    },
    readSecret(id, cid) { const c = connection(id, cid); const r = get('SELECT envelope FROM secrets WHERE connection_id=?', cid); return r ? decryptSecret(key, { userId: c.user_id, spaceId: c.space_id, connectionId: cid }, r.envelope) : null; },
    withCurrentSecret(id, cid, expected, operation) {
      return tx(()=>{
        const current=api.readSecret(id,cid);
        if(JSON.stringify(current)!==JSON.stringify(expected)) return false;
        const result=operation();
        if(result&&typeof result.then==='function') { Promise.resolve(result).catch(()=>{}); fail('ASYNC_SECRET_CALLBACK'); }
        return true;
      });
    },
    resetConnectionAuth(id,cid,value) {
      return tx(()=>{
        connection(id,cid);
        // An explicit new login invalidates in-flight work and the former account's data.
        run('DELETE FROM jobs WHERE connection_id=?',cid);
        run('DELETE FROM snapshots WHERE connection_id=?',cid);
        run('DELETE FROM documents WHERE connection_id=?',cid);
        api.setSecret(id,cid,value);
        return api.updateConnection(id,cid,{status:'pending',errorCode:null});
      });
    },
    putSnapshot(id, cid, { kind, items, fetchedAt, complete }) {
      const c = connection(id, cid); if (!['courses', 'schedule', 'deadlines'].includes(kind)) fail();
      if (complete !== true) return { saved: false };
      if (!Array.isArray(items)) fail();
      const encoded = json(publicData(items)), time = timestamp(fetchedAt);
      return tx(() => {
        // The external ID remains namespaced by connection, even when two sources reuse it.
        run('INSERT INTO snapshots VALUES(?,?,?,?,?) ON CONFLICT(connection_id,kind) DO UPDATE SET items=excluded.items,fetched_at=excluded.fetched_at', randomUUID(), cid, kind, encoded, time);
        return { saved: true, connectionId: cid, userId: c.user_id, spaceId: c.space_id, kind, fetchedAt: time };
      });
    },
    listSnapshots(id, sid, { kind } = {}) {
      space(id, sid); if (kind !== undefined && !['courses', 'schedule', 'deadlines'].includes(kind)) fail();
      return all(`SELECT s.*,c.user_id,c.space_id FROM snapshots s JOIN connections c ON c.id=s.connection_id WHERE c.user_id=? AND c.space_id=?${kind === undefined ? '' : ' AND s.kind=?'} ORDER BY s.fetched_at,s.id`, ...[String(id), sid, ...(kind === undefined ? [] : [kind])]).map(r => ({ id: r.id, userId: r.user_id, spaceId: r.space_id, connectionId: r.connection_id, kind: r.kind, items: parse(r.items), fetchedAt: r.fetched_at, complete: true }));
    },
    putDocument(id, sid, value) {
      space(id, sid); const c = connection(id, value.connectionId); if (c.space_id !== sid) fail('NOT_FOUND', 404);
      const externalId = string(value.id, 500); const docUrl = url(value.url); if (docUrl.search || docUrl.hash) fail('UNSAFE_DOCUMENT_URL');
      if (typeof value.title !== 'string' || value.title.length > 2000 || typeof value.text !== 'string' || value.text.length > 1_000_000) fail();
      const existing = get('SELECT id FROM documents WHERE connection_id=? AND external_id=?', c.id, externalId);
      const did = existing?.id ?? randomUUID();
      run('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(connection_id,external_id) DO UPDATE SET url=excluded.url,title=excluded.title,text=excluded.text,fetched_at=excluded.fetched_at', did, externalId, String(id), sid, c.id, docUrl.href, value.title, value.text, timestamp(value.fetchedAt));
      return documentRecord(get('SELECT * FROM documents WHERE id=?', did));
    },
    listDocuments(id, sid, { limit = 50 } = {}) { space(id, sid); return all('SELECT * FROM documents WHERE user_id=? AND space_id=? ORDER BY fetched_at DESC,id LIMIT ?', String(id), sid, limitValue(limit)).map(documentRecord); },
    searchDocuments(id, sid, query, { limit = 20 } = {}) {
      space(id, sid); if (typeof query !== 'string' || query.length > 2000) fail(); limitValue(limit);
      // Public search is literal Unicode tokens joined by AND. Operators, quotes,
      // column selectors and punctuation are never interpolated into FTS syntax.
      const tokens = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 32) ?? [];
      if (!tokens.length) return [];
      const match = tokens.map(token => `"${token}"`).join(' AND ');
      return all('SELECT d.* FROM documents_fts JOIN documents d ON d.rowid=documents_fts.rowid WHERE documents_fts MATCH ? AND d.user_id=? AND d.space_id=? ORDER BY rank,d.id LIMIT ?', match, String(id), sid, limit).map(documentRecord);
    },
    appendMessage(id, sid, { role, text, sources = [] }) {
      space(id, sid); if (!['user', 'assistant', 'system'].includes(role)) fail(); string(text, 100000); if (!Array.isArray(sources)) fail(); publicData(sources);
      const mid = randomUUID(); run('INSERT INTO messages VALUES(?,?,?,?,?,?,?)', mid, String(id), sid, role, text, json(sources), at());
      return { id: mid, userId: String(id), spaceId: sid, role, text, sources, createdAt: at() };
    },
    listMessages(id, sid, { limit = 50 } = {}) { space(id, sid); return all('SELECT * FROM (SELECT rowid AS sequence,* FROM messages WHERE user_id=? AND space_id=? ORDER BY rowid DESC LIMIT ?) ORDER BY sequence', String(id), sid, limitValue(limit)).map(r => ({ id: r.id, userId: r.user_id, spaceId: r.space_id, role: r.role, text: r.text, sources: parse(r.sources), createdAt: r.created_at })); },
    withEvidenceCurrent(id,sid,references,operation) {
      return tx(()=>{
        space(id,sid);
        for(const reference of references) {
          let row,value;
          if(reference.type==='snapshot') {
            row=get('SELECT s.items FROM snapshots s JOIN connections c ON c.id=s.connection_id WHERE s.id=? AND c.id=? AND c.user_id=? AND c.space_id=?',reference.id,reference.connectionId,String(id),sid);
            value=row?.items;
          } else if(reference.type==='document') {
            row=get('SELECT url,title,text,fetched_at FROM documents WHERE id=? AND connection_id=? AND user_id=? AND space_id=?',reference.id,reference.connectionId,String(id),sid);
            if(row) value=JSON.stringify([row.url,row.title,row.text,row.fetched_at]);
          }
          if(!row || createHash('sha256').update(value).digest('hex')!==reference.digest) fail('EVIDENCE_CHANGED',409);
        }
        const result=operation();
        if(result&&typeof result.then==='function') { Promise.resolve(result).catch(()=>{}); fail('ASYNC_EVIDENCE_CALLBACK'); }
        return result;
      });
    },
    enqueueJob(id, cid, { type, payload = {}, dedupeKey }) {
      const c = connection(id, cid); string(type, 100); const dk = dedupeKey === undefined ? type : string(dedupeKey, 200); const encoded = json(publicData(payload));
      return tx(() => {
        const existing = get("SELECT * FROM jobs WHERE connection_id=? AND type=? AND dedupe_key=? AND status IN ('queued','running')", cid, type, dk);
        if (existing) return jobRecord(existing);
        const jid = randomUUID(), time = at();
        run("INSERT INTO jobs(id,user_id,space_id,connection_id,type,payload,dedupe_key,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'queued',?,?)", jid, String(id), c.space_id, cid, type, encoded, dk, time, time);
        return api.getJob(id, jid);
      });
    },
    getJob(id, jid) { const r = get('SELECT j.* FROM jobs j JOIN connections c ON c.id=j.connection_id AND c.user_id=j.user_id WHERE j.user_id=? AND j.id=?', String(id), jid); if (!r) fail('NOT_FOUND', 404); return jobRecord(r); },
    // Internal scheduler only; never exposed by an HTTP/model tool.
    listDueConnections({ olderThanMs = 900000, limit = 20 } = {}) {
      if(!Number.isSafeInteger(olderThanMs) || olderThanMs<60000) fail(); limitValue(limit);
      const cutoff=new Date(now()-olderThanMs).toISOString();
      return all("SELECT c.* FROM connections c JOIN spaces s ON s.id=c.space_id AND s.user_id=c.user_id WHERE c.status IN ('ready','error') AND c.updated_at<=? AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.connection_id=c.id AND j.status IN ('queued','running')) ORDER BY c.updated_at,c.id LIMIT ?",cutoff,limit).map(connectionRecord);
    },
    claimJob(workerId, { leaseMs = 60000 } = {}) {
      string(workerId, 200); if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 3_600_000) fail();
      return tx(() => {
        const r = get("SELECT j.* FROM jobs j JOIN connections c ON c.id=j.connection_id AND c.user_id=j.user_id WHERE j.status='queued' OR (j.status='running' AND j.lease_until<=?) ORDER BY j.created_at,j.rowid LIMIT 1", now());
        if (!r) return null;
        const token = randomUUID();
        run("UPDATE jobs SET status='running',worker_id=?,claim_token=?,lease_until=?,attempts=attempts+1,updated_at=? WHERE id=?", workerId, token, now() + leaseMs, at(), r.id);
        return jobRecord(get('SELECT * FROM jobs WHERE id=?', r.id), true);
      });
    },
    // Keep the lease check and a synchronous executor read/write in one SQLite
    // write transaction. A second process cannot reclaim the job in between.
    withClaim(jid, token, callback) {
      if (typeof callback !== 'function') fail();
      return tx(() => {
        api.assertClaim(jid, token);
        const result = callback();
        if (result && typeof result.then === 'function') {
          // Reject async use without leaving an unhandled rejected Promise.
          Promise.resolve(result).catch(() => {});
          fail('ASYNC_CLAIM_CALLBACK', 500);
        }
        return result;
      });
    },
    assertClaim(jid, token) {
      const r = get('SELECT j.* FROM jobs j JOIN connections c ON c.id=j.connection_id AND c.user_id=j.user_id WHERE j.id=?', jid);
      if (!r) fail('NOT_FOUND', 404);
      if (r.status !== 'running' || typeof token !== 'string' || r.claim_token !== token || r.lease_until <= now()) fail('STALE_CLAIM', 409);
      return true;
    },
    renewClaim(jid, token, { leaseMs = 60000 } = {}) {
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 3_600_000) fail();
      return tx(() => {
        api.assertClaim(jid, token);
        run('UPDATE jobs SET lease_until=?,updated_at=? WHERE id=? AND claim_token=?', now() + leaseMs, at(), jid, token);
        return jobRecord(get('SELECT * FROM jobs WHERE id=?', jid), true);
      });
    },
    finishJob(jid, token, { status, errorCode = null, result = null }) {
      api.assertClaim(jid, token);
      const r = get('SELECT * FROM jobs WHERE id=?', jid);
      if (!['succeeded', 'failed'].includes(status)) fail();
      if (errorCode !== null && (typeof errorCode !== 'string' || !/^[A-Za-z0-9_]{1,100}$/.test(errorCode))) fail();
      const encoded = result === null ? null : json(publicData(result));
      const updated = run("UPDATE jobs SET status=?,error_code=?,result=?,claim_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND claim_token=? AND status='running' AND lease_until>?", status, errorCode, encoded, at(), jid, token, now());
      if (updated.changes !== 1) fail('STALE_CLAIM', 409);
      return api.getJob(r.user_id, jid);
    },
    putAdapter({ id, origin, version, recipe, capabilities }) {
      string(id, 200); const parsed = url(origin); if (parsed.origin !== origin || parsed.search || parsed.hash) fail('INVALID_ADAPTER');
      string(String(version), 100); if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe) || !Array.isArray(capabilities)) fail('INVALID_ADAPTER');
      publicData(recipe); publicData(capabilities);
      const checkLocations = (value, field = '') => {
        if (typeof value === 'string') {
          if (/^https?:\/\//i.test(value)) { const location = url(value); if (location.search || location.hash) fail('SENSITIVE_METADATA'); }
          if (field === 'path' && value !== '$source' && (value.includes('?') || value.includes('#') || !value.startsWith('/') || value.startsWith('//'))) fail('SENSITIVE_METADATA');
        } else if (value && typeof value === 'object') for (const [name, child] of Object.entries(value)) checkLocations(child, name);
      };
      checkLocations(recipe);
      run('INSERT INTO adapters VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET origin=excluded.origin,version=excluded.version,recipe=excluded.recipe,capabilities=excluded.capabilities', id, origin, String(version), json(recipe), json(capabilities), at());
      return api.getAdapter(id);
    },
    getAdapter(id) { return adapterRecord(get('SELECT * FROM adapters WHERE id=?', id)); },
    findAdapter(origin) { return adapterRecord(get('SELECT * FROM adapters WHERE origin=? ORDER BY created_at DESC,rowid DESC LIMIT 1', origin)); },
    close() { db.close(); key.fill(0); },
  };
  // SQLite/parser messages are implementation details and can contain user data.
  return Object.fromEntries(Object.entries(api).map(([name, fn]) => [name, (...args) => { try { return fn(...args); } catch (error) { if (error instanceof AppError) throw error; throw new AppError('STORAGE_ERROR', 500); } }]));
}
