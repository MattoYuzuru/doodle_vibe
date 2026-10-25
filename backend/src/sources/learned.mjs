// Learned recipes v2 (contract §5-§6): lint, executor, canary and revisions. Types: backend/contracts.d.ts.
// A recipe is shared by every student of an origin and holds no personal value; the user's cookies / bearer stay in the
// encrypted secret and are applied by the executor (network.mjs session mode). Learning heuristics: learned-observe.mjs.
import { AppError } from '../errors.mjs';
import { digest, sanitizeText, redactSecrets } from './recipes.mjs';
import { SEED_RECIPES, SUPERSEDED_SEEDS } from './learned-seeds.mjs';

/** Read-only POST endpoints a learned recipe may call. Data, not code; extended only through review. */
export const READ_ONLY_POST_ALLOWLIST = Object.freeze([
  Object.freeze({ path: '/lib/ajax/service.php', methods: Object.freeze(['core_course_get_enrolled_courses_by_timeline_classification', 'core_calendar_get_action_events_by_timesort']) }),
]);
export const RECIPE_LIMITS = Object.freeze({ endpoints: 10, bootstrap: 5, pages: 3, items: 1000 });
export const KINDS = Object.freeze(['courses', 'schedule', 'deadlines', 'documents']);

const FIELD_NAMES = ['id', 'title', 'url', 'startsAt', 'endsAt', 'dueAt', 'location', 'courseId', 'description'];
const TRANSFORMS = ['iso', 'unixSeconds', 'unixMillis'];
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9]{0,30}$/;
const BUILTIN_PARAMS = new Set(['today', 'nowUnix']);
const KEY_NAME = /^[A-Za-z][A-Za-z0-9_.\[\]-]{0,40}$/;
const ID_NAME = /^[a-z][A-Za-z0-9_-]{0,40}$/;
const PATH_CHARS = /^\/[A-Za-z0-9._~\/:@%+,=!$&'()*{}-]*$/;
const SECRET_KEY = /(?:token|secret|password|passwd|cookie|session|sesskey|auth|api.?key|credential|csrf|jwt|signature)/i;
const FORBIDDEN_KEY = /^(?:password|passwd|secret|cookie|cookies|authorization|token|access_?token|refresh_?token|csrf|headers|credentials|session|sessionid|userId|studentId|email)$/i;
const ENV_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const LOGIN_CODES = new Set(['servicerequireslogin', 'invalid_token', 'token_expired', 'unauthorized']);
const LOGIN_PATH = /(?:^|\/)(?:login|auth|sso|oidc|signin)(?:\/|$|\.)/i;
const EXTRACTORS = new Set(['@moodle:sesskey']);

const plain = value => !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const bad = () => { throw new AppError('source_recipe_invalid', 400); };
const changed = () => new AppError('source_format_changed', 400);
const expired = () => new AppError('source_session_expired', 401);
const exact = (value, keys, required = []) => {
  if (!plain(value) || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => value[key] === undefined)) bad();
  return value;
};

/** True for `{version:2, type:'learned', ...}` adapter recipes; ignores the typed v1 recipes of ADR-0004. */
export function isLearnedRecipe(recipe) {
  return plain(recipe) && recipe.version === 2 && recipe.type === 'learned';
}

// --- templates and personal-data lint -------------------------------------------------------------------------

const TEMPLATE_TOKEN = /\{([^{}]*)\}/g;
/** Splits `/a/{userId}/x?` style text into literal and parameter parts; anything with stray braces is invalid. */
export function parseTemplate(text) {
  if (typeof text !== 'string' || text.length > 2000) bad();
  const parts = []; let last = 0;
  for (const match of text.matchAll(TEMPLATE_TOKEN)) {
    if (match.index > last) parts.push({ literal: text.slice(last, match.index) });
    const plus = /^plusDaysUnix:(\d{1,3})$/.exec(match[1]);
    if (plus) { if (Number(plus[1]) > 366) bad(); parts.push({ builtin: 'plusDaysUnix', days: Number(plus[1]) }); }
    else if (PARAM_NAME.test(match[1])) parts.push(BUILTIN_PARAMS.has(match[1]) ? { builtin: match[1] } : { param: match[1] });
    else bad();
    last = match.index + match[0].length;
  }
  const tail = text.slice(last);
  if (/[{}]/.test(tail)) bad();
  if (tail) parts.push({ literal: tail });
  return parts;
}

