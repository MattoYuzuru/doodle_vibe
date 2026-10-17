// Чтение Moodle от имени пользователя (по его токену): активные курсы, задания и тесты со статусами и оценками,
// группы пользователя в курсах (для автоопределения группы расписания). Кэш по токену на 5 минут.
import { createHash } from "node:crypto";
// FormData — из того же undici, чей fetch использует mfetch: встроенный класс Node этот fetch не распознал бы.
import { FormData } from "undici";
import { BASE, mfetch, netHealth, retry } from "./users.mjs";

const CACHE_MS = 5 * 60 * 1000;
const LOOKBACK_S = 14 * 86400; // показываем и недавно прошедшие сроки
const LOOKBACK_DONE_S = 60 * 86400; // сданные работы держим дольше: оценка и замечания преподавателя приходят спустя недели
// Задания старше LOOKBACK_S, которые всё равно показываем (проверочный запуск): id через запятую в PIN_ASSIGNS.
const PINNED = new Set((process.env.PIN_ASSIGNS || "28995").split(",").map((s) => Number(s.trim())).filter(Boolean));

// «Ответил не данными» (страница техработ, ошибка прокси): сеть жива, а Moodle не работает — второй признак сбоя для health().
let badDataAt = 0, badDataSince = 0, goodDataAt = 0;
// Повторы сетевых сбоев — общий retry() из users.mjs (там же причина: мёртвые пути до сети МИСИС).
export async function call(token, fn, params = {}) {
  const body = new URLSearchParams({ wstoken: token, wsfunction: fn, moodlewsrestformat: "json", ...params });
  return retry(async () => {
    const res = await mfetch(`${BASE}/webservice/rest/server.php`, { method: "POST", body, signal: AbortSignal.timeout(25000) });
    // Не JSON (страница техработ, ошибка прокси) — внятная ошибка вместо «Unexpected token <».
    const data = await res.json().catch(() => {
      if (badDataAt <= goodDataAt) badDataSince = Date.now();
      badDataAt = Date.now();
      throw new Error(`Moodle ответил не данными (HTTP ${res.status}) — возможно, техработы`);
    });
    goodDataAt = Date.now();
    if (data && data.exception) throw new Error(`${data.errorcode}: ${data.message}`);
    return data;
  });
}

/**
 * Работает ли сейчас Moodle (для плашки в приложении): down, с какого времени (since), причина — network (сеть МИСИС
 * не отвечает, см. netHealth в users.mjs) или maintenance (отвечает не данными: техработы), okAt — последний нормальный ответ.
 */
const MOODLE_HOST = new URL(BASE).hostname;
export function health() {
  const n = netHealth(MOODLE_HOST);
  if (n.down) return { down: true, since: n.since, reason: "network", okAt: n.okAt };
  if (badDataAt > goodDataAt && Date.now() - badDataAt < 5 * 60e3) return { down: true, since: badDataSince, reason: "maintenance", okAt: goodDataAt || null };
  return { down: false, since: null, reason: null, okAt: Math.max(n.okAt || 0, goodDataAt) || null };
}
/** Ошибка — это сбой Moodle или сети МИСИС (а не отказ самого Moodle: неверный токен, нет доступа)? */
export const isOutage = (e) => /Moodle не отвечает|Moodle ответил не данными/.test(String(e?.message || e));

// «Оптимизация клиент-серверных приложений. Осень 2026» → «Оптимизация клиент-серверных приложений»
const cleanCourse = (name) => name.replace(/\.\s.*$/, "").replace(/\s+(Весна|Осень)\s+\d{4}.*$/, "").trim();
// Короткое имя для строк списка: до 16 символов как есть, иначе инициалы значимых слов.
function shortName(name) {
  if (name.length <= 16) return name;
  const words = name.split(/\s+/).filter((w) => w.length > 2 && !/^(и|на|по|для|в|из)$/i.test(w));
  return words.slice(0, 4).map((w) => w[0].toUpperCase()).join("") || name.slice(0, 16);
}
// Тип работы по названию задания.
function kindOf(name) {
  if (/курсов/i.test(name)) return "coursework";
  if (/зач[её]т|экзамен/i.test(name)) return "exam";
  if (/реферат|проект|эссе|доклад|контрольн/i.test(name)) return "other";
  return "lab";
}

