import { AppError } from '../errors.mjs';
import { parseResponse, sanitizeText, digest } from './recipes.mjs';

export const RUZ_CAPABILITIES = ['schedule'];
const DAY = 86_400_000;
const MOSCOW_OFFSET = 3 * 3600_000;
const BACK_DAYS = 7;
const FORWARD_DAYS = 56;
const MAX_LESSONS = 1000;
const invalid = () => { throw new AppError('source_response_invalid', 502); };
const normalize = value => String(value ?? '').toLowerCase().replaceAll('ё', 'е').replace(/\s+/g, ' ').trim();
// RUZ publishes Moscow wall-clock time; Russia has no DST, so +03:00 is exact.
const ruzDate = (ms, days) => new Date(ms + MOSCOW_OFFSET + days * DAY).toISOString().slice(0, 10).replaceAll('-', '.');

async function readJson(request, url, origin) {
  const response = await request(url);
  // Outside the university network RUZ redirects to an HTML stub on www.hse.ru.
  const final = response?.url ? new URL(response.url).origin : origin;
  const parsed = parseResponse(response);
  if (final !== origin || parsed.format !== 'json') throw new AppError('source_network_restricted', 403);
  return parsed.data;
}

async function resolveStudent({ request, origin, identifier }) {
  if (/^\d{1,12}$/.test(identifier)) return identifier;
  const found = await readJson(request, `${origin}/api/search?term=${encodeURIComponent(identifier)}&type=student`, origin);
  if (!Array.isArray(found)) invalid();
  const candidates = found.filter(row => row && typeof row === 'object' && /^\d{1,12}$/.test(String(row.id)) && (row.type === undefined || row.type === 'student'));
  if (!candidates.length) throw new AppError('source_identifier_not_found', 409);
  const wanted = normalize(identifier);
  // A person is never guessed: either exactly one candidate or exactly one exact match.
  const exact = candidates.filter(row => [row.label, row.description].some(value => normalize(value) === wanted || (wanted.includes('@') && normalize(value).includes(wanted))));
  if (candidates.length === 1) return String(candidates[0].id);
  if (exact.length === 1) return String(exact[0].id);
  throw new AppError('source_identifier_ambiguous', 409);
}

export async function syncRuz({ store, request, userId, connection, fetchedAt, now }) {
  const origin = new URL(connection.sourceUrl).origin;
  const secret = store.readSecret(userId, connection.id);
  if (!secret || secret.origin !== origin || typeof secret.identifier !== 'string' || !secret.identifier.trim()) throw new AppError('source_auth_required', 401);
  let studentId = typeof secret.studentId === 'string' && /^\d{1,12}$/.test(secret.studentId) ? secret.studentId : null;
  if (!studentId) {
    studentId = await resolveStudent({ request, origin, identifier: secret.identifier.trim() });
    // The resolved id lives next to the identifier in encrypted storage only.
    store.setSecret(userId, connection.id, { ...secret, studentId });
  }
  const query = new URLSearchParams({ start: ruzDate(now, -BACK_DAYS), finish: ruzDate(now, FORWARD_DAYS), lng: '1' });
  const lessons = await readJson(request, `${origin}/api/schedule/student/${studentId}?${query}`, origin);
  if (!Array.isArray(lessons) || lessons.length > MAX_LESSONS) invalid();
  const seen = new Set(); const items = [];
  for (const row of lessons) {
    if (!row || typeof row !== 'object' || typeof row.discipline !== 'string' || !row.discipline.trim()) invalid();
    const date = /^(\d{4})[.-](\d\d)[.-](\d\d)$/.exec(String(row.date)); const begin = /^(\d{1,2}):(\d\d)$/.exec(String(row.beginLesson)); const end = /^(\d{1,2}):(\d\d)$/.exec(String(row.endLesson));
    if (!date || !begin || !end) invalid();
    const at = time => `${date[1]}-${date[2]}-${date[3]}T${time[1].padStart(2, '0')}:${time[2]}:00+03:00`;
    const startsAt = new Date(at(begin)); const endsAt = new Date(at(end));
    if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime()) || endsAt < startsAt) invalid();
    const key = row.lessonOid !== undefined && row.lessonOid !== null && String(row.lessonOid) ? `oid:${row.lessonOid}` : `lesson:${row.date}|${row.beginLesson}|${row.discipline}|${row.auditorium ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const item = { id: `${connection.id}:${digest(key)}`, externalId: digest(key), connectionId: connection.id, title: sanitizeText(row.discipline, 500),
      url: `${origin}/`, sourceUrl: connection.sourceUrl, fetchedAt, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
    const location = sanitizeText([row.auditorium, row.building].filter(value => typeof value === 'string' && value.trim()).join(', '), 500);
    if (location) item.location = location;
    const description = sanitizeText([row.kindOfWork, row.lecturer].filter(value => typeof value === 'string' && value.trim()).join(' · '), 1000);
    if (description) item.description = description;
    items.push(item);
  }
  store.putSnapshot(userId, connection.id, { kind: 'schedule', items, fetchedAt, complete: true });
  return { status: 'ready', capabilities: [...RUZ_CAPABILITIES], counts: { schedule: items.length } };
}