const PERSONAL = [
  /[^\s@\/]+@[^\s@\/]+\.[A-Za-z]{2,}/,                                           // e-mail
  /eyJ[A-Za-z0-9_-]{6,}/, /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,                // UUID
  /\d{6,}/, /\+?\d[\d\s().-]{8,}\d/,                                              // long digits, phone
  /(?=[A-Za-z0-9_+=-]*\d)[A-Za-z0-9_+=-]{32,}/, /bearer\s/i,                      // opaque tokens (method names carry no digits)
];
function checkLiteral(text, observed) {
  if (!text) return;
  if (PERSONAL.some(pattern => pattern.test(text)) || /\d{6,}/.test(text.replace(/[\s().-]/g, ''))) bad();
  if (observed) {
    const candidates = [text.trim(), ...text.split('/'), ...text.split(/[\s,;]+/)].filter(Boolean);
    if (candidates.some(candidate => observed.has(candidate))) bad();
  }
}
function checkTemplate(text, observed, { whole = false } = {}) {
  const parts = parseTemplate(text);
  if (whole && (parts.length !== 1 || parts[0].literal !== undefined)) bad();
  for (const part of parts) if (part.literal !== undefined) checkLiteral(part.literal, observed);
  return parts;
}
function checkPath(path, observed) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('..') || path.includes('\\') || /[?#]/.test(path) || path.length > 500 || !PATH_CHARS.test(path)) bad();
  if (/%(?:2e|2f|5c|0|1)/i.test(path)) bad();
  checkTemplate(path, observed);
  return path;
}
function checkJsonValue(value, observed, depth = 0) {
  if (depth > 4) bad();
  if (typeof value === 'string') { checkTemplate(value, observed); return value; }
  if (typeof value === 'number') { if (!Number.isFinite(value) || Math.abs(value) >= 1e6 || (Number.isInteger(value) && String(Math.abs(value)).length > 5)) bad(); return value; }
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) { if (value.length > 20) bad(); return value.map(item => checkJsonValue(item, observed, depth + 1)); }
  if (plain(value)) {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      if (!KEY_NAME.test(key) || ENV_NAMES.has(key) || FORBIDDEN_KEY.test(key)) bad();
      if (SECRET_KEY.test(key)) checkTemplate(String(child), observed, { whole: true });
      out[key] = checkJsonValue(child, observed, depth + 1);
    }
    return out;
  }
  return bad();
}
function checkPointer(pointer, { allowRoot = false } = {}, observed) {
  if (pointer === '' && allowRoot) return pointer;
  if (typeof pointer !== 'string' || !/^(?:\/[^\/]*)+$/.test(pointer) || pointer.length > 200) bad();
  const tokens = pointer.slice(1).split('/');
  if (tokens.length > 8) bad();
  for (const token of tokens) {
    if (!/^[A-Za-z0-9_.:$-]{1,60}$/.test(token) || ENV_NAMES.has(token) || (/^\d+$/.test(token) && token.length > 3)) bad();
    if (observed?.has(token)) bad();
    if (PERSONAL.some(pattern => pattern.test(token)) && !/^[A-Za-z_]+$/.test(token)) bad();
  }
  return pointer;
}

function postAllowed(path, body) {
  const entry = READ_ONLY_POST_ALLOWLIST.find(item => item.path === path);
  if (!entry || !Array.isArray(body) || body.length !== 1) return false;
  const [call] = body;
  return plain(call) && Object.keys(call).every(key => ['index', 'methodname', 'args'].includes(key)) && call.index === 0 &&
    entry.methods.includes(call.methodname) && plain(call.args);
}