/*
 * Актуальные курсы. У МИСИС семестр обычно есть в названии («… Осень 2026», «Математика ИТКН/Весна 2026/…»): такие
 * берём только за текущий семестр (январь относим к осеннему — сессия). Без семестра в названии решаем по данным Moodle:
 * скрытый пользователем — нет; завершённый (enddate в прошлом) — нет; начатый больше 400 дней назад — нет; иначе —
 * если заходили за последние 120 дней или курс начался в последние 60 дней. Поверх автоматики — ручной выбор
 * пользователя в приложении (Профиль → Курсы), он хранится в users/<id>.json и подаётся сюда через setOverrides.
 */
const SEM_RE = /(Осень|Весна)\s*(\d{4})/i;
const cap = (w) => w[0].toUpperCase() + w.slice(1).toLowerCase();
export function currentSemester(now = new Date()) {
  const m = now.getMonth(), y = now.getFullYear();
  return m === 0 ? `Осень ${y - 1}` : m <= 6 ? `Весна ${y}` : `Осень ${y}`;
}
export function courseAuto(c, now = Date.now()) {
  const sem = c.fullname.match(SEM_RE);
  if (sem) { const s = `${cap(sem[1])} ${sem[2]}`; return { auto: s === currentSemester(new Date(now)), reason: s }; }
  if (c.hidden) return { auto: false, reason: "скрыт в Moodle" };
  if (c.enddate && c.enddate * 1000 < now) return { auto: false, reason: "завершён" };
  if (c.startdate && now - c.startdate * 1000 > 400 * 86400e3) return { auto: false, reason: "старый" };
  const recent = (c.lastaccess || 0) * 1000 > now - 120 * 86400e3 || (c.startdate || 0) * 1000 > now - 60 * 86400e3;
  return { auto: recent, reason: recent ? "недавний" : "давно не открывали" };
}
const overridesByToken = new Map(); // token → { key, o: { [courseId]: true|false } }
export function setOverrides(token, o) {
  const key = JSON.stringify(o || {});
  if (overridesByToken.get(token)?.key === key) return;
  overridesByToken.set(token, { key, o: o || {} });
  cache.delete(token); courseCache.delete(token); // список курсов изменился — кэши по токену устарели
}
/** Начало текущего семестра, с: осень — 1 августа (январь относится к ней же), весна — 15 января. */
export function semesterStart(now = new Date()) {
  const m = now.getMonth(), y = now.getFullYear();
  return (m === 0 ? Date.UTC(y - 1, 7, 1) : m <= 6 ? Date.UTC(y, 0, 15) : Date.UTC(y, 7, 1)) / 1000;
}
/**
 * Курсы «под вопросом»: по названию или датам курс прошлый, но в нём появилась работа этого семестра со сроком впереди
 * (ОС: курс «… Весна 2026», а ЛР01 открыта 28.09.2026 со сроком 05.10). Сам по себе это НЕ признак актуальности: та ЛР01
 * лежит в разделе «Должникам» и нужна только пересдающим. Поэтому такой курс не включается автоматически — приложение
 * спрашивает пользователя (сообщение бота + блок «Уточните» в «Курсах»), а ответ хранится как ручной выбор курса.
 * Признак работы: срок впереди и она открыта или изменена в текущем семестре; старые тесты, оставленные открытыми
 * с прошлого семестра (БЖД: открыты 29.01, закрытие 22.11), не считаются. Смотрим только недавние курсы (начались за
 * последние 400 дней или открывались за год); результат кэшируется на 30 минут по токену.
 */
