import { createHash } from 'node:crypto';
import { AppError } from '../errors.mjs';
import { validateSourceUrl, MAX_BYTES } from './network.mjs';

const kinds = ['courses', 'schedule', 'deadlines', 'documents'];
const fields = ['id', 'title', 'url', 'startsAt', 'endsAt', 'dueAt', 'location', 'courseId', 'description'];
// Only structural vocabulary is exposed to discovery. Unknown/personal header
// names are deliberately absent, rather than heuristically redacted.
const sourceKeys = new Set(['id', 'title', 'name', 'fullname', 'shortname', 'url', 'link', 'courses', 'schedule', 'deadlines', 'items', 'data', 'events', 'assignments', 'startsAt', 'endsAt', 'dueAt', 'start', 'end', 'due', 'startTime', 'endTime', 'startdate', 'enddate', 'duedate', 'location', 'room', 'courseId', 'course', 'description', 'text', 'Курс', 'Название', 'Начало', 'Конец', 'Срок', 'Аудитория']);
const plain = obj => !!obj && typeof obj === 'object' && !Array.isArray(obj) && Object.getPrototypeOf(obj) === Object.prototype;
const bad = () => { throw new AppError('source_recipe_invalid', 400); };
export const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 24);

export function validateRecipe(recipe) {
  if (!plain(recipe) || Object.keys(recipe).some(key => !['version', 'format', 'path', 'kind', 'itemsPath', 'fields'].includes(key)) ||
      recipe.version !== 1 || !['json', 'csv', 'html'].includes(recipe.format) || recipe.path !== '$source' || !kinds.includes(recipe.kind)) bad();
  if (recipe.format === 'html') {
    if (recipe.kind !== 'documents' || recipe.fields || recipe.itemsPath) bad();
  } else {
    if (!plain(recipe.fields) || !recipe.fields.id || !recipe.fields.title || Object.keys(recipe.fields).some(key => !fields.includes(key)) ||
        Object.values(recipe.fields).some(key => typeof key !== 'string' || !sourceKeys.has(key))) bad();
    if (recipe.itemsPath !== undefined && (typeof recipe.itemsPath !== 'string' || recipe.itemsPath.split('.').length > 3 ||
      recipe.itemsPath.split('.').some(key => !sourceKeys.has(key)))) bad();
    if (recipe.kind === 'schedule' && !recipe.fields.startsAt) bad();
    if (recipe.kind === 'deadlines' && !recipe.fields.dueAt) bad();
    if (recipe.kind === 'documents') bad();
  }
  return JSON.parse(JSON.stringify(recipe));
}

export function sanitizeText(value, limit = 100_000) {
  return String(value ?? '').replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|form|nav|header|footer|noscript|iframe)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gi, ' ')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted]')
    .replace(/(?:password|passwd|token|secret|cookie|session|csrf|authorization)\s*[:=]\s*\S+/gi, '[redacted]')
    .replace(/\b[A-Za-z0-9_+-]{32,}\b/g, '[redacted]')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function parseCsv(text) {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new AppError('source_too_large', 400);
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; } else cell += c;
    } else if (c === '"') {
      if (cell || closed) bad();
      quoted = true;
    } else if (c === ',' || c === '\n' || c === '\r') {
      row.push(cell); cell = ''; closed = false;
      if (c !== ',') { if (row.some(v => v)) rows.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++; }
    } else { if (closed) bad(); cell += c; }
  }
  if (quoted) bad();
  row.push(cell); if (row.some(v => v)) rows.push(row);
  const header = rows.shift();
  if (!header || header.length > 100 || new Set(header).size !== header.length || header.some(key => !key || ['__proto__', 'constructor', 'prototype'].includes(key))) bad();
  if (rows.length > 1000 || rows.some(r => r.length !== header.length)) bad();
  return { header, items: rows.map(r => Object.fromEntries(header.map((key, i) => [key, r[i]]))) };
}

export function parseResponse(response) {
  if (!response || !Number.isInteger(response.status)) throw new AppError('source_response_invalid', 502);
  if (response.status === 401 || response.status === 403) throw new AppError('source_auth_required', 401);
  if (response.status === 429) throw new AppError('source_rate_limited', 429);
  if (response.status < 200 || response.status >= 300) throw new AppError('source_unavailable', 502);
  const text = typeof response.body === 'string' ? response.body : JSON.stringify(response.body);
  if (!text || Buffer.byteLength(text) > MAX_BYTES) throw new AppError('source_response_invalid', 502);
  const type = String(response.headers?.['content-type'] ?? response.headers?.get?.('content-type') ?? '').toLowerCase();
  if (type.includes('json')) {
    let data; try { data = JSON.parse(text); } catch { throw new AppError('source_response_invalid', 502); }
    return { format: 'json', data, text };
  }
  if (type.includes('csv')) return { format: 'csv', data: parseCsv(text), text };
  if (type.includes('html')) return { format: 'html', text };
  throw new AppError('source_format_unsupported', 400);
}

export function publicObservation(origin, parsed) {
  let keys = [];
  if (parsed.format === 'csv') keys = parsed.data.header;
  if (parsed.format === 'json') {
    const data = parsed.data;
    keys = Array.isArray(data) ? Object.keys(data[0] ?? {}) : Object.keys(data ?? {});
    for (const key of keys.slice()) if (Array.isArray(data?.[key])) keys.push(...Object.keys(data[key][0] ?? {}));
  }
  return { origin, format: parsed.format, keys: [...new Set(keys.filter(key => sourceKeys.has(key)))].sort(), untrusted: true };
}