function cleanEndpoint(raw, observed) {
  exact(raw, ['id', 'kind', 'request', 'response', 'pagination'], ['id', 'kind', 'request', 'response']);
  if (!ID_NAME.test(raw.id) || !KINDS.includes(raw.kind)) bad();
  const request = exact(raw.request, ['method', 'path', 'query', 'body'], ['method', 'path']);
  if (!['GET', 'POST'].includes(request.method)) bad();
  const out = { id: raw.id, kind: raw.kind, request: { method: request.method, path: checkPath(request.path, observed) } };
  if (request.query !== undefined) {
    if (!plain(request.query) || Object.keys(request.query).length > 20) bad();
    out.request.query = {};
    for (const [key, value] of Object.entries(request.query)) {
      if (!KEY_NAME.test(key) || ENV_NAMES.has(key) || FORBIDDEN_KEY.test(key) || typeof value !== 'string') bad();
      checkTemplate(value, observed, { whole: SECRET_KEY.test(key) });
      out.request.query[key] = value;
    }
  }
  if (request.method === 'POST') {
    // Read-only POST exists only as data in the code allowlist; the info query value must name the same method.
    if (!postAllowed(request.path, request.body)) bad();
    const method = request.body[0].methodname;
    if (out.request.query?.info !== undefined && out.request.query.info !== method) bad();
    out.request.body = checkJsonValue(request.body, observed);
  } else if (request.body !== undefined) bad();
  const response = exact(raw.response, ['itemsPath', 'fields'], ['itemsPath', 'fields']);
  const fields = exact(response.fields, FIELD_NAMES, ['id', 'title']);
  out.response = { itemsPath: checkPointer(response.itemsPath, { allowRoot: true }, observed), fields: {} };
  for (const [name, field] of Object.entries(fields)) {
    exact(field, ['path', 'transform'], ['path']);
    if (field.transform !== undefined && !TRANSFORMS.includes(field.transform)) bad();
    out.response.fields[name] = { path: checkPointer(field.path, {}, observed), ...(field.transform ? { transform: field.transform } : {}) };
  }
  if (raw.kind === 'schedule' && !fields.startsAt) bad();
  if (raw.kind === 'deadlines' && !fields.dueAt) bad();
  if (raw.kind === 'documents' && !fields.url) bad();
  if (raw.pagination !== undefined) {
    const page = exact(raw.pagination, ['type', 'param', 'limit', 'maxPages', 'cursorPath'], ['type', 'param', 'limit', 'maxPages']);
    if (!['offset', 'page', 'cursor'].includes(page.type) || !KEY_NAME.test(page.param) || !Number.isInteger(page.limit) || page.limit < 1 || page.limit > 1000 ||
        !Number.isInteger(page.maxPages) || page.maxPages < 1 || page.maxPages > RECIPE_LIMITS.pages || request.method !== 'GET' || out.request.query?.[page.param] !== undefined) bad();
    if ((page.type === 'cursor') !== (page.cursorPath !== undefined)) bad();
    out.pagination = { type: page.type, param: page.param, limit: page.limit, maxPages: page.maxPages, ...(page.cursorPath !== undefined ? { cursorPath: checkPointer(page.cursorPath, {}, observed) } : {}) };
  }
  return out;
}

/**
 * Throws AppError('source_recipe_invalid') unless the recipe satisfies contract §5; returns a clean copy built only from
 * the checked parts. `options.observedValues` (Set of strings seen in observations) forbids recipe literals equal to them.
 */