const candidateCache = new Map(); // token → { at, map: Map<courseId, { title, due, cmid, section }> }
export function isLiveWork(x, nowS, startS) {
  if ("timeclose" in x) return x.timeclose > nowS && (x.timeopen || 0) >= startS; // тест
  return x.duedate > nowS && Math.max(x.allowsubmissionsfromdate || 0, x.timemodified || 0) >= startS; // задание
}
async function candidates(token, all) {
  const c = candidateCache.get(token);
  const now = Date.now();
  if (c && now - c.at < 30 * 60e3) return c.map;
  const cand = all.filter((x) => !courseAuto(x, now).auto && ((x.startdate || 0) * 1000 > now - 400 * 86400e3 || (x.lastaccess || 0) * 1000 > now - 365 * 86400e3));
  const map = new Map();
  if (cand.length) {
    const p = {};
    cand.forEach((x, i) => (p[`courseids[${i}]`] = x.id));
    const nowS = now / 1000, startS = semesterStart(new Date(now));
    // Ближайшая по сроку «живая» работа курса — её покажем в вопросе.
    const note = (courseId, title, due, cmid) => { const prev = map.get(courseId); if (!prev || due < prev.due) map.set(courseId, { title, due, cmid, section: null }); };
    try {
      const [assign, quiz] = await Promise.all([call(token, "mod_assign_get_assignments", p), call(token, "mod_quiz_get_quizzes_by_courses", p).catch(() => ({ quizzes: [] }))]);
      for (const cc of assign.courses || []) for (const a of cc.assignments || []) if (isLiveWork(a, nowS, startS)) note(cc.id, a.name, a.duedate * 1000, a.cmid);
      for (const q of quiz.quizzes || []) if (isLiveWork(q, nowS, startS)) note(q.course, q.name, q.timeclose * 1000, q.coursemodule);
    } catch { return c?.map ?? map; } // Moodle не ответил: берём прошлый ответ и не кэшируем, чтобы повторить при следующем запросе
    // Раздел курса, где лежит работа («Должникам») — главная подсказка для ответа. Не получилось узнать — спросим без него.
    await Promise.all([...map].map(async ([courseId, w]) => {
      try {
        const sections = await call(token, "core_course_get_contents", { courseid: courseId });
        const s = (Array.isArray(sections) ? sections : []).find((x) => (x.modules || []).some((m) => m.id === w.cmid));
        if (s?.name) w.section = String(s.name).trim();
      } catch { /* без раздела */ }
    }));
  }
  candidateCache.set(token, { at: now, map });
  return map;
}
export async function activeCourses(token, userId) {
  const all = await call(token, "core_enrol_get_users_courses", { userid: userId });
  const o = overridesByToken.get(token)?.o || {};
  return all.filter((c) => o[c.id] ?? courseAuto(c).auto);
}
/** Курсы, про которые надо спросить пользователя: прошлые по автоматике, с новой работой, без его решения. */
export async function pendingCourses(token, userId) {
  const all = await call(token, "core_enrol_get_users_courses", { userid: userId });
  const o = overridesByToken.get(token)?.o || {};
  const cand = await candidates(token, all);
  return all.filter((c) => cand.has(c.id) && o[c.id] === undefined)
    .map((c) => ({ id: c.id, name: cleanCourse(c.fullname), fullname: c.fullname, reason: courseAuto(c).reason, ...cand.get(c.id) }));
}
/** Все курсы пользователя с решением «актуален/нет» и причиной — для экрана «Курсы» в приложении. */
export async function allCourses(token) {
  const info = await call(token, "core_webservice_get_site_info");
  const all = await call(token, "core_enrol_get_users_courses", { userid: info.userid });
  const o = overridesByToken.get(token)?.o || {};
  const cand = await candidates(token, all);
  return all.map((c) => {
    const a = courseAuto(c), override = o[c.id] ?? null, w = cand.get(c.id), pending = override === null && !a.auto && !!w;
    return {
      id: c.id, name: cleanCourse(c.fullname), fullname: c.fullname, auto: a.auto, reason: a.reason, override, active: override ?? a.auto,
      hidden: !!c.hidden, lastaccess: c.lastaccess ? c.lastaccess * 1000 : null,
      pending, pendingWork: pending ? { title: w.title, due: w.due, section: w.section } : null,
    };
  }).sort((x, y) => Number(y.pending) - Number(x.pending) || Number(y.active) - Number(x.active) || (y.lastaccess || 0) - (x.lastaccess || 0));
}

/**
 * Принимает ли задание ответ файлом и какие у него ограничения (настройки «Ответ в виде файла»): нужно кнопке
 * «Прикрепить PDF». У заданий без файлового ответа (коллоквиум, активность на лекции) файловых настроек нет вовсе.
 * pdf — подходит ли PDF под список типов (пустой список — любые; группы вроде «document» тоже пускают PDF).
 */
function uploadConfig(a) {
  const cfg = (name) => (a.configs || []).find((c) => c.plugin === "file" && c.subtype === "assignsubmission" && c.name === name)?.value;
  const types = String(cfg("filetypeslist") || "").trim();
  return {
    enabled: cfg("enabled") === "1",
    maxFiles: Number(cfg("maxfilesubmissions")) || 1,
    maxBytes: Number(cfg("maxsubmissionsizebytes")) || 0,
    types,
    pdf: !types || /(^|[\s,;])(\.?pdf|document|\*)(?=$|[\s,;])/i.test(types),
    statement: a.requiresubmissionstatement === 1,
  };
}

/** HTML из Moodle → обычный текст. */
export const stripHtml = (h = "") => String(h)
  .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>|<\/div>|<\/tr>/gi, "\n").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, "&")
  .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

