// Loopback fixtures for sync by stored session. Everything is synthetic: invented people, ids, cookies and tokens.
// `fixtureRequest` is the real `createSafeRequest` (session mode, header building, redirect policy) whose socket is pointed at
// the loopback server, so https://lms.example.edu in a test is answered by 127.0.0.1.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client } from 'undici';
import { createSafeRequest } from '../../../src/sources/network.mjs';

export const NOW = Date.parse('2026-10-25T12:00:00Z');
export const ORIGIN = 'https://lms.example.edu';

export async function startServer(handler) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const record = { method: req.method, url: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization, contentType: req.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') };
      requests.push(record);
      const reply = handler(record) ?? { status: 404, body: '' };
      const body = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
      res.writeHead(reply.status ?? 200, { 'content-type': reply.type ?? (typeof reply.body === 'string' ? 'text/html' : 'application/json'), ...(reply.headers ?? {}) });
      res.end(body);
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { port: server.address().port, requests, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
export const fixtureRequest = port => createSafeRequest({
  resolver: async () => [{ address: '93.184.216.34', family: 4 }],
  clientFactory: (_origin, options) => new Client(`http://127.0.0.1:${port}`, { headersTimeout: options.headersTimeout, bodyTimeout: options.bodyTimeout, maxResponseSize: options.maxResponseSize }),
});

export const PEOPLE = {
  A: { sid: 'sidAnn0123456789', id: 4821, name: 'Ann Synthetic', login: 'ann.s', email: 'ann.synthetic@mail.example',
    courses: [{ id: 11, name: 'Linear Algebra' }, { id: 12, name: 'Statistics' }, { id: 13, name: 'Databases' }],
    deadlines: [{ id: 'd1', title: 'Homework 1', dueDate: '2026-10-30T20:00:00Z', courseId: 11 }, { id: 'd2', title: 'Quiz 2', dueDate: '2026-11-02T10:00:00+03:00', courseId: 12 }] },
  B: { sid: 'sidBob9876543210', id: 7310, name: 'Bob Synthetic', login: 'bob.s', email: 'bob.synthetic@mail.example',
    courses: [{ id: 21, name: 'Optimization' }], deadlines: [{ id: 'd9', title: 'Essay', dueDate: '2026-11-05T18:00:00Z', courseId: 21 }] },
};
const bySid = cookie => Object.values(PEOPLE).find(person => cookie?.split('; ').includes(`sid=${person.sid}`));

/** A small SPA-like JSON API. `state.mode` switches failures: 'expired' (401), 'redirect' (302 to /login), 'html' (login page), 'drift' (renamed keys). */
export function lmsHandler(state = {}) {
  return request => {
    const url = new URL(request.url, 'http://x');
    const person = bySid(request.cookie);
    if (state.mode === 'redirect') return { status: 302, headers: { location: 'https://sso.example.edu/login?return=1' }, body: '' };
    if (state.mode === 'loginpath') return { status: 302, headers: { location: '/auth/realms/x/login' }, body: '' };
    if (state.mode === 'html') return { status: 200, type: 'text/html', body: '<html><title>Sign in</title><form><input type="password" name="p"></form></html>' };
    if (state.mode === 'expired' || !person) return { status: 401, type: 'application/problem+json', body: { title: 'Unauthorized' } };
    if (url.pathname === '/api/me') return { body: { id: person.id, login: person.login, displayName: person.name, email: person.email } };
    const mine = /^\/api\/users\/([^/]+)\/(courses|deadlines)$/.exec(url.pathname);
    if (mine) {
      if (mine[1] !== String(person.id)) return { status: 403, body: { title: 'Forbidden' } };
      if (mine[2] === 'courses') {
        const limit = Number(url.searchParams.get('limit')); const offset = Number(url.searchParams.get('offset'));
        const rows = person.courses.slice(offset, offset + limit);
        return { body: { data: { items: state.mode === 'drift' ? rows.map(row => ({ course: row.id, label: row.name })) : rows }, total: person.courses.length } };
      }
      return { body: state.mode === 'drift' ? { result: person.deadlines } : person.deadlines };
    }
    if (url.pathname === '/api/schedule') return { body: { events: [{ id: 'e1', title: 'Lecture: Algebra', start: '2026-10-26T09:00:00+03:00', end: '2026-10-26T10:30:00+03:00', room: '305' }] } };
    return { status: 404, body: { title: 'Not found' } };
  };
}

/** What a login observer would have seen for the owner: parsed responses of the same API, fetched with the owner's cookie. */
export async function observe(port, person, now = NOW) {
  const request = fixtureRequest(port);
  const session = { origin: ORIGIN, auth: 'cookie', cookies: [{ name: 'sid', value: person.sid, domain: 'lms.example.edu', path: '/', secure: true, httpOnly: true }], postPaths: [], now };
  const seen = [];
  const nowSec = Math.floor(now / 1000);
  for (const path of ['/api/me', `/api/users/${person.id}/courses?limit=2&offset=0`, `/api/users/${person.id}/deadlines?from=${nowSec}`, '/api/schedule?date=2026-10-25']) {
    const response = await request(`${ORIGIN}${path}`, { session });
    seen.push({ method: 'GET', url: `${ORIGIN}${path}`, status: response.status, body: JSON.parse(response.body) });
  }
  return seen;
}
export const sessionOf = (person, extra = {}) => ({ version: 2, capturedAt: '2026-10-25T11:00:00.000Z', expiresAt: '2026-10-26T00:00:00.000Z',
  cookies: [{ name: 'sid', value: person.sid, domain: 'lms.example.edu', path: '/', secure: true, httpOnly: true }], ...extra });