export function validateLearnedRecipe(recipe, options = {}) {
  if (!isLearnedRecipe(recipe)) bad();
  const observed = options.observedValues ? new Set(options.observedValues) : null;
  exact(recipe, ['version', 'type', 'origin', 'revision', 'learnedAt', 'rollbackOf', 'auth', 'bootstrap', 'endpoints', 'validation'],
    ['origin', 'revision', 'learnedAt', 'auth', 'endpoints', 'validation']);
  let origin;
  try { origin = new URL(recipe.origin); } catch { bad(); }
  if (origin.protocol !== 'https:' || origin.origin !== recipe.origin || origin.port || origin.username || origin.password) bad();
  if (options.origin !== undefined && options.origin !== recipe.origin) bad();
  if (!Number.isSafeInteger(recipe.revision) || recipe.revision < 1 || !Number.isFinite(Date.parse(recipe.learnedAt))) bad();
  if (recipe.rollbackOf !== undefined && (!Number.isSafeInteger(recipe.rollbackOf) || recipe.rollbackOf < 1 || recipe.rollbackOf >= recipe.revision)) bad();
  exact(recipe.auth, ['type'], ['type']);
  if (!['cookie', 'bearer'].includes(recipe.auth.type)) bad();
  const out = { version: 2, type: 'learned', origin: recipe.origin, revision: recipe.revision, learnedAt: new Date(recipe.learnedAt).toISOString(),
    ...(recipe.rollbackOf !== undefined ? { rollbackOf: recipe.rollbackOf } : {}), auth: { type: recipe.auth.type } };
  const ids = new Set();
  if (recipe.bootstrap !== undefined) {
    if (!Array.isArray(recipe.bootstrap) || recipe.bootstrap.length > RECIPE_LIMITS.bootstrap) bad();
    out.bootstrap = recipe.bootstrap.map(step => {
      exact(step, ['id', 'method', 'path', 'extract'], ['id', 'method', 'path', 'extract']);
      if (!ID_NAME.test(step.id) || ids.has(step.id) || step.method !== 'GET' || !plain(step.extract) || !Object.keys(step.extract).length || Object.keys(step.extract).length > 5) bad();
      ids.add(step.id);
      const extract = {};
      for (const [name, pointer] of Object.entries(step.extract)) {
        // Parameter names become recipe keys, so they must also pass the store's sensitive-key filter (`userId` is refused: use `uid`).
        if (!PARAM_NAME.test(name) || BUILTIN_PARAMS.has(name) || FORBIDDEN_KEY.test(name)) bad();
        extract[name] = EXTRACTORS.has(pointer) ? pointer : checkPointer(pointer, {}, observed);
      }
      return { id: step.id, method: 'GET', path: checkPath(step.path, observed), extract };
    });
  }
  if (!Array.isArray(recipe.endpoints) || !recipe.endpoints.length || recipe.endpoints.length > RECIPE_LIMITS.endpoints) bad();
  const endpointIds = new Set();
  out.endpoints = recipe.endpoints.map(raw => {
    const endpoint = cleanEndpoint(raw, observed);
    if (endpointIds.has(endpoint.id)) bad();
    endpointIds.add(endpoint.id);
    return endpoint;
  });
  const provided = new Set(out.bootstrap?.flatMap(step => Object.keys(step.extract)) ?? []);
  const used = new Set();
  const collect = text => { for (const part of parseTemplate(text)) if (part.param) used.add(part.param); };
  const walk = value => {
    if (typeof value === 'string') collect(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (plain(value)) Object.values(value).forEach(walk);
  };
  for (const endpoint of out.endpoints) { collect(endpoint.request.path); walk(endpoint.request.query); walk(endpoint.request.body); }
  for (const name of used) if (!provided.has(name)) bad();
  const validation = exact(recipe.validation, ['requireKinds', 'minItems'], ['requireKinds']);
  if (!Array.isArray(validation.requireKinds) || !validation.requireKinds.length || validation.requireKinds.length > KINDS.length ||
      new Set(validation.requireKinds).size !== validation.requireKinds.length || validation.requireKinds.some(kind => !out.endpoints.some(endpoint => endpoint.kind === kind))) bad();
  if (validation.minItems !== undefined && (!Number.isInteger(validation.minItems) || validation.minItems < 0 || validation.minItems > RECIPE_LIMITS.items)) bad();
  out.validation = { requireKinds: [...validation.requireKinds], ...(validation.minItems !== undefined ? { minItems: validation.minItems } : {}) };
  if (JSON.stringify(out).length > 60_000) bad();
  return out;
}

// --- session responses ----------------------------------------------------------------------------------------

const loginish = location => {
  try { return LOGIN_PATH.test(new URL(location, 'https://x.invalid/').pathname); } catch { return true; }
};
function loginCodeIn(value, depth = 0) {
  if (depth > 5 || value === null || typeof value !== 'object') return false;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:error|errorcode|error_code|code|exception|type)$/i.test(key) && typeof child === 'string' && LOGIN_CODES.has(child.toLowerCase())) return true;
    if (loginCodeIn(child, depth + 1)) return true;
  }
  return false;
}
const loginForm = text => /<input\b[^>]*type\s*=\s*["']?password\b/i.test(text) || /(?:samlrequest|openid-connect\/auth|name=["']?logintoken)/i.test(text) ||
  /<title\b[^>]*>\s*(?:log\s?in|sign\s?in|вход|авторизация)\b/i.test(text);

/**
 * Classifies a session response (contract §6). Throws source_session_expired for 401/403, a redirect to another origin or a
 * login path, login error codes and an HTML login form where data was expected. Returns `{format:'json'|'html', data?, text}`.
 */
export function inspectSessionResponse(response, { origin, expect = 'json' } = {}) {
  if (!response || !Number.isInteger(response.status)) throw new AppError('source_response_invalid', 502);
  if (response.status === 401 || response.status === 403) throw expired();
  if (response.status >= 300 && response.status < 400) {
    const location = String(response.headers?.location ?? '');
    let target;
    try { target = new URL(location, `${origin}/`); } catch { throw expired(); }
    if (target.origin !== origin || loginish(target.href)) throw expired();
    throw new AppError('source_unavailable', 502);
  }
  if (response.status === 429) throw new AppError('source_rate_limited', 429);
  if (response.status < 200 || response.status >= 300) throw new AppError('source_unavailable', 502);
  const text = typeof response.body === 'string' ? response.body : JSON.stringify(response.body ?? null);
  if (!text) throw changed();
  const type = String(response.headers?.['content-type'] ?? '').toLowerCase();
  if (type.includes('json') || (!type && /^\s*[\[{]/.test(text))) {
    let data;
    try { data = JSON.parse(text); } catch { throw changed(); }
    if (loginCodeIn(data)) throw expired();
    return { format: 'json', data, text };
  }
  if (type.includes('html') || /^\s*<(?:!doctype|html)/i.test(text)) {
    if (loginForm(text)) throw expired();
    if (expect === 'json') throw changed();
    return { format: 'html', text };
  }
  if (expect === 'json') throw changed();
  return { format: 'text', text };
}

// --- executor -------------------------------------------------------------------------------------------------

const REQUIRED_DATE = { schedule: 'startsAt', deadlines: 'dueAt' };
const unescapeToken = token => token.replace(/~1/g, '/').replace(/~0/g, '~');
/** Own-property JSON pointer read; undefined when absent. */
export function pointerGet(data, pointer) {
  if (pointer === '') return data;
  let node = data;
  for (const raw of pointer.slice(1).split('/')) {
    const token = unescapeToken(raw);
    if (Array.isArray(node)) { if (!/^\d+$/.test(token) || Number(token) >= node.length) return undefined; node = node[Number(token)]; }
    else if (plain(node) && Object.hasOwn(node, token)) node = node[token];
    else return undefined;
  }
  return node;
}
const PARAM_VALUE = /^(?!\.+$)[A-Za-z0-9_.-]{1,64}$/; // dot-only values would climb out of a path segment
const isoDay = ms => new Date(ms).toISOString().slice(0, 10);
function builtinValue(part, nowMs) {
  if (part.builtin === 'today') return isoDay(nowMs);
  if (part.builtin === 'nowUnix') return Math.floor(nowMs / 1000);
  return Math.floor(nowMs / 1000) + part.days * 86400;
}
function expand(text, params, nowMs, { path = false } = {}) {
  let out = '';
  for (const part of parseTemplate(text)) {
    if (part.literal !== undefined) out += part.literal;
    else {
      const value = part.builtin ? builtinValue(part, nowMs) : params.get(part.param);
      if (value === undefined || !PARAM_VALUE.test(String(value))) throw changed();
      out += path ? encodeURIComponent(String(value)) : String(value);
    }
  }
  return out;
}
function expandJson(value, params, nowMs) {
  if (typeof value === 'string') {
    const parts = parseTemplate(value);
    if (parts.length === 1 && parts[0].builtin && parts[0].builtin !== 'today') return builtinValue(parts[0], nowMs); // numeric stays a number
    return expand(value, params, nowMs);
  }
  if (Array.isArray(value)) return value.map(item => expandJson(item, params, nowMs));
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expandJson(child, params, nowMs)]));
  return value;
}

