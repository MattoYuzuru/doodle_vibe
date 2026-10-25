// Known universities are data, not code branches. A preset only names an origin,
// the executor type and which credential forms are worth offering. It carries no
// user value and grants no access: the executors still apply every network guard.
export const AUTH_METHODS = Object.freeze({
  moodle_token: { type: 'token', label: 'Токен Moodle', fields: ['token'] },
  moodle_password: { type: 'password', label: 'Логин и пароль Moodle', fields: ['username', 'password'] },
  calendar_url: { type: 'calendar_url', label: 'Ссылка экспорта календаря (iCal)', fields: ['calendarUrl'] },
  ruz_identifier: { type: 'identifier', label: 'Почта, ФИО или номер студента в РУЗ', fields: ['identifier'] },
});

export const SOURCE_TYPES = Object.freeze(['moodle', 'ical', 'ruz']);

// Default credential forms for a positively identified installation of a type.
// Order is the order the UI should offer them.
const DEFAULT_AUTH = Object.freeze({
  moodle: [{ id: 'moodle_password' }, { id: 'moodle_token' }, { id: 'calendar_url', note: 'moodle_calendar_export' }],
  ical: [],
  ruz: [{ id: 'ruz_identifier' }],
});

export const UNIVERSITY_PRESETS = Object.freeze([
  { id: 'misis', name: 'МИСИС', timeZone: 'Europe/Moscow', sources: [
    { origin: 'https://newlms.misis.ru', type: 'moodle', label: 'LMS МИСИС (Moodle)' },
  ] },
  { id: 'hse', name: 'НИУ ВШЭ', timeZone: 'Europe/Moscow', sources: [
    // Smart LMS is Moodle behind SSO: the web-service token form only works for
    // local accounts, so the self-service calendar export is offered first.
    { origin: 'https://edu.hse.ru', type: 'moodle', label: 'Smart LMS ВШЭ (edu.hse.ru)',
      auth: [{ id: 'calendar_url', note: 'moodle_calendar_export' }, { id: 'moodle_token' }, { id: 'moodle_password', note: 'local_accounts_only' }],
      notes: ['sso_login_only'] },
    // RUZ answers only inside the university network (HSE.Student Wi-Fi or VPN).
    { origin: 'https://ruz.hse.ru', type: 'ruz', label: 'РУЗ ВШЭ (расписание)', notes: ['university_network_only'] },
  ] },
]);

export function presetForOrigin(origin) {
  for (const university of UNIVERSITY_PRESETS) {
    const source = university.sources.find(item => item.origin === origin);
    if (source) return { university, source };
  }
  return null;
}

export function timeZoneForOrigin(origin) {
  return presetForOrigin(origin)?.university.timeZone;
}

// Public description of how a connection can be authorised. Codes in `note` are
// stable identifiers; the UI owns the wording.
export function describeAuthMethods(origin, recipe) {
  const preset = presetForOrigin(origin)?.source;
  const type = preset?.type ?? recipe?.type;
  const entries = preset?.auth ?? DEFAULT_AUTH[type] ?? [];
  return entries.map(({ id, note }) => ({ id, ...AUTH_METHODS[id], fields: [...AUTH_METHODS[id].fields], sourceType: type,
    ...(note ? { note } : {}), ...(preset?.notes ? { notes: [...preset.notes] } : {}) }));
}

// The same view for HTTP and the local live check: preset first, then the stored adapter.
export function authMethodsFor(store, connection) {
  const origin = new URL(connection.sourceUrl).origin;
  const adapter = connection.adapterId ? store.getAdapter(connection.adapterId) : store.findAdapter(origin);
  return describeAuthMethods(origin, adapter?.recipe);
}