/**
 * Состояние ответа студента и отзыв преподавателя из mod_assign_get_submission_status: статус, можно ли менять ответ,
 * сданные файлы, «Отзыв в виде комментария» и «Отзыв в виде файла». Адреса файлов (url) — только для сервера.
 */
export function submissionInfo(s) {
  const sub = s?.lastattempt?.submission, fb = s?.feedback;
  const filesOf = (plugins, type) => (plugins || []).filter((p) => p.type === type)
    .flatMap((p) => (p.fileareas || []).flatMap((fa) => (fa.files || []).map((f) => ({ name: f.filename, size: f.filesize || 0, url: f.fileurl }))));
  return {
    submissionId: sub?.id ?? null,
    status: sub?.status ?? "new",
    canEdit: s?.lastattempt ? s.lastattempt.canedit !== false : true,
    graded: s?.lastattempt?.gradingstatus === "graded",
    files: filesOf(sub?.plugins, "file"),
    // Текстовый ответ («Ответ в виде текста»): сохранение одного файла через веб-сервис его бы стёрло — см. attachFiles.
    onlineText: stripHtml((sub?.plugins || []).find((p) => p.type === "onlinetext")?.editorfields?.find((e) => e.name === "onlinetext")?.text || ""),
    comment: stripHtml((fb?.plugins || []).find((p) => p.type === "comments")?.editorfields?.find((e) => e.name === "comments")?.text || ""),
    commentAt: fb?.gradeddate ? fb.gradeddate * 1000 : null,
    feedbackFiles: filesOf(fb?.plugins, "file"),
  };
}
/** Лента «Комментарии к ответу» (второе место, где преподаватели пишут замечания); mine — запись самого студента. */
async function commentThread(token, cmid, submissionId, userId) {
  if (!cmid || !submissionId) return [];
  const r = await call(token, "core_comment_get_comments", { contextlevel: "module", instanceid: cmid, component: "assignsubmission_comments", itemid: submissionId, area: "submission_comments", page: 0 }).catch(() => null);
  return (r?.comments || []).map((c) => ({ author: c.fullname || null, text: stripHtml(c.content), at: c.timecreated ? c.timecreated * 1000 : null, mine: c.userid === userId })).filter((c) => c.text);
}
/**
 * Замечания преподавателя одним списком по времени: отзыв к оценке (author: null) и чужие записи в комментариях к ответу.
 * key — постоянная метка замечания: по ней видно, какое замечание новое (бот о нём ещё не писал, агенту оно ещё не
 * уходило). У отзыва к оценке метка зависит только от текста: преподаватель переписал отзыв после повторной проверки —
 * это новое замечание, а просто поменял оценку — нет. У записи в комментариях — ещё от автора и времени, чтобы два
 * одинаковых «не исправлено» в разные дни считались разными.
 */
const remarkKey = (...parts) => createHash("sha1").update(parts.join("\n").replace(/\s+/g, " ").trim()).digest("hex").slice(0, 12);
const remarksOf = (si, thread) => [
  ...(si.comment ? [{ key: remarkKey("fb", si.comment), author: null, text: si.comment, at: si.commentAt }] : []),
  ...thread.filter((c) => !c.mine).map(({ author, text, at }) => ({ key: remarkKey("c", author ?? "", at ?? 0, text), author, text, at })),
].sort((a, b) => (a.at || 0) - (b.at || 0));