function sessionFor(recipe, session, now) {
  const bearer = recipe.auth.type === 'bearer' ? session?.bearer : undefined;
  return { origin: recipe.origin, auth: recipe.auth.type, cookies: recipe.auth.type === 'cookie' ? session?.cookies : undefined,
    bearer, postPaths: READ_ONLY_POST_ALLOWLIST.map(entry => entry.path), now };
}

/** The session is usable when it is a v2 StoredSession with credentials of the recipe's kind and has not expired. */
export function assertSessionUsable(session, recipe, now = Date.now()) {
  if (!plain(session) || session.version !== 2 || !Number.isFinite(Date.parse(session.expiresAt)) || Date.parse(session.expiresAt) <= now) throw expired();
  if (recipe.auth.type === 'cookie' && !(Array.isArray(session.cookies) && session.cookies.length)) throw expired();
  if (recipe.auth.type === 'bearer' && (!plain(session.bearer) || typeof session.bearer.token !== 'string' ||
      (session.bearer.expiresAt && Date.parse(session.bearer.expiresAt) <= now))) throw expired();
}

function secretsOf(session) {
  return [session.bearer?.token, ...(session.cookies ?? []).map(cookie => cookie.value)].filter(value => typeof value === 'string' && value.length >= 8);
}

const SESSKEY = /["']sesskey["']\s*:\s*["']([A-Za-z0-9]{8,16})["']/;
async function runBootstrap(steps, { recipe, call, params }) {
  for (const step of steps ?? []) {
    const wantsHtml = Object.values(step.extract).some(pointer => EXTRACTORS.has(pointer));
    const url = `${recipe.origin}${expand(step.path, params.map, params.now, { path: true })}`;
    const result = inspectSessionResponse(await call(url, { method: 'GET' }), { origin: recipe.origin, expect: wantsHtml ? 'html' : 'json' });
    for (const [name, pointer] of Object.entries(step.extract)) {
      const value = pointer === '@moodle:sesskey' ? SESSKEY.exec(result.text)?.[1] : pointerGet(result.data, pointer);
      if (!['string', 'number'].includes(typeof value) || !PARAM_VALUE.test(String(value))) throw changed();
      params.map.set(name, String(value));
    }
  }
}

function toDate(value, transform) {
  let ms;
  if (transform === 'unixSeconds' || transform === 'unixMillis') {
    const number = typeof value === 'string' && /^\d{1,13}$/.test(value) ? Number(value) : value;
    if (!Number.isFinite(number) || number < 0) throw changed();
    ms = transform === 'unixSeconds' ? number * 1000 : number;
  } else if (typeof value === 'string' && value.length <= 40 && (transform === 'iso' ? /^\d{4}-\d\d-\d\d/.test(value) : /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value))) ms = Date.parse(value);
  else throw changed();
  const date = new Date(ms);
  if (!Number.isFinite(ms) || date.getUTCFullYear() < 2000 || date.getUTCFullYear() > 2100) throw changed();
  return date.toISOString();
}