export function normalizeRecipe(recipe, parsed, { connection, fetchedAt, url }) {
  validateRecipe(recipe);
  if (parsed.format !== recipe.format) throw new AppError('source_format_changed', 400);
  if (recipe.format === 'html') {
    if (/<title\b[^>]*>\s*(?:log\s?in|sign\s?in|вход|авторизация)\s*<\/title>/i.test(parsed.text) || /<input\b[^>]*type\s*=\s*["']?password\b/i.test(parsed.text) || /(?:samlrequest|openid-connect|sign in to|вход в личный кабинет)/i.test(parsed.text)) {
      throw new AppError('source_auth_required', 401);
    }
    const text = sanitizeText(parsed.text);
    if (!text) throw new AppError('source_mapping_required', 400);
    const title = sanitizeText(parsed.text.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || 'Source document', 200);
    return { documents: [{ id: `${connection.id}:${digest(url)}`, connectionId: connection.id, url, title, text, fetchedAt }] };
  }
  let rows = parsed.format === 'csv' ? parsed.data.items : parsed.data;
  if (recipe.itemsPath) for (const key of recipe.itemsPath.split('.')) rows = rows?.[key];
  if (parsed.format === 'json') {
    let envelope = parsed.data;
    const ancestors = [envelope];
    for (const key of recipe.itemsPath?.split('.') ?? []) { envelope = envelope?.[key]; ancestors.push(envelope); }
    for (const envelope of ancestors.filter(plain)) {
      const partial = ['next', 'nextPage', 'next_page', 'nextPageToken', 'continuation', 'has_more', 'hasMore', 'partial', 'truncated', 'pagination'].some(key => !!envelope[key]);
      const total = envelope.total ?? envelope.total_count ?? envelope.totalCount;
      if (partial || envelope.complete === false || (typeof total === 'number' && total > (rows?.length ?? 0))) throw new AppError('source_mapping_required', 400);
    }
  }
  if (!Array.isArray(rows) || rows.length > 1000) throw new AppError('source_mapping_required', 400);
  const seen = new Set();
  const items = rows.map(row => {
    if (!plain(row)) throw new AppError('source_mapping_required', 400);
    const externalId = row[recipe.fields.id];
    const title = row[recipe.fields.title];
    if (!['string', 'number'].includes(typeof externalId) || !String(externalId) || String(externalId).length > 200 || typeof title !== 'string' || !title.trim()) throw new AppError('source_mapping_required', 400);
    const item = { id: `${connection.id}:${digest(String(externalId))}`, externalId: String(externalId), title: sanitizeText(title, 500), connectionId: connection.id, sourceUrl: url, url, fetchedAt };
    if (seen.has(item.id)) throw new AppError('source_mapping_required', 400);
    seen.add(item.id);
    for (const [field, sourceKey] of Object.entries(recipe.fields)) {
      if (['id', 'title'].includes(field)) continue;
      const value = row[sourceKey];
      if (value === undefined || value === null || value === '') { if (['startsAt', 'dueAt'].includes(field)) throw new AppError('source_mapping_required', 400); continue; }
      if (field === 'url') {
        const link = validateSourceUrl(new URL(String(value), url).href);
        if (link.origin !== new URL(url).origin) throw new AppError('source_mapping_required', 400);
        item.url = link.href;
      } else if (['startsAt', 'endsAt', 'dueAt'].includes(field)) {
        if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) throw new AppError('source_mapping_required', 400);
        const [year, month, day] = value.slice(0, 10).split('-').map(Number);
        if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) throw new AppError('source_mapping_required', 400);
        item[field] = new Date(value).toISOString();
      } else if (typeof value === 'string' || typeof value === 'number') item[field] = sanitizeText(value, 1000);
      else throw new AppError('source_mapping_required', 400);
    }
    return item;
  });
  return { kind: recipe.kind, items };
}

export function inferPublicRecipe(parsed) {
  if (!['json', 'csv'].includes(parsed.format)) return null;
  let rows = parsed.format === 'csv' ? parsed.data.items : parsed.data;
  let itemsPath;
  let kind;
  if (!Array.isArray(rows)) {
    if (!plain(rows)) return null;
    const candidates = ['courses', 'schedule', 'events', 'deadlines'].filter(key => Array.isArray(rows[key]));
    if (candidates.length !== 1) return null;
    [itemsPath] = candidates;
    kind = itemsPath === 'events' ? 'schedule' : itemsPath;
    rows = rows[itemsPath];
  }
  if (!rows.length || !plain(rows[0])) return null;
  const keys = Object.keys(rows[0]);
  const pick = choices => { const found = choices.filter(key => keys.includes(key)); return found.length === 1 ? found[0] : null; };
  const id = pick(['id']); const title = pick(['title', 'name', 'fullname']);
  const startsAt = pick(['startsAt', 'start', 'startTime']); const dueAt = pick(['dueAt', 'due', 'duedate']);
  if (!id || !title || (startsAt && dueAt)) return null;
  kind ??= startsAt ? 'schedule' : dueAt ? 'deadlines' : null;
  if (!kind || (kind === 'schedule' && !startsAt) || (kind === 'deadlines' && !dueAt)) return null;
  const fields = { id, title };
  if (startsAt) fields.startsAt = startsAt;
  if (dueAt) fields.dueAt = dueAt;
  for (const [field, choices] of [['endsAt', ['endsAt', 'end', 'endTime']], ['location', ['location', 'room']], ['url', ['url', 'link']]]) {
    const key = pick(choices); if (key) fields[field] = key;
  }
  return validateRecipe({ version: 1, format: parsed.format, path: '$source', kind, ...(itemsPath ? { itemsPath } : {}), fields });
}

export function redactSecrets(value, secrets) {
  if (typeof value === 'string') return secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), value);
  if (Array.isArray(value)) return value.map(item => redactSecrets(item, secrets));
  if (plain(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactSecrets(child, secrets)]));
  return value;
}
