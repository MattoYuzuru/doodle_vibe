// Learning step of contract §5: observed XHR/fetch (in memory only) -> deterministic candidate -> lint -> canary -> new revision.
// Values never leave this module: a model may only be asked with `observationShapes` (keys, types, templated paths).
import { validateLearnedRecipe, canaryLearnedRecipe, activateLearnedRecipe, RECIPE_LIMITS } from './learned.mjs';

/**
 * Observation: `{method:'GET'|'POST', url, status, body}` where `url` is the absolute request URL and `body` the parsed JSON
 * response. Observations of other origins, non-200 and non-JSON responses are ignored.
 */
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const SECRET_PARAM = /(?:token|secret|password|passwd|cookie|session|sesskey|auth|api.?key|credential|csrf|jwt|signature)/i;
const DENIED_PATH = /(?:logout|logoff|signout|sign-out|delete|remove|submit|unenrol)/i;
const ID_KEYS = ['id', 'userid', 'user_id', 'studentid', 'student_id', 'sub'];
const NAMES = {
  id: ['id', 'uuid', 'externalid', 'eventid', 'taskid'],
  title: ['title', 'name', 'fullname', 'summary', 'subject'],
  url: ['url', 'link', 'href', 'viewurl'],
  startsAt: ['startsat', 'start', 'starts', 'startdate', 'starttime', 'begin', 'timestart'],
  endsAt: ['endsat', 'end', 'ends', 'enddate', 'endtime', 'timeend'],
  dueAt: ['dueat', 'due', 'duedate', 'deadline', 'timesort'],
  location: ['location', 'room', 'place', 'auditorium'],
  description: ['description', 'text', 'comment'],
};
const OWNER_PARENTS = ['exercise', 'task', 'assignment', 'event', 'item', 'homework'];
const escapeToken = token => token.replace(/~/g, '~0').replace(/\//g, '~1');

function scalars(value, out, depth = 0) {
  if (depth > 6 || out.size > 20_000) return;
  if (typeof value === 'string') out.set(value, (out.get(value) ?? 0) + 1);
  else if (typeof value === 'number') out.set(String(value), (out.get(String(value)) ?? 0) + 1);
  else if (Array.isArray(value)) value.slice(0, 200).forEach(child => scalars(child, out, depth + 1));
  else if (plain(value)) Object.values(value).forEach(child => scalars(child, out, depth + 1));
}
/** Strings and numbers a recipe literal must not equal; repeated lowercase status words (`published`) are structure, not personal. */
function observedValues(observations) {
  const counts = new Map();
  for (const observation of observations) scalars(observation.body, counts);
  const result = new Set();
  for (const [value, count] of counts) {
    const enumLike = /^[a-z][a-z_-]{2,30}$/.test(value) && count >= 3;
    if (value.length >= 3 && !enumLike && !(/^\d+$/.test(value) && value.length < 4)) result.add(value);
  }
  return result;
}

function usable(observations, origin) {
  const seen = new Set(); const out = [];
  for (const observation of observations ?? []) {
    if (!plain(observation) || observation.method !== 'GET' || observation.status !== 200 || (!plain(observation.body) && !Array.isArray(observation.body))) continue;
    let url; try { url = new URL(observation.url); } catch { continue; }
    if (url.origin !== origin || DENIED_PATH.test(url.pathname)) continue;
    const key = `${url.pathname}?${[...url.searchParams.keys()].sort().join('&')}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push({ ...observation, parsed: url });
  }
  return out;
}

function identityOf(observations) {
  for (const observation of observations) {
    if (!plain(observation.body)) continue;
    for (const key of Object.keys(observation.body)) {
      const value = observation.body[key];
      if (ID_KEYS.includes(key.toLowerCase()) && ['string', 'number'].includes(typeof value) && /^[A-Za-z0-9_-]{3,64}$/.test(String(value))) {
        const text = String(value);
        const used = observations.some(other => other !== observation && (other.parsed.pathname.split('/').includes(text) || [...other.parsed.searchParams.values()].includes(text)));
        if (used) return { observation, pointer: `/${escapeToken(key)}`, value: text };
      }
    }
  }
  return null;
}

function leavesOf(row, depth = 0, prefix = '', parent = '') {
  const out = [];
  if (!plain(row) || depth > 2) return out;
  for (const [key, value] of Object.entries(row)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    const pointer = `${prefix}/${escapeToken(key)}`;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) out.push({ pointer, key: key.toLowerCase(), parent: parent.toLowerCase(), depth, value });
    else if (plain(value)) out.push(...leavesOf(value, depth + 1, pointer, key));
  }
  return out;
}
function commonLeaves(rows) {
  const sample = rows.slice(0, 20);
  const first = leavesOf(sample[0]);
  return first.filter(leaf => sample.every(row => leavesOf(row).some(other => other.pointer === leaf.pointer)))
    .map(leaf => ({ ...leaf, values: sample.map(row => leavesOf(row).find(other => other.pointer === leaf.pointer)?.value) }));
}
function pick(leaves, names, accepts, parents = []) {
  for (const name of names) {
    const found = leaves.filter(leaf => leaf.key === name && accepts(leaf));
    if (!found.length) continue;
    const depth = Math.min(...found.map(leaf => leaf.depth));
    const shallow = found.filter(leaf => leaf.depth === depth);
    if (shallow.length === 1) return shallow[0];
    const preferred = shallow.filter(leaf => parents.includes(leaf.parent));
    if (preferred.length === 1) return preferred[0];
  }
  return null;
}

function findItems(body) {
  if (Array.isArray(body)) return body.length && body.every(plain) ? { pointer: '', rows: body } : null;
  let best = null;
  const walk = (node, pointer, depth) => {
    if (depth > 3 || !plain(node)) return;
    for (const [key, child] of Object.entries(node)) {
      const next = `${pointer}/${escapeToken(key)}`;
      if (Array.isArray(child) && child.length && child.every(plain) && (!best || child.length > best.rows.length)) best = { pointer: next, rows: child };
      else walk(child, next, depth + 1);
    }
  };
  walk(body, '', 0);
  return best;
}

const iso = /^\d{4}-\d\d-\d\d(?:[T ]|$)/;
function dateTransform(value) {
  if (typeof value === 'string' && iso.test(value) && Number.isFinite(Date.parse(value))) return 'iso';
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 9.46e8 && value <= 4.1e9) return 'unixSeconds';
    if (value >= 9.46e11 && value <= 4.1e12) return 'unixMillis';
  }
  return null;
}

function mapFields(rows, path) {
  const leaves = commonLeaves(rows);
  const scalar = leaf => ['string', 'number'].includes(typeof leaf.value);
  const text = leaf => leaf.values.every(value => typeof value === 'string' || value === null);
  const date = leaf => leaf.values.filter(value => value !== null && value !== '').every(value => dateTransform(value)) && leaf.values.some(value => value !== null && value !== '');
  const id = pick(leaves, NAMES.id, leaf => scalar(leaf) && new Set(leaf.values).size === leaf.values.length, OWNER_PARENTS);
  const title = pick(leaves, NAMES.title, leaf => typeof leaf.value === 'string' && leaf.values.every(value => typeof value === 'string' && value.trim()), OWNER_PARENTS);
  if (!id || !title) return null;
  const fields = { id: { path: id.pointer }, title: { path: title.pointer } };
  for (const name of ['startsAt', 'endsAt', 'dueAt']) {
    const leaf = pick(leaves, NAMES[name], date, OWNER_PARENTS);
    if (leaf) fields[name] = { path: leaf.pointer, transform: dateTransform(leaf.values.find(value => value !== null && value !== '')) };
  }
  for (const name of ['url', 'location', 'description']) {
    const leaf = pick(leaves, NAMES[name], text, OWNER_PARENTS);
    if (leaf && !Object.values(fields).some(field => field.path === leaf.pointer)) fields[name] = { path: leaf.pointer };
  }
  const course = leaves.find(leaf => ['courseid', 'course_id'].includes(leaf.key) && scalar(leaf)) ?? leaves.find(leaf => leaf.parent === 'course' && leaf.key === 'id' && scalar(leaf));
  if (course) fields.courseId = { path: course.pointer };
  let kind;
  if (fields.dueAt && (!fields.startsAt || /deadline|due/i.test(path))) kind = 'deadlines';
  else if (fields.startsAt) kind = 'schedule';
  else if (/course/i.test(path)) kind = 'courses';
  else if (fields.url && /document|material|file|resource|longread|syllabus/i.test(path)) kind = 'documents';
  if (!kind || (kind === 'documents' && !fields.url)) return null;
  if (kind === 'deadlines') delete fields.endsAt;
  return { kind, fields };
}

function templatize(url, identity, nowMs) {
  const path = url.pathname.split('/').map(segment => (identity && decodeURIComponent(segment) === identity.value ? '{uid}' : segment)).join('/');
  const query = {}; let limit; let paging;
  const nowSec = Math.floor(nowMs / 1000);
  for (const [key, value] of url.searchParams) {
    if (SECRET_PARAM.test(key)) return null;
    const lower = key.toLowerCase();
    if (['offset', 'page'].includes(lower)) { paging = { type: lower, param: key }; continue; }
    if (['limit', 'per_page', 'pagesize', 'size', 'count'].includes(lower)) { limit = Number(value); query[key] = value; continue; }
    if (identity && value === identity.value) query[key] = '{uid}';
    else if (value === new Date(nowMs).toISOString().slice(0, 10)) query[key] = '{today}';
    else if (/^\d{9,10}$/.test(value) && Math.abs(Number(value) - nowSec) <= 90_000) query[key] = '{nowUnix}';
    else if (/^\d{9,10}$/.test(value) && Number(value) > nowSec && Number(value) - nowSec <= 366 * 86400) query[key] = `{plusDaysUnix:${Math.round((Number(value) - nowSec) / 86400)}}`;
    else query[key] = value;
  }
  return { path, query, limit, paging };
}

function candidateEndpoint(observation, identity, nowMs, index) {
  const items = findItems(observation.body);
  if (!items) return null;
  const templated = templatize(observation.parsed, identity, nowMs);
  if (!templated) return null;
  const mapped = mapFields(items.rows, observation.parsed.pathname);
  if (!mapped) return null;
  const endpoint = { id: `${mapped.kind}${index}`, kind: mapped.kind,
    request: { method: 'GET', path: templated.path, ...(Object.keys(templated.query).length ? { query: templated.query } : {}) },
    response: { itemsPath: items.pointer, fields: mapped.fields } };
  if (templated.paging) {
    const limit = Number.isInteger(templated.limit) && templated.limit > 0 ? templated.limit : items.rows.length;
    if (limit < 1 || limit > 1000) return null;
    endpoint.pagination = { type: templated.paging.type, param: templated.paging.param, limit, maxPages: RECIPE_LIMITS.pages };
  }
  return endpoint;
}

function shapeOf(value, depth = 0) {
  if (Array.isArray(value)) return depth > 3 ? ['…'] : [value.length ? shapeOf(value[0], depth + 1) : 'empty'];
  if (plain(value)) return depth > 3 ? '…' : Object.fromEntries(Object.entries(value).slice(0, 40).map(([key, child]) => [key.slice(0, 60), shapeOf(child, depth + 1)]));
  return value === null ? 'null' : typeof value;
}
/** What a model may see: templated paths, query key names and the key/type skeleton of each JSON body — no values. */
export function observationShapes(observations, { origin } = {}) {
  const list = usable(observations, origin);
  const identity = identityOf(list);
  return list.slice(0, 20).map(observation => {
    const templated = templatize(observation.parsed, identity, Date.now());
    const path = (templated?.path ?? observation.parsed.pathname).split('/').map(segment => (/\d{3,}/.test(segment) ? '{n}' : segment)).join('/');
    return { method: observation.method, path, queryKeys: [...observation.parsed.searchParams.keys()].slice(0, 20), shape: shapeOf(observation.body) };
  });
}

/**
 * Builds a validated LearnedRecipe candidate from observations, or null. Endpoints that cannot be generalised without a personal
 * value are dropped. `options.propose(shapes)` is an optional model that proposes a recipe from shapes only; its answer is
 * linted like any other. Options: `origin`, `now`, `revision`, `auth`.
 */
export async function learnFromObservations(observations, { origin, now = Date.now(), revision = 1, auth = 'cookie', propose } = {}) {
  const list = usable(observations, origin);
  const observed = observedValues(list);
  const identity = identityOf(list);
  const base = { version: 2, type: 'learned', origin, revision, learnedAt: new Date(now).toISOString(), auth: { type: auth } };
  const bootstrap = identity ? [{ id: 'me', method: 'GET', path: identity.observation.parsed.pathname, extract: { uid: identity.pointer } }] : undefined;
  const endpoints = [];
  for (const observation of list) {
    if (observation === identity?.observation && !findItems(observation.body)) continue;
    const endpoint = candidateEndpoint(observation, identity, now, endpoints.length + 1);
    if (!endpoint) continue;
    const trial = { ...base, ...(bootstrap ? { bootstrap } : {}), endpoints: [endpoint], validation: { requireKinds: [endpoint.kind] } };
    try { validateLearnedRecipe(trial, { observedValues: observed, origin }); } catch { continue; }
    endpoints.push(endpoint);
    if (endpoints.length >= RECIPE_LIMITS.endpoints) break;
  }
  const finish = recipe => {
    try { return validateLearnedRecipe(recipe, { observedValues: observed, origin }); } catch { return null; }
  };
  if (endpoints.length) {
    const usesUid = JSON.stringify(endpoints).includes('{uid}');
    const kinds = [...new Set(endpoints.map(endpoint => endpoint.kind))];
    const recipe = finish({ ...base, ...(usesUid && bootstrap ? { bootstrap } : {}), endpoints, validation: { requireKinds: kinds, minItems: 1 } });
    if (recipe) return recipe;
  }
  if (typeof propose === 'function') {
    const proposed = await propose(observationShapes(list, { origin }));
    if (proposed) return finish({ ...proposed, origin, revision, learnedAt: base.learnedAt });
  }
  return null;
}

/** learn -> lint (inside learn) -> canary on the observer's session -> new adapter revision. Returns `{adapter, recipe, created}` or null. */
export async function learnAndActivate({ store, observations, session, request, origin, now = Date.now(), auth, propose }) {
  const candidate = await learnFromObservations(observations, { origin, now, auth, propose });
  if (!candidate) return null;
  await canaryLearnedRecipe({ recipe: candidate, session, request, now });
  return activateLearnedRecipe(store, candidate, { now });
}