function mapRows(rows, endpoint, { connection, origin, fetchedAt, secrets }) {
  const { fields } = endpoint.response;
  const clean = (value, limit) => sanitizeText(redactSecrets(String(value), secrets), limit);
  const result = [];
  for (const row of rows) {
    if (!plain(row)) throw changed();
    const externalId = pointerGet(row, fields.id.path);
    const title = pointerGet(row, fields.title.path);
    if (!['string', 'number'].includes(typeof externalId) || !String(externalId) || String(externalId).length > 200 || typeof title !== 'string' || !title.trim()) throw changed();
    const prefix = endpoint.kind === 'courses' ? 'course' : endpoint.kind;
    const item = { id: `${connection.id}:${digest(`${prefix}:${externalId}`)}`, externalId: String(externalId), connectionId: connection.id,
      title: clean(title, 500), url: connection.sourceUrl, sourceUrl: connection.sourceUrl, fetchedAt };
    let skip = false;
    for (const [name, field] of Object.entries(fields)) {
      if (['id', 'title'].includes(name)) continue;
      const value = pointerGet(row, field.path);
      if (value === undefined || value === null || value === '') { if (name === REQUIRED_DATE[endpoint.kind]) skip = true; continue; }
      if (['startsAt', 'endsAt', 'dueAt'].includes(name)) item[name] = toDate(value, field.transform);
      else if (name === 'courseId') { if (!['string', 'number'].includes(typeof value)) throw changed(); item.courseId = `${connection.id}:${digest(`course:${value}`)}`; }
      else if (name === 'url') {
        try {
          const link = new URL(String(value), `${origin}/`);
          if (link.origin === origin && !link.username && !link.password && link.protocol === 'https:') { link.hash = ''; item.url = link.href; }
        } catch { /* An unusable link falls back to the connection URL. */ }
      } else if (['string', 'number'].includes(typeof value)) item[name] = clean(value, 1000);
      else throw changed();
    }
    if (!skip) result.push(item);
  }
  return result;
}

