import { AppError } from '../errors.mjs';
import { validateSourceUrl } from './network.mjs';
import { digest, sanitizeText, parseResponse } from './recipes.mjs';
import { timeZoneForOrigin } from './presets.mjs';

const DAY = 86_400_000;
const MAX_LINES = 20_000;
const MAX_EVENTS = 1000;
const PAST_WINDOW = 30 * DAY;
const FUTURE_WINDOW = 400 * DAY;
const weekdays = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const invalid = () => { throw new AppError('source_response_invalid', 502); };
const unsupported = () => { throw new AppError('source_format_unsupported', 400); };

const formatters = new Map();
function offsetMs(timestamp, timeZone) {
  let format = formatters.get(timeZone);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    } catch { unsupported(); }
    formatters.set(timeZone, format);
  }
  const part = Object.fromEntries(format.formatToParts(timestamp).map(({ type, value }) => [type, Number(value)]));
  return Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second) - Math.floor(timestamp / 1000) * 1000;
}
// Wall-clock fields in a named zone to an absolute instant (two passes cover DST edges).
function zonedToUtc([year, month, day, hour, minute, second], timeZone) {
  if (timeZone === 'UTC') return Date.UTC(year, month - 1, day, hour, minute, second);
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = wall - offsetMs(wall, timeZone);
  guess = wall - offsetMs(guess, timeZone);
  return guess;
}

function parseDate(value, params, defaultZone) {
  const match = /^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)(Z?))?$/.exec(value.trim());
  if (!match) invalid();
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(part => (part === undefined ? 0 : Number(part)));
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate() || hour > 23 || minute > 59 || second > 60) invalid();
  const allDay = match[4] === undefined;
  const utc = match[7] === 'Z';
  const zone = utc ? 'UTC' : (params.TZID || defaultZone);
  return { ms: zonedToUtc([year, month, day, hour, minute, Math.min(second, 59)], zone), zone, allDay, fields: [year, month, day, hour, minute, second] };
}

function parseDuration(value) {
  const match = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!match) invalid();
  const [, sign, weeks = 0, days = 0, hours = 0, minutes = 0, seconds = 0] = match;
  const total = ((Number(weeks) * 7 + Number(days)) * 24 * 3600 + Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)) * 1000;
  return sign === '-' ? -total : total;
}

const unescapeText = value => value.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));

function parseLines(text) {
  const unfolded = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  if (unfolded.length > MAX_LINES) throw new AppError('source_too_large', 400);
  const events = []; const stack = []; let calendarZone;
  for (const line of unfolded) {
    if (!line) continue;
    const match = /^([A-Za-z0-9-]+)((?:;[A-Za-z0-9-]+=(?:"[^"]*"|[^;:"]*))*):(.*)$/.exec(line);
    if (!match) continue;
    const name = match[1].toUpperCase(); const value = match[3];
    const params = Object.fromEntries([...match[2].matchAll(/;([A-Za-z0-9-]+)=("[^"]*"|[^;:"]*)/g)].map(([, key, val]) => [key.toUpperCase(), val.replace(/^"|"$/g, '')]));
    if (name === 'BEGIN') { stack.push({ type: value.toUpperCase(), props: [] }); continue; }
    if (name === 'END') {
      const done = stack.pop();
      if (!done || done.type !== value.toUpperCase()) invalid();
      if (done.type === 'VEVENT') events.push(done.props);
      continue;
    }
    if (name === 'X-WR-TIMEZONE' && !stack.some(item => item.type === 'VEVENT')) calendarZone = value.trim();
    const top = stack.at(-1);
    if (top?.type === 'VEVENT') top.props.push({ name, params, value });
  }
  if (stack.length) invalid();
  return { events, calendarZone };
}