async function loadDeadlines(token) {
  const info = await call(token, "core_webservice_get_site_info");
  const courses = await activeCourses(token, info.userid);
  const p = {};
  courses.forEach((c, i) => (p[`courseids[${i}]`] = c.id));
  const since = Date.now() / 1000 - LOOKBACK_S, sinceDone = Date.now() / 1000 - LOOKBACK_DONE_S;
  const [assign, quiz] = await Promise.all([
    courses.length ? call(token, "mod_assign_get_assignments", p) : { courses: [] },
    courses.length ? call(token, "mod_quiz_get_quizzes_by_courses", p).catch(() => ({ quizzes: [] })) : { quizzes: [] },
  ]);

  const items = [];
  for (const c of assign.courses) for (const a of c.assignments) {
    if (!a.duedate) continue;
    // Срок прошёл больше двух недель назад (но не больше двух месяцев): оставим, только если работа сдана (см. ниже).
    const recent = a.duedate >= since || PINNED.has(a.id);
    if (!recent && a.duedate < sinceDone) continue;
    items.push({ id: `moodle:assign:${a.id}`, kind: kindOf(a.name), title: a.name, courseId: c.id, due: a.duedate * 1000,
      url: `${BASE}/mod/assign/view.php?id=${a.cmid}`, upload: uploadConfig(a), _assign: a.id, _cmid: a.cmid, _old: !recent });
  }
  for (const q of quiz.quizzes || []) {
    if (!q.timeclose || q.timeclose < since) continue;
    items.push({ id: `moodle:quiz:${q.id}`, kind: "test", title: q.name, courseId: q.course, due: q.timeclose * 1000,
      opensAt: q.timeopen ? q.timeopen * 1000 : undefined, url: `${BASE}/mod/quiz/view.php?id=${q.coursemodule}`, _quiz: q.id });
  }
  // Статус: задание отправлено/оценено → сдано; тест с оценкой → сдано. Оценка — числом (grade) и максимумом (gradeMax).
  const gradeMax = new Map(assign.courses.flatMap((c) => c.assignments.map((a) => [a.id, a.grade > 0 ? a.grade : null])));
  // Есть ли у задания черновик (настройка «Требовать нажатия кнопки „Отправить“»). Если нет — прикреплённый файл сразу
  // считается сданным: 1 окт 2026 в курсе ОКП «прикрепить черновик» сразу отправило работу на проверку.
  const hasDrafts = new Map(assign.courses.flatMap((c) => c.assignments.map((a) => [a.id, a.submissiondrafts !== 0])));
  await Promise.all(items.map(async (x) => {
    try {
      if (x._assign) {
        const s = await call(token, "mod_assign_get_submission_status", { assignid: x._assign });
        const g = s.feedback?.grade?.grade;
        x.grade = g != null && g !== "" && Number(g) >= 0 ? Number(g) : null;
        x.gradeMax = gradeMax.get(x._assign) ?? null;
        const si = submissionInfo(s);
        x.status = si.status === "submitted" || x.grade != null ? "done" : "open";
        // Замечания преподавателя и состояние ответа — для блока «Комментарий преподавателя» и кнопки «Исправить отчёт».
        // Комментарии к ответу читаем у любой работы, где ответ уже есть (в том числе возвращённой в черновик на доработку).
        const thread = si.status !== "new" ? await commentThread(token, x._cmid, si.submissionId, info.userid) : [];
        x.remarks = remarksOf(si, thread).map((r) => ({ ...r, text: r.text.slice(0, 4000) }));
        x.submission = { status: si.status, canEdit: si.canEdit, files: si.files.map((f) => f.name), drafts: hasDrafts.get(x._assign) ?? true };
      } else {
        const g = await call(token, "mod_quiz_get_user_best_grade", { quizid: x._quiz });
        x.grade = g.hasgrade && g.grade != null ? Number(g.grade) : null;
        x.gradeMax = quiz.quizzes.find((q) => q.id === x._quiz)?.grade ?? null;
        x.status = g.hasgrade ? "done" : "open";
      }
    } catch { x.status = "open"; }
    delete x._assign; delete x._quiz; delete x._cmid;
  }));
  // Давние работы оставляем только сданные — ради оценки и замечаний; несданные старше двух недель не показываем, как и раньше.
  const kept = items.filter((x) => !x._old || x.status === "done");
  for (const x of kept) delete x._old;
  kept.sort((a, b) => a.due - b.due);
  return {
    updated: Date.now(),
    userId: info.userid,
    items: kept,
    courses: courses.map((c) => ({ id: c.id, name: cleanCourse(c.fullname), short: shortName(cleanCourse(c.fullname)) })),
    // Курсы «под вопросом» (см. candidates): приложение показывает их с просьбой уточнить, бот спрашивает один раз.
    pendingCourses: await pendingCourses(token, info.userid).catch(() => []),
  };
}

const cache = new Map(); // token → { at, data, pending }
/** Последние загруженные дедлайны, сколько бы им ни было (пока Moodle не отвечает, приложение показывает их). */
export const staleDeadlines = (token) => cache.get(token)?.data ?? null;
export async function deadlines(token, force = false) {
  const c = cache.get(token) || {};
  if (!force && c.data && Date.now() - c.at < CACHE_MS) return c.data;
  if (!c.pending) {
    c.pending = loadDeadlines(token).then((d) => { c.data = d; c.at = Date.now(); return d; }).finally(() => { c.pending = null; });
    cache.set(token, c);
  }
  return c.pending;
}