async function runEndpoint(endpoint, { recipe, call, params, connection, fetchedAt, secrets, now }) {
  const rows = []; let complete = true;
  const paging = endpoint.pagination;
  let cursor;
  for (let page = 0; page < (paging?.maxPages ?? 1); page++) {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(endpoint.request.query ?? {})) query.set(key, expand(value, params.map, now));
    if (paging) {
      query.set(paging.param, paging.type === 'offset' ? String(page * paging.limit) : paging.type === 'page' ? String(page + 1) : cursor ?? '');
      if (paging.type === 'cursor' && cursor === undefined) query.delete(paging.param);
    }
    const url = `${recipe.origin}${expand(endpoint.request.path, params.map, now, { path: true })}${query.size ? `?${query}` : ''}`;
    const body = endpoint.request.method === 'POST' ? JSON.stringify(expandJson(endpoint.request.body, params.map, now)) : undefined;
    const result = inspectSessionResponse(await call(url, { method: endpoint.request.method, ...(body !== undefined ? { body } : {}) }), { origin: recipe.origin });
    const found = pointerGet(result.data, endpoint.response.itemsPath);
    if (endpoint.request.method === 'POST' && Array.isArray(result.data) && result.data[0]?.error === true) throw changed();
    if (!Array.isArray(found)) throw changed();
    rows.push(...found);
    if (rows.length > RECIPE_LIMITS.items) throw changed();
    if (!paging) break;
    if (paging.type === 'cursor') {
      cursor = pointerGet(result.data, paging.cursorPath);
      if (cursor === undefined || cursor === null || cursor === '') break;
      if (typeof cursor !== 'string' && typeof cursor !== 'number') throw changed();
      cursor = String(cursor);
    } else if (found.length < paging.limit) break;
    if (page === paging.maxPages - 1) complete = false;
  }
  if (!complete) throw new AppError('source_response_invalid', 502);
  return mapRows(rows, endpoint, { connection, origin: recipe.origin, fetchedAt, secrets });
}

/**
 * Executes a recipe with a StoredSession. Returns `{snapshots:[{kind,items}], documents, failures:[{endpointId,kind,code}], counts}`;
 * a kind whose endpoint failed is absent from snapshots, so the caller keeps its previous snapshot. Throws source_session_expired
 * as soon as any response shows the session is gone, and source_format_changed when no kind could be read.
 */
export async function syncLearned({ recipe, session, request, connection, fetchedAt, now = Date.now() }) {
  const clean = validateLearnedRecipe(recipe);
  if (typeof request !== 'function' || !connection || new URL(connection.sourceUrl).origin !== clean.origin) bad();
  assertSessionUsable(session, clean, now);
  const sessionOptions = sessionFor(clean, session, now);
  const call = (url, options) => request(url, { ...options, session: sessionOptions });
  const secrets = secretsOf(session);
  const params = { map: new Map(), now };
  await runBootstrap(clean.bootstrap, { recipe: clean, call, params });
  const byKind = new Map(); const failures = [];
  for (const endpoint of clean.endpoints) {
    try {
      const items = await runEndpoint(endpoint, { recipe: clean, call, params, connection, fetchedAt, secrets, now });
      byKind.set(endpoint.kind, [...(byKind.get(endpoint.kind) ?? []), ...items]);
    } catch (error) {
      if (!(error instanceof AppError) || error.code === 'source_session_expired' || error.code === 'source_rate_limited') throw error;
      failures.push({ endpointId: endpoint.id, kind: endpoint.kind, code: error.code });
    }
  }
  const failedKinds = new Set(failures.map(failure => failure.kind));
  const snapshots = []; const documents = []; const counts = {};
  for (const [kind, items] of byKind) {
    if (failedKinds.has(kind)) continue;
    const unique = [...new Map(items.map(item => [item.id, item])).values()];
    counts[kind] = unique.length;
    if (kind === 'documents') {
      for (const item of unique) {
        const link = new URL(item.url);
        if (link.search || link.hash || item.url === connection.sourceUrl) continue; // putDocument stores query-free URLs only
        documents.push({ id: item.id, connectionId: connection.id, url: item.url, title: item.title, text: item.description ?? item.title, fetchedAt });
      }
    } else snapshots.push({ kind, items: unique });
  }
  if (!Object.keys(counts).length && failures.length) throw new AppError(failures[0].code, 400);
  return { snapshots, documents, failures, counts };
}

/** Canary (contract §5): the candidate must produce `minItems` valid items of every required kind on the observer's session. */
export async function canaryLearnedRecipe({ recipe, session, request, now = Date.now() }) {
  const clean = validateLearnedRecipe(recipe);
  const connection = { id: 'canary', sourceUrl: `${clean.origin}/` };
  const result = await syncLearned({ recipe: clean, session, request, connection, fetchedAt: new Date(now).toISOString(), now });
  const minItems = clean.validation.minItems ?? 1;
  if (result.failures.length) throw new AppError('source_recipe_invalid', 400);
  for (const kind of clean.validation.requireKinds) if ((result.counts[kind] ?? 0) < minItems) throw new AppError('source_recipe_invalid', 400);
  return { counts: result.counts };
}

// --- adapters, revisions, rollback ----------------------------------------------------------------------------

