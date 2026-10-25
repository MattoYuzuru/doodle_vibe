// Reviewed seed recipes for origins whose read-only API was studied by hand (data, never code). A seed is installed as
// learned revision 1 on first use (`ensureSeedRecipe`) and shared by every student of the origin; it holds no personal value.
// Source: docs/research/cu-hse-auth-endpoints.md (2026-10-25, schema only). NOT verified against a live account:
// the owner confirms them with a real login (ЦУ: GET endpoints observed in the owner's session; ВШЭ Moodle AJAX: from Moodle 4.x sources).
// Not covered (gaps G1-G3, G6, G7 of the research): per-course walks, ЦУ `timetables` (weekly recurrence rule), `url` templates, ЕЛК `lk.hse.ru` (schema unknown).
// `requireKinds` is only `courses`: a student may have no deadlines, and the canary must not fail on that.
const field = (path, transform) => ({ path, ...(transform ? { transform } : {}) });

export const SEED_RECIPES = Object.freeze({
  'https://my.centraluniversity.ru': Object.freeze({
    version: 2, type: 'learned', origin: 'https://my.centraluniversity.ru',
    auth: { type: 'cookie' },
    endpoints: [
      { id: 'courses', kind: 'courses',
        request: { method: 'GET', path: '/api/micro-lms/courses/student', query: { limit: '100', state: 'published' } },
        response: { itemsPath: '/items', fields: { id: field('/id'), title: field('/name'), description: field('/category') } },
        pagination: { type: 'offset', param: 'offset', limit: 100, maxPages: 3 } },
      { id: 'deadlines', kind: 'deadlines',
        request: { method: 'GET', path: '/api/micro-lms/deadlines' },
        response: { itemsPath: '', fields: { id: field('/id'), title: field('/exercise/name'), dueAt: field('/deadline', 'iso'), courseId: field('/course/id'), description: field('/course/name') } } },
    ],
    validation: { requireKinds: ['courses'], minItems: 1 },
  }),
  'https://edu.hse.ru': Object.freeze({
    version: 2, type: 'learned', origin: 'https://edu.hse.ru',
    auth: { type: 'cookie' },
    // The Moodle `sesskey` is read from the page configuration of /my/ and lives in memory for one sync only.
    bootstrap: [{ id: 'home', method: 'GET', path: '/my/', extract: { sesskey: '@moodle:sesskey' } }],
    endpoints: [
      { id: 'courses', kind: 'courses',
        request: { method: 'POST', path: '/lib/ajax/service.php',
          query: { sesskey: '{sesskey}', info: 'core_course_get_enrolled_courses_by_timeline_classification' },
          body: [{ index: 0, methodname: 'core_course_get_enrolled_courses_by_timeline_classification', args: { classification: 'all', limit: 100, offset: 0, sort: 'fullname' } }] },
        response: { itemsPath: '/0/data/courses', fields: { id: field('/id'), title: field('/fullname'), url: field('/viewurl') } } },
      { id: 'deadlines', kind: 'deadlines',
        request: { method: 'POST', path: '/lib/ajax/service.php',
          query: { sesskey: '{sesskey}', info: 'core_calendar_get_action_events_by_timesort' },
          body: [{ index: 0, methodname: 'core_calendar_get_action_events_by_timesort', args: { timesortfrom: '{nowUnix}', timesortto: '{plusDaysUnix:56}', limitnum: 50, limittononsuspendedevents: true } }] },
        response: { itemsPath: '/0/data/events', fields: { id: field('/id'), title: field('/name'), dueAt: field('/timesort', 'unixSeconds'), courseId: field('/course/id'), url: field('/url'), description: field('/course/fullname') } } },
    ],
    validation: { requireKinds: ['courses'], minItems: 1 },
  }),
});