/**
 * Отзыв по одной работе свежим запросом — для экрана лабы и для «Исправить отчёт»: замечания, состояние ответа, файлы.
 * Raw-вариант содержит адреса файлов и нужен только серверу (скачать сданный отчёт и файлы отзыва в папку лабы).
 */
export async function assignFeedbackRaw(token, assignId) {
  const [d, s] = await Promise.all([deadlines(token), call(token, "mod_assign_get_submission_status", { assignid: assignId })]);
  const si = submissionInfo(s);
  const item = d.items.find((x) => x.id === `moodle:assign:${assignId}`);
  const cmid = item ? Number(new URL(item.url).searchParams.get("id")) || null : null;
  const thread = await commentThread(token, cmid, si.submissionId, d.userId);
  const g = s.feedback?.grade?.grade;
  return { ...si, drafts: item?.submission?.drafts ?? true, assignId: Number(assignId), title: item?.title ?? null, grade: g != null && g !== "" && Number(g) >= 0 ? Number(g) : null, gradeMax: item?.gradeMax ?? null, thread, remarks: remarksOf(si, thread) };
}
export async function assignFeedback(token, assignId) {
  const f = await assignFeedbackRaw(token, assignId);
  const names = (list) => list.map(({ name, size }) => ({ name, size }));
  return { assignId: f.assignId, status: f.status, canEdit: f.canEdit, drafts: f.drafts, graded: f.graded, grade: f.grade, gradeMax: f.gradeMax, remarks: f.remarks, thread: f.thread, files: names(f.files), feedbackFiles: names(f.feedbackFiles) };
}

/*
 * Запись в Moodle: загрузка файлов в черновую область и сохранение ответа, отправка на проверку. Всё идёт тем же путём,
 * что и чтение (mfetch: напрямую, мимо VPN, с повторами сетевых сбоев). Вызывается ТОЛЬКО по явному действию студента
 * в приложении (кнопка и окно подтверждения) — сервер сам ничего не прикрепляет и не отправляет.
 */