function parseRule(value) {
  const rule = Object.fromEntries(value.split(';').map(part => part.split('=')));
  const allowed = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'WKST']);
  if (Object.keys(rule).some(key => !allowed.has(key)) || !['DAILY', 'WEEKLY'].includes(rule.FREQ)) unsupported();
  const interval = rule.INTERVAL === undefined ? 1 : Number(rule.INTERVAL);
  const count = rule.COUNT === undefined ? Infinity : Number(rule.COUNT);
  if (!Number.isInteger(interval) || interval < 1 || interval > 52 || (rule.COUNT !== undefined && (!Number.isInteger(count) || count < 1))) invalid();
  let days = null;
  if (rule.BYDAY !== undefined) {
    days = rule.BYDAY.split(',').map(code => weekdays.indexOf(code));
    if (rule.FREQ !== 'WEEKLY' || days.some(day => day < 0)) unsupported();
  }
  return { freq: rule.FREQ, interval, count, until: rule.UNTIL, days };
}

function occurrences(start, rule, horizon, exclusions) {
  const out = []; let produced = 0;
  const [year, month, day, hour, minute, second] = start.fields;
  const at = offset => zonedToUtc([year, month, day + offset, hour, minute, Math.min(second, 59)], start.zone);
  const startDay = Date.UTC(year, month - 1, day);
  const startWeekday = new Date(startDay).getUTCDay();
  const until = rule.until === undefined ? Infinity : parseDate(rule.until, {}, start.zone).ms;
  const push = offset => {
    const ms = at(offset);
    if (ms > horizon || ms > until) return false;
    if (ms < start.ms) return true;
    produced++;
    if (!exclusions.has(ms)) out.push(ms);
    return produced < rule.count;
  };
  if (rule.freq === 'DAILY') {
    for (let step = 0, i = 0; i < 5000; i++, step += rule.interval) if (!push(step)) break;
  } else {
    const days = (rule.days ?? [startWeekday]).slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    const mondayOffset = -((startWeekday + 6) % 7);
    outer: for (let week = 0; week < 1000; week++) {
      for (const weekday of days) {
        const offset = mondayOffset + week * rule.interval * 7 + ((weekday + 6) % 7);
        if (offset < 0) continue;
        if (!push(offset)) break outer;
      }
    }
  }
  return out;
}

