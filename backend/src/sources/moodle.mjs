import { AppError } from '../errors.mjs';
import { parseResponse, sanitizeText, digest } from './recipes.mjs';

export const MOODLE_CAPABILITIES = ['courses', 'deadlines'];
const readFunctions = new Set(['core_webservice_get_site_info', 'core_enrol_get_users_courses', 'mod_assign_get_assignments']);
const validId = value => (typeof value === 'number' || typeof value === 'string') && /^[1-9]\d{0,14}$/.test(String(value));
const invalid = () => { throw new AppError('source_response_invalid', 502); };

export async function syncMoodle({ store, request, userId, connection, fetchedAt }) {
  const origin = new URL(connection.sourceUrl).origin;
  let secret = store.readSecret(userId, connection.id);
  if (!secret || secret.origin !== origin) throw new AppError('source_auth_required', 401);
  const knownSecrets = [secret.password, secret.token].filter(value => typeof value === 'string' && value);
  let token = secret.token;
  if (!token && typeof secret.username === 'string' && typeof secret.password === 'string') {
    const body = new URLSearchParams({ username: secret.username, password: secret.password, service: secret.service || 'moodle_mobile_app' }).toString();
    const parsed = parseResponse(await request(`${origin}/login/token.php`, { method: 'POST', authenticated: true, body }));
    if (parsed.format !== 'json' || typeof parsed.data?.token !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(parsed.data.token)) throw new AppError('source_auth_required', 401);
    token = parsed.data.token;
    // Exchange is executor-only. Drop the password after obtaining a reusable token.
    store.setSecret(userId, connection.id, { origin, token });
    secret = null;
  }
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(token)) throw new AppError('source_auth_required', 401);
  async function call(fn, params = {}) {
    if (!readFunctions.has(fn)) throw new AppError('source_function_unsafe', 400);
    const body = new URLSearchParams({ wstoken: token, wsfunction: fn, moodlewsrestformat: 'json', ...params }).toString();
    const parsed = parseResponse(await request(`${origin}/webservice/rest/server.php`, { method: 'POST', authenticated: true, body }));
    if (parsed.format !== 'json') invalid();
    if (parsed.data?.exception || parsed.data?.errorcode) {
      throw new AppError(/(?:token|login|access|permission)/i.test(String(parsed.data.errorcode)) ? 'source_auth_required' : 'source_function_unavailable', 401);
    }
    return parsed.data;
  }
  const site = await call('core_webservice_get_site_info');
  if (!validId(site?.userid)) invalid();
  const rows = await call('core_enrol_get_users_courses', { userid: String(site.userid) });
  if (!Array.isArray(rows) || rows.length > 1000) invalid();
  knownSecrets.push(token);
  const clean = (value, limit) => sanitizeText(knownSecrets.reduce((text, secret) => text.split(secret).join('[redacted]'), String(value)), limit);
  const seen = new Set();
  const courses = rows.map(row => {
    if (!validId(row.id) || typeof row.fullname !== 'string' || !row.fullname.trim() || seen.has(String(row.id))) invalid();
    seen.add(String(row.id));
    return { id: `${connection.id}:${digest(`course:${row.id}`)}`, externalId: String(row.id), connectionId: connection.id, title: clean(row.fullname, 500), url: `${origin}/course/view.php?id=${row.id}`, sourceUrl: connection.sourceUrl, fetchedAt };
  });
  store.putSnapshot(userId, connection.id, { kind: 'courses', items: courses, fetchedAt, complete: true });
  let assignments;
  try {
    const params = Object.fromEntries(courses.map((c, i) => [`courseids[${i}]`, c.externalId]));
    assignments = courses.length ? await call('mod_assign_get_assignments', params) : { courses: [] };
    if (!Array.isArray(assignments?.courses) || assignments.courses.length > 1000 || (assignments.warnings?.length)) invalid();
    const deadlines = []; const ids = new Set(); const returnedCourses = new Set();
    for (const course of assignments.courses) {
      if (!validId(course.id) || !seen.has(String(course.id)) || returnedCourses.has(String(course.id)) || !Array.isArray(course.assignments)) invalid();
      returnedCourses.add(String(course.id));
      for (const row of course.assignments) {
        if (deadlines.length >= 1000 || !validId(row.id) || !validId(row.cmid) || typeof row.name !== 'string' || !row.name.trim() || ids.has(String(row.id)) || !Number.isSafeInteger(row.duedate) || row.duedate < 0) invalid();
        ids.add(String(row.id));
        if (!row.duedate) continue;
        const date = new Date(row.duedate * 1000);
        if (!Number.isFinite(date.getTime())) invalid();
        deadlines.push({ id: `${connection.id}:${digest(`assignment:${row.id}`)}`, externalId: String(row.id), connectionId: connection.id,
          title: clean(row.name, 500), courseId: `${connection.id}:${digest(`course:${course.id}`)}`, dueAt: date.toISOString(),
          url: `${origin}/mod/assign/view.php?id=${row.cmid}`, sourceUrl: connection.sourceUrl, fetchedAt });
      }
    }
    if (returnedCourses.size !== seen.size) invalid();
    store.putSnapshot(userId, connection.id, { kind: 'deadlines', items: deadlines, fetchedAt, complete: true });
    return { status: 'ready', capabilities: [...MOODLE_CAPABILITIES], counts: { courses: courses.length, deadlines: deadlines.length } };
  } catch (error) {
    // A denied function or malformed partial response cannot erase a prior deadline snapshot.
    return { status: error.code === 'source_auth_required' ? 'user_action_required' : 'error', capabilities: ['courses'], errorCode: error instanceof AppError ? error.code : 'source_unavailable', partial: true };
  }
}