const mb = (n) => (n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} КБ` : `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0).replace(".0", "")} МБ`);
const STATUS_RU = { new: "ответа нет", draft: "черновик", submitted: "отправлено на проверку", reopened: "возвращено на доработку" };
/** Одна строка о том, что сейчас в ответе Moodle. */
export const stateLine = (s) => (s ? `Сейчас в Moodle: ${STATUS_RU[s.status] || s.status}${s.files.length ? `, файл: ${s.files.map((f) => f.name ?? f).join(", ")}` : ", файлов нет"}.` : "Состояние в Moodle узнать не удалось.");
export const submissionState = (token, assignId) => call(token, "mod_assign_get_submission_status", { assignid: assignId }).then(submissionInfo);

/** Файл ответа или отзыва (webservice/pluginfile) → Buffer, токеном того же студента. */
export async function downloadFile(url, token) {
  const full = url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
  return Buffer.from(await retry(() => mfetch(full, { signal: AbortSignal.timeout(60000) }).then((r) => { if (!r.ok) throw new Error(`файл из Moodle: HTTP ${r.status}`); return r.arrayBuffer(); })));
}

/**
 * Файлы [{ name, data }] → в одну новую черновую область Moodle (webservice/upload.php), затем ответ задания = ровно
 * эти файлы (mod_assign_save_submission). Повтор загрузки безопасен: каждая попадает в новую черновую область.
 */
export async function attachFiles(token, assignId, files) {
  const up = await retry(async () => {
    const form = new FormData();
    form.append("token", token);
    form.append("filearea", "draft");
    form.append("itemid", "0");
    files.forEach((f, i) => form.append(`file_${i + 1}`, new Blob([f.data]), f.name));
    const res = await mfetch(`${BASE}/webservice/upload.php`, { method: "POST", body: form, signal: AbortSignal.timeout(180000) });
    return res.json().catch(() => { throw new Error(`Moodle ответил не данными (HTTP ${res.status}) — возможно, техработы`); });
  });
  if (!Array.isArray(up) || !up[0]?.itemid) throw new Error(`загрузка файла не удалась: ${up?.error || up?.message || JSON.stringify(up).slice(0, 200)}`);
  const warn = await call(token, "mod_assign_save_submission", { assignmentid: assignId, "plugindata[files_filemanager]": up[0].itemid });
  if (Array.isArray(warn) && warn.length) throw new Error(`Moodle не принял файл: ${warn[0].message || warn[0].item || JSON.stringify(warn).slice(0, 200)}`);
}

/** Отправить ответ на проверку (то же, что кнопка «Отправить на проверку» в Moodle). */
export async function submitForGrading(token, assignId) {
  const w = await call(token, "mod_assign_submit_for_grading", { assignmentid: assignId, acceptsubmissionstatement: 1 });
  if (Array.isArray(w) && w.length) throw new Error(w[0].message || w[0].item || JSON.stringify(w).slice(0, 200));
}

/**
 * Кнопка «Прикрепить PDF» в карточке работы: свой файл студента → в его ответ Moodle. Проверки до загрузки: задание
 * принимает файлы и PDF, размер в пределах, Moodle разрешает менять ответ, нет текстового ответа (его бы стёрло).
 * Прежние файлы: если заданию можно несколько и место есть — остаются (перезаливаются вместе с новым), файл с тем же
 * именем заменяется; если файл один или места нет — новый встаёт вместо прежних (студента об этом предупреждает окно
 * подтверждения). Итог проверяется по самому Moodle.
 */
export async function attachOwnFile(token, assignId, file) {
  const d = await deadlines(token);
  const item = d.items.find((x) => x.id === `moodle:assign:${assignId}`);
  if (!item) throw new Error("Этой работы нет среди ваших заданий Moodle");
  const up = item.upload;
  if (!up?.enabled) throw new Error("В этом задании Moodle не принимает ответ файлом — сдайте его на сайте Moodle");
  if (!up.pdf) throw new Error(`В этом задании PDF не принимается (разрешено: ${up.types})`);
  if (up.maxBytes && file.data.length > up.maxBytes) throw new Error(`Файл ${mb(file.data.length)}, а в этом задании можно не больше ${mb(up.maxBytes)}`);
  const before = await submissionState(token, assignId).catch(() => null);
  if (!before) throw new Error("Moodle не отвечает — ничего не изменено, попробуйте через минуту");
  if (!before.canEdit) throw new Error("Moodle сейчас не разрешает менять ответ по этой работе (срок закрыт или работа уже оценена)");
  if (before.onlineText) throw new Error("В этом задании у вас есть ещё текстовый ответ — чтобы его не потерять, прикрепите файл на сайте Moodle");
  const others = before.files.filter((f) => f.name !== file.name);
  const keep = up.maxFiles > 1 && others.length < up.maxFiles ? others : [];
  const kept = [];
  for (const f of keep) kept.push({ name: f.name, data: await downloadFile(f.url, token) });
  await attachFiles(token, assignId, [...kept, file]);
  cache.delete(token); // дедлайны со старым статусом не отдаём
  const after = await submissionState(token, assignId).catch(() => null);
  if (after && !after.files.some((f) => f.name === file.name)) throw new Error("Moodle принял запрос, но файла в ответе нет — проверьте на сайте Moodle");
  const view = (s) => s && { status: s.status, canEdit: s.canEdit, files: s.files.map((f) => f.name), drafts: item.submission?.drafts ?? true };
  return { before: view(before), state: view(after), removed: before.files.filter((f) => !keep.includes(f)).map((f) => f.name).filter((n) => n !== file.name), replacedSame: before.files.some((f) => f.name === file.name), line: stateLine(after) };
}

/** Кнопка «Отправить на проверку» в карточке работы (у заданий с черновиком). */
export async function submitOwn(token, assignId) {
  const d = await deadlines(token);
  const item = d.items.find((x) => x.id === `moodle:assign:${assignId}`);
  if (!item) throw new Error("Этой работы нет среди ваших заданий Moodle");
  const now = await submissionState(token, assignId).catch(() => null);
  if (!now) throw new Error("Moodle не отвечает — ничего не отправлено, попробуйте через минуту");
  if (now.status === "submitted") return { state: { status: now.status, canEdit: now.canEdit, files: now.files.map((f) => f.name), drafts: item.submission?.drafts ?? true }, already: true, line: stateLine(now) };
  if (!now.files.length && !now.onlineText) throw new Error("В ответе нет файла — сначала прикрепите PDF");
  await submitForGrading(token, assignId);
  cache.delete(token);
  const after = await submissionState(token, assignId).catch(() => null);
  if (after && after.status !== "submitted") throw new Error("Moodle принял запрос, но статус ответа не изменился — проверьте на сайте Moodle");
  return { state: after && { status: after.status, canEdit: after.canEdit, files: after.files.map((f) => f.name), drafts: item.submission?.drafts ?? true }, line: stateLine(after) };
}

/** Имена групп пользователя во всех активных курсах (для автоопределения группы расписания). */
export async function userGroupNames(token) {
  const info = await call(token, "core_webservice_get_site_info");
  const courses = await activeCourses(token, info.userid);
  const names = [];
  await Promise.all(courses.map(async (c) => {
    const g = await call(token, "core_group_get_course_user_groups", { courseid: c.id, userid: info.userid }).catch(() => ({ groups: [] }));
    for (const x of g.groups || []) names.push(x.name);
  }));
  return names;
}

// Преподаватели курса: «контакты курса» Moodle + профили (почта, роль). Кэш общий на курс, сутки.
const teacherCache = new Map(); // courseId → { at, data }
export async function teachers(token, courseId) {
  // Кэш преподавателей общий на курс, поэтому сначала убеждаемся, что это курс самого пользователя:
  // иначе любой вошедший мог бы запросить контакты чужого курса по номеру, если их уже загрузил кто-то другой.
  const { courses } = await coursesCached(token);
  if (!courses.some((x) => x.id === courseId)) throw Object.assign(new Error("Этого курса нет среди ваших актуальных"), { status: 404 });
  return (await courseCard(token, courseId)).teachers;
}
/** Карточка курса для экрана «Курс» (нажатие на пару в расписании): преподаватели и описание курса из Moodle. Кэш — сутки. */
async function courseCard(token, courseId) {
  const c = teacherCache.get(courseId);
  if (c && Date.now() - c.at < 24 * 3600 * 1000) return c.data;
  const r = await call(token, "core_course_get_courses_by_field", { field: "id", value: courseId });
  const course = r.courses?.[0] || {};
  const contacts = course.contacts || [];
  const params = {};
  contacts.forEach((u, i) => { params[`userlist[${i}][userid]`] = u.id; params[`userlist[${i}][courseid]`] = courseId; });
  const profiles = contacts.length ? await call(token, "core_user_get_course_user_profiles", params).catch(() => []) : [];
  const teachers = contacts.map((u) => {
    const p = (Array.isArray(profiles) ? profiles : []).find((x) => x.id === u.id);
    return { id: u.id, name: u.fullname, email: p?.email || null, role: p?.roles?.[0]?.name || null };
  });
  const summary = String(course.summary || "").replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>/gi, "\n").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\n{3,}/g, "\n\n").trim().slice(0, 1500);
  const data = { teachers, course: { id: courseId, fullname: course.fullname || "", summary, url: `${BASE}/course/view.php?id=${courseId}` } };
  teacherCache.set(courseId, { at: Date.now(), data });
  return data;
}
export async function courseInfo(token, courseId) {
  const { courses } = await coursesCached(token);
  if (!courses.some((x) => x.id === courseId)) throw Object.assign(new Error("Этого курса нет среди ваших актуальных"), { status: 404 });
  return courseCard(token, courseId);
}

// Быстрый опрос тестов: один вызов API (курсы кэшируются на 30 мин по токену). Короткие тесты «в моменте» появляются
// внезапно, поэтому server.mjs зовёт это каждые 2 минуты, а полная синхронизация остаётся раз в 15 минут.
const courseCache = new Map(); // token → { at, info, courses }
async function coursesCached(token) {
  const c = courseCache.get(token);
  if (c && Date.now() - c.at < 30 * 60e3) return c;
  const info = await call(token, "core_webservice_get_site_info");
  const courses = await activeCourses(token, info.userid);
  const v = { at: Date.now(), info, courses };
  courseCache.set(token, v);
  return v;
}
export async function quizzesQuick(token) {
  const { courses } = await coursesCached(token);
  const out = { items: [], courses: courses.map((c) => ({ id: c.id, name: cleanCourse(c.fullname), short: shortName(cleanCourse(c.fullname)) })) };
  if (!courses.length) return out;
  const p = {};
  courses.forEach((c, i) => (p[`courseids[${i}]`] = c.id));
  const quiz = await call(token, "mod_quiz_get_quizzes_by_courses", p);
  const now = Date.now();
  for (const q of quiz.quizzes || []) {
    if (q.visible === 0) continue;
    const due = q.timeclose ? q.timeclose * 1000 : null;
    if (due && due < now) continue; // уже закрыт — сообщать поздно
    out.items.push({ id: `moodle:quiz:${q.id}`, kind: "test", title: q.name, courseId: q.course, due,
      opensAt: q.timeopen ? q.timeopen * 1000 : undefined, url: `${BASE}/mod/quiz/view.php?id=${q.coursemodule}`, status: "open" });
  }
  return out;
}