export function parseIcal(text, { timeZone = 'UTC', now }) {
  const { events: raw, calendarZone } = parseLines(text);
  const defaultZone = calendarZone || timeZone;
  const horizon = now + FUTURE_WINDOW; const floor = now - PAST_WINDOW;
  const overridden = new Set(); const parsed = [];
  for (const props of raw) {
    const first = name => props.find(prop => prop.name === name);
    const startProp = first('DTSTART'); const summary = first('SUMMARY');
    if (first('STATUS')?.value.trim().toUpperCase() === 'CANCELLED') continue;
    if (!startProp || !summary || !unescapeText(summary.value).trim()) invalid();
    const start = parseDate(startProp.value, startProp.params, defaultZone);
    let length = 0;
    const endProp = first('DTEND') ?? first('DUE'); const durationProp = first('DURATION');
    if (endProp) length = parseDate(endProp.value, endProp.params, defaultZone).ms - start.ms;
    else if (durationProp) length = parseDuration(durationProp.value);
    else if (start.allDay) length = DAY;
    if (!Number.isFinite(length) || length < 0) invalid();
    const uid = first('UID')?.value.trim() || `${unescapeText(summary.value)}@${start.ms}`;
    const recurrenceId = first('RECURRENCE-ID');
    if (recurrenceId) overridden.add(`${uid}|${parseDate(recurrenceId.value, recurrenceId.params, defaultZone).ms}`);
    const categories = props.filter(prop => prop.name === 'CATEGORIES').flatMap(prop => prop.value.split(',')).map(item => unescapeText(item).trim()).filter(Boolean);
    parsed.push({ uid, start, length, summary: unescapeText(summary.value), location: unescapeText(first('LOCATION')?.value ?? ''),
      description: unescapeText(first('DESCRIPTION')?.value ?? ''), url: first('URL')?.value.trim() ?? '', categories,
      rule: first('RRULE') ? parseRule(first('RRULE').value) : null,
      exclusions: new Set(props.filter(prop => prop.name === 'EXDATE').flatMap(prop => prop.value.split(',').map(value => parseDate(value, prop.params, defaultZone).ms))) });
  }
  const out = []; const seen = new Set();
  for (const event of parsed) {
    const starts = event.rule ? occurrences(event.start, event.rule, horizon, event.exclusions).filter(ms => !overridden.has(`${event.uid}|${ms}`)) : [event.start.ms];
    for (const startMs of starts) {
      const endMs = startMs + event.length;
      if (endMs < floor || startMs > horizon) continue;
      const key = `${event.uid}|${startMs}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (out.length >= MAX_EVENTS) throw new AppError('source_mapping_required', 400);
      out.push({ key, ...event, startMs, endMs, timed: event.length > 0 });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs || (a.key < b.key ? -1 : 1));
}

// `mode: 'moodle'` follows the Moodle calendar export: an event without duration is
// a due date (assignment, quiz close), an event with duration is a timetable entry.
export function icalSnapshots(events, { mode, connection, fetchedAt, fallbackUrl, redact = text => text }) {
  const origin = new URL(fallbackUrl).origin;
  const clean = (value, limit) => sanitizeText(redact(String(value)), limit);
  const result = { schedule: [], deadlines: [], courses: [] };
  const courseIds = new Map();
  if (mode === 'moodle') {
    for (const category of new Set(events.flatMap(event => event.categories))) {
      const id = `${connection.id}:${digest(`course:${category}`)}`;
      courseIds.set(category, id);
      result.courses.push({ id, externalId: category, connectionId: connection.id, title: clean(category, 500), url: fallbackUrl, sourceUrl: connection.sourceUrl, fetchedAt });
    }
  }
  for (const event of events) {
    let url = fallbackUrl;
    if (event.url) {
      try { const link = validateSourceUrl(event.url); if (link.origin === origin) url = link.href; } catch { /* Foreign or unsafe links are dropped. */ }
    }
    const base = { id: `${connection.id}:${digest(`event:${event.key}`)}`, externalId: digest(event.key), connectionId: connection.id,
      title: clean(event.summary, 500), url, sourceUrl: connection.sourceUrl, fetchedAt };
    const course = courseIds.get(event.categories[0]);
    if (course) base.courseId = course;
    if (mode === 'moodle' && !event.timed) {
      result.deadlines.push({ ...base, dueAt: new Date(event.startMs).toISOString() });
      continue;
    }
    const item = { ...base, startsAt: new Date(event.startMs).toISOString() };
    if (event.timed) item.endsAt = new Date(event.endMs).toISOString();
    const location = clean(event.location, 500); if (location) item.location = location;
    const description = clean(event.description, 1000); if (description) item.description = description;
    result.schedule.push(item);
  }
  return result;
}

// Reads one calendar feed and stores complete snapshots. `secret` marks a feed URL
// held in encrypted storage (it carries its own token): it is fetched without
// redirects, bound to the connection origin and scrubbed from every stored field.
export async function syncCalendar({ store, request, userId, connection, fetchedAt, now, mode, target, secret = false, fallbackUrl, response: given }) {
  const origin = new URL(connection.sourceUrl).origin;
  const response = given ?? await request(target, secret ? { secretUrl: true, boundOrigin: origin } : undefined);
  const parsed = parseResponse(response);
  // A private feed that answers with a page is an expired or revoked link.
  if (parsed.format !== 'ical') throw new AppError(secret ? 'source_auth_required' : 'source_format_changed', secret ? 401 : 400);
  const events = parseIcal(parsed.text, { timeZone: timeZoneForOrigin(origin), now });
  const hidden = secret ? [target, ...[...new URL(target).searchParams.values()].filter(value => value.length >= 6)] : [];
  const redact = text => hidden.reduce((value, item) => value.split(item).join('[redacted]'), text);
  const snapshots = icalSnapshots(events, { mode, connection, fetchedAt, fallbackUrl, redact });
  const kinds = mode === 'moodle' ? ['courses', 'deadlines', 'schedule'] : ['schedule'];
  for (const kind of kinds) store.putSnapshot(userId, connection.id, { kind, items: snapshots[kind], fetchedAt, complete: true });
  return { status: 'ready', capabilities: kinds, counts: Object.fromEntries(kinds.map(kind => [kind, snapshots[kind].length])) };
}