export const learnedAdapterId = (origin, revision) => `learned:${digest(origin)}:${revision}`;
function recipeOfAdapter(adapter) {
  try { return isLearnedRecipe(adapter?.recipe) ? validateLearnedRecipe(adapter.recipe, { origin: adapter.origin }) : null; } catch { return null; }
}
/** Latest valid learned revision for an origin: `{adapter, recipe}` or null. Revisions are probed, so a typed adapter cannot shadow them. */
export function findLearnedAdapter(store, origin) {
  let latest = null;
  for (let revision = 1; revision <= 1000; revision++) {
    const adapter = store.getAdapter(learnedAdapterId(origin, revision));
    if (!adapter) break;
    const recipe = recipeOfAdapter(adapter);
    if (recipe) latest = { adapter, recipe };
  }
  return latest;
}
const sameBody = (a, b) => JSON.stringify({ ...a, revision: 0, learnedAt: 0, rollbackOf: 0 }) === JSON.stringify({ ...b, revision: 0, learnedAt: 0, rollbackOf: 0 });
function put(store, recipe) {
  const kinds = [...new Set(recipe.endpoints.map(endpoint => endpoint.kind))];
  return store.putAdapter({ id: learnedAdapterId(recipe.origin, recipe.revision), origin: recipe.origin, version: String(recipe.revision), recipe, capabilities: kinds });
}
/** Stores a validated recipe as the next revision (unchanged content keeps the current one). Returns `{adapter, recipe, created}`. */
export function activateLearnedRecipe(store, recipe, { now = Date.now() } = {}) {
  const current = findLearnedAdapter(store, recipe.origin);
  const revision = (current?.recipe.revision ?? 0) + 1;
  const clean = validateLearnedRecipe({ ...recipe, revision, learnedAt: new Date(now).toISOString() });
  if (current && sameBody(current.recipe, clean)) return { ...current, created: false };
  return { adapter: put(store, clean), recipe: clean, created: true };
}
/** Rollback = a new revision that copies the previous one and names it in `rollbackOf` (the old revisions stay). */
export function rollbackLearnedRecipe(store, origin, { now = Date.now() } = {}) {
  const current = findLearnedAdapter(store, origin);
  if (!current) return null;
  const target = (current.recipe.rollbackOf ?? current.recipe.revision) - 1;
  for (let revision = target; revision >= 1; revision--) {
    const previous = recipeOfAdapter(store.getAdapter(learnedAdapterId(origin, revision)));
    if (!previous) continue;
    const clean = validateLearnedRecipe({ ...previous, revision: current.recipe.revision + 1, learnedAt: new Date(now).toISOString(), rollbackOf: revision });
    return { adapter: put(store, clean), recipe: clean };
  }
  return null;
}
/** Installs a reviewed seed recipe for an origin without learned revisions (data in learned-seeds.mjs). */
export function ensureSeedRecipe(store, origin, { now = Date.now() } = {}) {
  const found = findLearnedAdapter(store, origin);
  const seed = SEED_RECIPES[origin];
  // A revision installed from an earlier seed follows the reviewed seed; learned and rolled-back revisions are kept.
  if (found && seed && found.recipe.rollbackOf === undefined
    && (SUPERSEDED_SEEDS[origin] ?? []).some(old => sameBody(found.recipe, validateLearnedRecipe({ ...old, revision: 1, learnedAt: found.recipe.learnedAt })))) {
    return activateLearnedRecipe(store, seed, { now });
  }
  if (found) return found;
  if (!seed) return null;
  const clean = validateLearnedRecipe({ ...seed, revision: 1, learnedAt: new Date(now).toISOString() });
  return { adapter: put(store, clean), recipe: clean };
}

// Shadow verification (contract §5): the first syncs of other users on a revision must keep matching the format. Three
// different users failing in a row (no success in between) roll the shared recipe back. Process memory only.
const health = new Map();
export const resetRecipeHealth = () => health.clear();
export function recordRecipeHealth(store, adapter, userId, ok, { now } = {}) {
  const state = health.get(adapter.id) ?? { users: new Set() };
  if (ok) { health.delete(adapter.id); return null; }
  state.users.add(digest(String(userId)));
  health.set(adapter.id, state);
  if (state.users.size < 3) return null;
  health.delete(adapter.id);
  const latest = findLearnedAdapter(store, adapter.origin);
  if (!latest || latest.adapter.id !== adapter.id) return null;
  return rollbackLearnedRecipe(store, adapter.origin, { now });
}

export { learnFromObservations, observationShapes, learnAndActivate } from './learned-observe.mjs';
