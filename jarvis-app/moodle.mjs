// Чтение Moodle от имени пользователя (по его токену): активные курсы, задания и тесты со статусами и оценками,
// группы пользователя в курсах (для автоопределения группы расписания). Кэш по токену (CACHE_MS), с 15 окт 2026 — с
// копией на диске, которая переживает перезапуск сервера (см. deadlines).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// FormData — из того же undici, чей fetch использует mfetch: встроенный класс Node этот fetch не распознал бы.
import { FormData } from "undici";
import { BASE, allLoggedIn, mfetch, netHealth, retry, seal, unseal } from "./users.mjs";
import * as pace from "./moodle-pace.mjs";
import * as plan from "./moodle-plan.mjs";
import { readJson, writeJsonAtomic } from "./state-file.mjs";

// Сколько приложение пользуется уже прочитанными дедлайнами. Фоновый обход перечитывает их раз в полчаса (server.mjs),
// поэтому срок чуть больше: открытие приложения не вызывает повторного чтения. Кнопка «Обновить» читает заново.
const CACHE_MS = Number(process.env.MOODLE_CACHE_MS) || 35 * 60 * 1000;
const LOOKBACK_S = 14 * 86400; // показываем и недавно прошедшие сроки
const LOOKBACK_DONE_S = 60 * 86400; // сданные работы держим дольше: оценка и замечания преподавателя приходят спустя недели
// Задания старше LOOKBACK_S, которые всё равно показываем (проверочный запуск): id через запятую в PIN_ASSIGNS.
const PINNED = new Set((process.env.PIN_ASSIGNS || "28995").split(",").map((s) => Number(s.trim())).filter(Boolean));
// Копия дедлайнов на диске (15 окт 2026) — подробно у deadlines() ниже. MOODLE_DISK=0 — выключить совсем (всё как до
// 15 окт; прежние копии при старте удаляются — см. restoreDisk); MOODLE_DISK_DIR — другая папка (стенды пишут в свою);
// MOODLE_DISK_MAX_MS — старше этого копия при старте не берётся.
const DIR = dirname(fileURLToPath(import.meta.url));
const DISK = process.env.MOODLE_DISK !== "0";
const DISK_DIR = process.env.MOODLE_DISK_DIR || join(DIR, "deadlines-cache");
const DISK_MAX_MS = Number(process.env.MOODLE_DISK_MAX_MS) || 24 * 3600e3;
// Версия копии — по тексту этого файла и списку PIN_ASSIGNS: любая правка логики чтения обесценивает все прежние копии.
// Иначе после перезапуска с правкой (15 окт — «тест сдан по завершённой попытке») до 35 минут отдавались бы данные,
// прочитанные старой логикой, как будто свежие.
const DISK_V = createHash("sha1").update(`${readFileSync(fileURLToPath(import.meta.url), "utf8")}\n${[...PINNED].join(",")}`).digest("hex").slice(0, 12);
// Экран приложения ждёт свежего чтения не дольше этого, если есть что показать (копия с диска или прежние данные в памяти).
const STALE_AFTER_MS = Number(process.env.MOODLE_STALE_AFTER_MS) || 6000;

// «Ответил не данными» (страница техработ, ошибка прокси): сеть жива, а Moodle не работает — второй признак сбоя для health().
let badDataAt = 0, badDataSince = 0, goodDataAt = 0;
// Отказ (403, 429): Moodle или защита перед ним не принимает запросы бота — третий признак для health().
let blockedAt = 0, blockedSince = 0;
// Повторы сетевых сбоев — общий retry() из users.mjs (там же причина: мёртвые пути до сети МИСИС).
// timeoutMs — срок одного запроса (отсчитывается, когда запрос дождался очереди и ушёл в сеть); attempts — число попыток.
export async function call(token, fn, params = {}, { timeoutMs = 25000, attempts, maxSent } = {}) {
  const body = new URLSearchParams({ wstoken: token, wsfunction: fn, moodlewsrestformat: "json", ...params });
  return retry(async () => {
    const res = await mfetch(`${BASE}/webservice/rest/server.php`, { method: "POST", body, timeoutMs });
    // Отказ сервера (403, 429) — признак ограничения: не повторяем (retry повторяет только сетевые сбои), фоновые обходы
    // ограничитель уже поставил на паузу (moodle-pace.mjs, leave). Для приложения это сбой (isOutage): оно показывает
    // прежние данные с плашкой, а не ошибку.
    if (res.status === 403 || res.status === 429) {
      if (blockedAt <= goodDataAt) blockedSince = Date.now();
      blockedAt = Date.now();
      void res.body?.cancel().catch(() => {}); // тело не читаем — соединение освобождается сразу
      throw new Error(`Moodle отклонил запрос (HTTP ${res.status}) — возможно, доступ бота ограничен`);
    }
    // Не JSON (страница техработ, ошибка прокси, страница защиты) — внятная ошибка вместо «Unexpected token <».
    const data = await res.json().catch(() => {
      if (badDataAt <= goodDataAt) badDataSince = Date.now();
      badDataAt = Date.now();
      pace.dataSeen(MOODLE_HOST, false, res.status);
      throw new Error(`Moodle ответил не данными (HTTP ${res.status}) — возможно, техработы`);
    });
    goodDataAt = Date.now();
    pace.dataSeen(MOODLE_HOST, true);
    if (data && data.exception) throw new Error(`${data.errorcode}: ${data.message}`);
    return data;
  }, { attempts, maxSent });
}

/** Вложенные параметры в вид веб-сервиса REST: { courseids: [1, 2] } → { "courseids[0]": 1, "courseids[1]": 2 }. */
function flat(params, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(params || {})) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === "object") flat(v, key, out); else out[key] = v;
  }
  return out;
}
/**
 * Несколько чтений ОДНИМ запросом — так делает официальное мобильное приложение Moodle (функция
 * tool_mobile_call_external_functions; на newlms.misis.ru доступна, проверено 5 окт 2026). Вместо 30–50 отдельных запросов
 * за статусами работ уходит один-два: бот не шлёт пачек с одного адреса. reqs: [{ fn, params }] — params обычным
 * объектом (массивы — массивами). Возвращает массив той же длины: { data } или { error } по каждому вызову.
 * Сетевой сбой, отказ (403, 429) или пауза — исключение (как у call). Если пакетного вызова на сайте нет — по одному.
 */
const BATCH = 25;
// До какого времени пакетный вызов выключен (на сайте нет функции или нет прав на неё): через час пробуем снова.
let batchOffUntil = process.env.MOODLE_BATCH === "0" ? Infinity : 0;
// Ошибки, означающие «самого пакетного вызова нет»: функции нет в Moodle (invalidrecord), она не разрешена службе
// мобильного приложения (accessexception); unknownfn — то же на тестовом стенде.
const NO_BATCH = /^(invalidrecord|accessexception|unknownfn)\b/;
export async function callMany(token, reqs) {
  const out = new Array(reqs.length);
  const single = async (i) => { try { out[i] = { data: await call(token, reqs[i].fn, flat(reqs[i].params)) }; } catch (e) { if (isOutage(e) || e.name === "PausedError") throw e; out[i] = { error: e }; } };
  for (let from = 0; from < reqs.length; from += BATCH) {
    const part = reqs.slice(from, from + BATCH);
    if (part.length > 1 && Date.now() >= batchOffUntil) {
      const p = {};
      part.forEach((r, i) => { p[`requests[${i}][function]`] = r.fn; p[`requests[${i}][arguments]`] = JSON.stringify(r.params || {}); });
      try {
        // Пакет тяжелее одиночного вызова: срок — по числу вложенных вызовов. Запрос, который мог дойти до Moodle
        // (таймаут, обрыв соединения), повторяем один раз: оборванный пакет Moodle всё равно дорабатывает, и пять
        // повторов по 25 вызовов нагрузили бы его впятеро. Несостоявшиеся соединения повторяются по обычному счёту.
        const res = await call(token, "tool_mobile_call_external_functions", p, { timeoutMs: 25000 + 2000 * part.length, maxSent: 2 });
        (res?.responses || []).forEach((r, i) => {
          if (i >= part.length) return;
          if (r.error) { let x = null; try { x = JSON.parse(r.exception); } catch { /* текст как есть */ } out[from + i] = { error: new Error(`${x?.errorcode || "error"}: ${x?.message || r.exception || "ошибка вызова"}`) }; }
          else { try { out[from + i] = { data: JSON.parse(r.data) }; } catch { out[from + i] = { error: new Error("ответ не разобран") }; } }
        });
        for (let i = 0; i < part.length; i++) out[from + i] ??= { error: new Error("нет ответа на вызов") };
        continue;
      } catch (e) {
        // Сбой сети, пауза, отказ и любая ошибка самого Moodle (неверный токен, техработы, сбой базы) — ошибка чтения,
        // как у обычного вызова. Пакет отключаем, только когда недоступен сам пакетный вызов, и не навсегда.
        if (!NO_BATCH.test(String(e?.message || ""))) throw e;
        batchOffUntil = Date.now() + 60 * 60e3;
        console.error(`moodle: пакетный вызов недоступен (${String(e.message || e).slice(0, 120)}) — час запросы идут по одному`);
      }
    }
    // По одному. У фона — по очереди: он и так идёт не чаще раза в секунду, а 25 запросов, вставших в очередь разом,
    // ждали бы её дольше собственного срока. У людей — сразу все: очередь сама выдерживает паузы.
    if (pace.isBackground()) for (let i = 0; i < part.length; i++) await single(from + i);
    else await Promise.all(part.map((_, i) => single(from + i)));
  }
  return out;
}
/** Номер пользователя Moodle по токену: спрашивается один раз на процесс, а не при каждом чтении дедлайнов. */
const userIds = new Map(); // token → userid
const whoCache = new Map(); // token → { userid, fullname, firstname, lastname }
const whoPending = new Map(); // token → идущий запрос (одновременные вызовы ждут его, а не шлют свой)
async function siteOf(token) {
  if (whoCache.has(token)) return whoCache.get(token);
  if (!whoPending.has(token)) {
    whoPending.set(token, call(token, "core_webservice_get_site_info").then((s) => {
      whoCache.set(token, { userid: s.userid, fullname: s.fullname || "", firstname: s.firstname || "", lastname: s.lastname || "" });
      userIds.set(token, s.userid);
      return whoCache.get(token);
    }).finally(() => whoPending.delete(token)));
  }
  return whoPending.get(token);
}
async function userIdOf(token) {
  if (!userIds.has(token)) await siteOf(token);
  return userIds.get(token);
}
/**
 * ФИО владельца токена, как его знает Moodle (для поиска своей строки в таблицах преподавателей, course-sheets.mjs).
 * Номер пользователя спрашивается один раз на процесс; live=false — только уже известное (иначе null).
 */
export async function whoAmI(token, { live = true } = {}) {
  if (whoCache.has(token)) return whoCache.get(token);
  return live && !health().down ? siteOf(token) : null;
}

/**
 * Работает ли сейчас Moodle (для плашки в приложении): down, с какого времени (since), причина — network (сеть МИСИС
 * не отвечает, см. netHealth в users.mjs), blocked (Moodle отклоняет запросы бота: 403, 429) или maintenance (отвечает
 * не данными: техработы), okAt — последний нормальный ответ.
 */
const MOODLE_HOST = new URL(BASE).hostname;
export function health() {
  const n = netHealth(MOODLE_HOST);
  if (n.down) return { down: true, since: n.since, reason: "network", okAt: n.okAt };
  if (blockedAt > goodDataAt && Date.now() - blockedAt < 5 * 60e3) return { down: true, since: blockedSince, reason: "blocked", okAt: goodDataAt || null };
  if (badDataAt > goodDataAt && Date.now() - badDataAt < 5 * 60e3) return { down: true, since: badDataSince, reason: "maintenance", okAt: goodDataAt || null };
  return { down: false, since: null, reason: null, okAt: Math.max(n.okAt || 0, goodDataAt) || null };
}
/**
 * Ошибка — это сбой Moodle или сети МИСИС (а не ответ самого Moodle: неверный токен, нет доступа к курсу)? Отказ 403/429
 * тоже сбой: данных нет, а прежние у сервера есть — приложение показывает их с плашкой.
 */
export const isOutage = (e) => /Moodle не отвечает|Moodle ответил не данными|Moodle отклонил запрос/.test(String(e?.message || e));

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
// Курс для должников и пересдач — по полному названию («Физика. Пересдача Осень 2026»: cleanCourse это слово отрезает).
// В общие беседы по таким курсам ничего не идёт (chats.mjs, 16 окт 2026).
const DEBT_COURSE = /пересда|задолж|должник|ликвидац/i;
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
const NO_OV = JSON.stringify({}); // ключ «ручного выбора нет»
/**
 * Ручной выбор курсов пользователя для этого токена. tgId (необязательно) — чей это токен: нужен только для копии
 * дедлайнов на диске (имя файла — Telegram id); без него копия просто не пишется. Настоящая смена выбора стирает кэши
 * по токену и копию на диске. Первый вызов после перезапуска с тем же выбором, что у восстановленной копии, ничего не
 * стирает: restoreDisk кладёт этот выбор сюда сам.
 */
export function setOverrides(token, o, tgId) {
  if (tgId != null) bindTg(token, tgId);
  const key = JSON.stringify(o || {});
  const prev = overridesByToken.get(token);
  if (prev?.key === key) return;
  overridesByToken.set(token, { key, o: o || {} });
  cache.delete(token); courseCache.delete(token); // список курсов изменился — кэши по токену устарели
  if (prev) void dropDisk(tgIdOf.get(token)); // копия прочитана по прежнему выбору курсов — после перезапуска она не нужна
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
export async function pendingCourses(token, userId, known = null) {
  const all = known || await call(token, "core_enrol_get_users_courses", { userid: userId }); // known — список уже получен вызывающим
  const o = overridesByToken.get(token)?.o || {};
  const cand = await candidates(token, all);
  return all.filter((c) => cand.has(c.id) && o[c.id] === undefined)
    .map((c) => ({ id: c.id, name: cleanCourse(c.fullname), fullname: c.fullname, reason: courseAuto(c).reason, ...cand.get(c.id) }));
}
/** Все курсы пользователя с решением «актуален/нет» и причиной — для экрана «Курсы» в приложении. */
export async function allCourses(token) {
  const info = { userid: await userIdOf(token) }; // номер пользователя спрашивается один раз на процесс
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
  return threadOf(r, userId);
}
const threadOf = (r, userId) => (r?.comments || []).map((c) => ({ author: c.fullname || null, text: stripHtml(c.content), at: c.timecreated ? c.timecreated * 1000 : null, mine: c.userid === userId })).filter((c) => c.text);
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

/*
 * Одно чтение дедлайнов — около 5 запросов к Moodle вместо ~50 (5 окт 2026): список курсов (1), задания и тесты одним
 * пакетом (1), статусы всех работ пакетами по 25 (1–2), комментарии к сданным работам пакетом (1). Раньше на каждую
 * работу уходил отдельный запрос статуса, на каждую сданную — ещё запрос комментариев, залпом через 6 соединений.
 * ov — ручной выбор курсов, взятый в самом начале чтения (deadlines): с этим же выбором (его ключом okey) копия ляжет на диск.
 */
async function loadDeadlines(token, ov = {}, okey = NO_OV) {
  const info = { userid: await userIdOf(token) };
  const all = await call(token, "core_enrol_get_users_courses", { userid: info.userid });
  const courses = all.filter((c) => ov[c.id] ?? courseAuto(c).auto);
  // Быстрый опрос тестов и таймер открытия работают с тем же списком курсов (иначе до получаса не знали бы о новом курсе).
  // Только если выбор курсов за время чтения не менялся (15 окт 2026, находка ревью #0): выбор берётся в начале чтения,
  // а фоновое чтение может ждать ответа Moodle минуты. Пока оно ждёт, человек включил курс (setOverrides стёр кэш), и
  // быстрые запросы людей уже положили сюда новый список — запоздавшее чтение затёрло бы его старым на 30 минут
  // (coursesCached): «Новый тест» по включённому курсу не приходил бы, а «Преподаватели» отвечали бы 404.
  if (okeyOf(token) === okey) courseCache.set(token, { at: Date.now(), info, courses });
  const ids = courses.map((c) => c.id);
  const since = Date.now() / 1000 - LOOKBACK_S, sinceDone = Date.now() / 1000 - LOOKBACK_DONE_S;
  let assign = { courses: [] }, quiz = { quizzes: [] };
  if (courses.length) {
    const [a, q] = await callMany(token, [{ fn: "mod_assign_get_assignments", params: { courseids: ids } }, { fn: "mod_quiz_get_quizzes_by_courses", params: { courseids: ids } }]);
    if (a.error) throw a.error;
    assign = a.data;
    if (!q.error) quiz = q.data;
  }

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
  // Статус: задание отправлено/оценено → сдано; тест с оценкой или с завершённой попыткой → сдано. Оценка — числом
  // (grade) и максимумом (gradeMax).
  const gradeMax = new Map(assign.courses.flatMap((c) => c.assignments.map((a) => [a.id, a.grade > 0 ? a.grade : null])));
  // Есть ли у задания черновик (настройка «Требовать нажатия кнопки „Отправить“»). Если нет — прикреплённый файл сразу
  // считается сданным: 1 окт 2026 в курсе ОКП «прикрепить черновик» сразу отправило работу на проверку.
  const hasDrafts = new Map(assign.courses.flatMap((c) => c.assignments.map((a) => [a.id, a.submissiondrafts !== 0])));
  // Тест сдан, если есть завершённая попытка, даже когда оценки нет (15 окт 2026, владелец: «тесты, пройденные в Moodle,
  // в Doodle не сделаны»): best_grade отвечает hasgrade=false, пока оценку скрывают до закрытия теста или пока
  // преподаватель не проверил вопросы с ручной проверкой. Попытки — в том же пакете, без лишних запросов.
  const quizItems = items.filter((x) => x._quiz);
  // Тест, у которого срок прошёл, — можно ли его ещё начать (так, как видит сам студент: у него может быть продление).
  // Нельзя и попытки нет — «просрочен» не показываем: сделать с ним уже ничего нельзя (владелец, 15 окт 2026).
  // Доступ спрашиваем первым в пакете: mod_quiz_get_attempt_access_information сама закрывает истёкшую попытку
  // (handle_if_time_expired), и оценка с попытками читаются уже после этого — отправленный автоматически тест не спрячется.
  const pastQuizzes = quizItems.filter((x) => x.due < Date.now());
  const access = pastQuizzes.flatMap((x) => [{ fn: "mod_quiz_get_quiz_access_information", params: { quizid: x._quiz } }, { fn: "mod_quiz_get_attempt_access_information", params: { quizid: x._quiz, attemptid: 0 } }]);
  const raw = await callMany(token, [
    ...access,
    ...items.map((x) => (x._assign
      ? { fn: "mod_assign_get_submission_status", params: { assignid: x._assign } }
      : { fn: "mod_quiz_get_user_best_grade", params: { quizid: x._quiz } })),
    // Все попытки, а не только завершённые: незавершённая (в процессе или просроченная в льготный период) ещё может быть
    // отправлена — такой тест прятать нельзя.
    ...quizItems.map((x) => ({ fn: "mod_quiz_get_user_attempts", params: { quizid: x._quiz, status: "all", includepreviews: 0 } })),
  ]);
  const A = access.length;
  const statuses = raw.slice(A, A + items.length);
  const attemptsOf = new Map(quizItems.map((x, j) => [x, raw[A + items.length + j]]));
  const statesOf = (x) => { const r = attemptsOf.get(x); return r && !r.error ? (r.data?.attempts || []).map((t) => t.state) : null; };
  // Нельзя начать новую попытку: причины доступа, «попыток больше нет», isfinished — «Moodle больше никогда не даст
  // начать» (после закрытия, в том числе в льготный период). Но при незавершённой попытке Moodle тоже говорит «попыток
  // больше нет» — её считает, а отправить её ещё можно. Попытки не прочитались — не прячем, пусть лучше покажется.
  const closedBy = (x, a, b) => {
    const states = statesOf(x);
    if (!states || states.some((s) => s === "inprogress" || s === "overdue")) return false;
    const reasons = [...(a.data.preventaccessreasons || []), ...(b && !b.error ? b.data.preventnewattemptreasons || [] : [])];
    return reasons.length > 0 || a.data.canattempt === false || (!!b && !b.error && b.data?.isfinished === true);
  };
  pastQuizzes.forEach((x, j) => {
    const a = raw[2 * j], b = raw[2 * j + 1];
    if (!a.error) x._closed = closedBy(x, a, b);
  });
  // До срока попытки могут кончиться брошенными (не отправлены вовремя): если Moodle новых не даст — тест тоже не висит
  // с напоминаниями. Таких тестов почти не бывает — отдельный маленький запрос только для них.
  const stuck = quizItems.filter((x) => x.due >= Date.now() && statesOf(x)?.length && statesOf(x).every((s) => s === "abandoned"));
  if (stuck.length) {
    const r = await callMany(token, stuck.map((x) => ({ fn: "mod_quiz_get_attempt_access_information", params: { quizid: x._quiz, attemptid: 0 } })));
    stuck.forEach((x, j) => { if (!r[j].error && r[j].data.isfinished === true) x._closed = true; });
  }
  // Комментарии к ответу читаем у любой работы, где ответ уже есть (в том числе возвращённой в черновик на доработку).
  const withAnswer = items.map((x, i) => ({ x, si: x._assign && !statuses[i].error ? submissionInfo(statuses[i].data) : null })).filter((w) => w.si && w.si.status !== "new" && w.x._cmid && w.si.submissionId);
  const threadRaw = await callMany(token, withAnswer.map((w) => ({ fn: "core_comment_get_comments", params: { contextlevel: "module", instanceid: w.x._cmid, component: "assignsubmission_comments", itemid: w.si.submissionId, area: "submission_comments", page: 0 } })));
  const threads = new Map(withAnswer.map((w, i) => [w.x, threadRaw[i].error ? [] : threadOf(threadRaw[i].data, info.userid)]));
  items.forEach((x, i) => {
    try {
      if (x._assign) {
        if (statuses[i].error) throw statuses[i].error;
        const s = statuses[i].data;
        const g = s.feedback?.grade?.grade;
        x.grade = g != null && g !== "" && Number(g) >= 0 ? Number(g) : null;
        x.gradeMax = gradeMax.get(x._assign) ?? null;
        const si = submissionInfo(s);
        x.status = si.status === "submitted" || x.grade != null ? "done" : "open";
        // Замечания преподавателя и состояние ответа — для блока «Комментарий преподавателя» и кнопки «Исправить отчёт».
        const thread = threads.get(x) || [];
        x.remarks = remarksOf(si, thread).map((r) => ({ ...r, text: r.text.slice(0, 4000) }));
        x.submission = { status: si.status, canEdit: si.canEdit, files: si.files.map((f) => f.name), drafts: hasDrafts.get(x._assign) ?? true };
      } else {
        const g = statuses[i].error ? null : statuses[i].data;
        const finished = !!statesOf(x)?.includes("finished");
        if (!g && !finished) throw statuses[i].error;
        const qz = quiz.quizzes.find((q) => q.id === x._quiz);
        // Тест без оценки (максимум 0 — «опрос»): Moodle оценку у него не показывает, и мы — не «0», а просто «сдано».
        const noGrades = !!qz && (Number(qz.grade) < 0.000005 || Number(qz.sumgrades) < 0.000005);
        x.grade = !noGrades && g?.hasgrade && g.grade != null ? Number(g.grade) : null;
        x.gradeMax = noGrades ? null : qz?.grade ?? null;
        x.status = g?.hasgrade || finished ? "done" : "open";
      }
    } catch { x.status = "open"; }
    delete x._assign; delete x._quiz; delete x._cmid;
  });
  // Давние работы оставляем только сданные — ради оценки и замечаний; несданные старше двух недель не показываем, как и раньше.
  // Закрытый тест (или с исчерпанными брошенными попытками) без завершённой попытки не показываем вовсе: пройти его уже нельзя.
  const kept = items.filter((x) => (!x._old || x.status === "done") && !(x._closed && x.status !== "done"));
  for (const x of kept) { delete x._old; delete x._closed; }
  kept.sort((a, b) => a.due - b.due);
  return {
    updated: Date.now(),
    userId: info.userid,
    items: kept,
    // auto — курс текущего семестра по автоматике (courseAuto), а не включённый только вручную (прошлый семестр, долг):
    // в общие беседы идут уведомления только по таким (chats.mjs, 16 окт 2026).
    courses: courses.map((c) => ({ id: c.id, name: cleanCourse(c.fullname), short: shortName(cleanCourse(c.fullname)), auto: courseAuto(c).auto, debt: DEBT_COURSE.test(c.fullname) })),
    // Курсы «под вопросом» (см. candidates): приложение показывает их с просьбой уточнить, бот спрашивает один раз.
    pendingCourses: await pendingCourses(token, info.userid, all).catch(() => []),
  };
}

/*
 * Дедлайны на диске (15 окт 2026, решение владельца). Кэш ниже живёт в памяти, и после перезапуска сервера он пуст у
 * всех: когда много людей открывают приложение разом, каждый ждёт Moodle в очереди людей (~6–7 запросов в секунду).
 * Замер на стенде (load-test): 50 человек — около минуты, 100 — около двух (Cloudflare обрывает ответ на 100 с), 200 —
 * никто за 3 минуты. Поэтому каждое удачное чтение ещё и ложится копией в deadlines-cache\<tgId>.json, а при старте
 * сервер возвращает копии в память (restoreDisk). С диска читаем ТОЛЬКО при старте: во время работы всё решает память,
 * и любой сброс в ней сразу верен.
 *  - Файл: { v, tgId, at, semester, blob }; blob — данные, зашифрованные ключом users.key (users.seal). Токена нет ни
 *    в имени, ни в файле, ни в журнале: он входит в «связанные данные» шифра (aad) вместе с версией кода, выбором курсов
 *    и семестром. Копия откроется, только если всё это совпало; иначе (другой токен, правка moodle.mjs, смена курсов
 *    или семестра, подмена файла) она не расшифруется и будет удалена.
 *  - Копия — не свежие данные. Её видят staleDeadlines и deadlinesAt (фоновые обходы, напоминания, бот, «Сессия» —
 *    сразу после старта, это главный выигрыш) и те, кто прямо разрешил (allowDisk: календарь, отзыв по работе). Экран
 *    приложения получает её, только если Moodle не успел ответить (deadlinesForApp). Прикрепление и отправка работы
 *    решают только по прочитанному из Moodle в этом процессе.
 *  - Пишем только принятое чтение и только если запись всё ещё в кэше (её не сбросили, пока шло чтение) и выбор курсов
 *    тот же, с которым читали. Очередь на пользователя: из нескольких ждущих записей делается последняя, файл с более
 *    новыми данными старым не затирается. Фоновое чтение ждёт своей записи (не дольше 2 с): иначе убитый между
 *    чтением и записью процесс оставил бы копию старее того, что уже разослал notify.check (ложное «📝 Оценка»).
 *  - Сброс (прикрепили или отправили работу, сменили курсы, вышли, вошли заново) удаляет и файл — в той же очереди,
 *    что запись (уже идущая запись старой копии его не воскресит), плюс отметка dl-drop:<tgId> в moodle-pace: если
 *    файл удалить не дали (EPERM), при старте копия не новее отметки всё равно не берётся.
 *  - Выход, мёртвый токен (invalidtoken) и новый вход ещё и отзывают прежний токен (revoked, ниже): фоновый обход идёт
 *    по списку вошедших, взятому в начале круга, и до вышедшего доходит через минуты — с его прежним токеном, который
 *    Moodle не отозвал. Без отзыва setOverrides(…, tgId) этого обхода снова связал бы токен с человеком, и чтение заново
 *    положило бы на диск копию с оценками и замечаниями вышедшего (или данные прежней учётной записи — в файл новой).
 */
const cache = new Map(); // token → { at, data, pending, pendingBg, from, disk, okey }; disk — копия с диска, okey — ключ выбора курсов чтения
const tgIdOf = new Map(); // token → Telegram id владельца (имя файла копии); заполняют setOverrides(…, tgId) и restoreDisk
/*
 * Отозванные токены (15 окт 2026, находки ревью #1, #23, #24): token → tgId. Пополняют выход и мёртвый токен
 * (forgetDeadlines(…, { revoke: true })) и новый вход (forgetUserDeadlines — все прежние токены человека). Такой токен
 * не связывается с человеком (bindTg) и копию не пишет (persist и сама запись в очереди), даже если чтение с ним ещё
 * идёт или его начнёт обход по старому списку. Снимает отзыв только новый вход с ЭТИМ ЖЕ токеном (Moodle часто выдаёт
 * прежний) — forgetUserDeadlines(…, fresh) — и restoreDisk при старте (его список — те, кто вошёл сейчас).
 * Набор ограничен (GONE_MAX, самые старые выпадают): выпавший давний токен в худшем случае снова пишет кэш, как до 15 окт.
 */
const GONE_MAX = 1000;
const revoked = new Map();
/*
 * Мёртвые токены (15 окт 2026, находка ревью #2): token → когда чтение ответило invalidtoken/accessexception. Экран
 * приложения ждёт чтения не дольше 6 с и отдаёт копию (deadlinesForApp) — отказ, пришедший позже, раньше просто глушился,
 * и человек со сменённым паролем видел старые дедлайны вместо формы входа, пока очередь не разгрузится. Теперь такой
 * отказ запоминается, копия на диске удаляется, а следующий deadlinesForApp бросает «invalidtoken: …» — server.mjs снимает
 * вход, как при любом invalidtoken. Снимает отметку удачное чтение, начатое позже неё, новый вход этим токеном и restoreDisk.
 * Только invalidtoken: accessexception бывает и у отдельной функции (нет прав на неё) — из-за него выход не делаем, как
 * и раньше (там был ответ 424 без выхода).
 */
const DEAD_RE = /^invalidtoken\b/;
const dead = new Map();
/** Положить в ограниченный набор (Map хранит порядок вставки: первым выпадает самый давний). */
function remember(set, token, v) {
  set.delete(token); set.set(token, v);
  while (set.size > GONE_MAX) set.delete(set.keys().next().value);
}
/** Отозвать токен: больше не связан с человеком и копию не пишет (см. revoked). */
function revokeToken(token, tgId) {
  if (!token) return;
  remember(revoked, token, Number(tgId) || 0);
  tgIdOf.delete(token);
}
/** Чтение ответило «токен недействителен»: запомнить и удалить копию на диске (в очереди этого человека). */
function markDead(token) {
  remember(dead, token, Date.now());
  void dropDisk(tgIdOf.get(token));
}
const diskQ = new Map(); // tgId → { tail, seq } — очередь записи и удаления копии этого пользователя
const diskUpdated = new Map(); // tgId → updated копии, которая сейчас лежит на диске (насколько знает этот процесс)
const fileOf = (tgId) => join(DISK_DIR, `${tgId}.json`);
const aadOf = (tgId, okey, semester, token) => `deadlines|${DISK_V}|${tgId}|${okey}|${semester}|${token}`;
const okeyOf = (token) => overridesByToken.get(token)?.key ?? NO_OV;
const within = (p, ms) => new Promise((r) => { const t = setTimeout(r, ms); void p.then(() => { clearTimeout(t); r(); }); });
/**
 * Токен принадлежит этому пользователю. У пользователя один действующий токен: прежний (до нового входа) копию больше не пишет.
 * Отозванный токен (выход, мёртвый, прежний до нового входа) не связывается: иначе обход по старому списку вошедших
 * связал бы его снова и заодно отвязал бы новый токен человека (15 окт 2026).
 */
function bindTg(token, tgId) {
  const id = Number(tgId);
  if (!token || revoked.has(token) || !Number.isFinite(id) || !id || tgIdOf.get(token) === id) return;
  for (const [t, x] of tgIdOf) if (x === id) tgIdOf.delete(t);
  tgIdOf.set(token, id);
}
/** Удалить файл с повторами (на Windows его на миг держат антивирус и копия данных). true — удалён, false — его не было. */
async function unlinkRetry(path) {
  for (let i = 0; ; i++) {
    try { await unlink(path); return true; }
    catch (e) {
      if (e?.code === "ENOENT") return false;
      if (i >= 5 || !/^(EPERM|EACCES|EBUSY)$/.test(String(e?.code || ""))) throw e;
      await new Promise((r) => setTimeout(r, 40 * (i + 1)));
    }
  }
}
const unlinkQuiet = (path) => unlinkRetry(path).catch(() => false);
/**
 * Очередь дел с копией одного пользователя: записи и удаления идут строго по порядку. Запись, за которой уже стоит
 * что-то ещё (запись поновее или удаление), пропускается — делается только последнее. Обещание не отказывает никогда:
 * неудача — одна строка в журнал (без токена), копия — это только кэш.
 */
function diskJob(tgId, kind, run) {
  const q = diskQ.get(tgId) || { tail: Promise.resolve(), seq: 0 };
  const seq = ++q.seq;
  const p = q.tail.then(() => (kind === "write" && seq !== q.seq ? null : run()))
    .catch((e) => console.error(`deadlines-disk ${tgId}: копия ${kind === "write" ? "не записана" : "не удалена"} (${e?.code || String(e?.message || e).slice(0, 120)})`));
  q.tail = p;
  diskQ.set(tgId, q);
  void p.then(() => { if (diskQ.get(tgId) === q && q.tail === p) diskQ.delete(tgId); });
  return p;
}
/** Принятое чтение → копия на диск. Возвращает обещание записи или null (писать не нужно или нельзя). */
function persist(token, c, okey) {
  const tgId = tgIdOf.get(token);
  // Запись сброшена, пока шло чтение (setOverrides, forgetDeadlines), или выбор курсов уже другой — эти данные на диск не идут.
  // Отозванный или мёртвый токен (см. revoked, dead) — тоже нет.
  if (!DISK || !tgId || revoked.has(token) || dead.has(token) || cache.get(token) !== c || okey !== okeyOf(token)) return null;
  const snap = { token, okey, at: c.at, data: c.data };
  // В очереди проверяем ещё раз: пока запись ждала (перед ней — медленная запись или удаление), человек мог выйти или
  // войти другой учётной записью — тогда токен уже не его, и файл не пишется.
  return diskJob(tgId, "write", () => (tgIdOf.get(token) === tgId && !revoked.has(token) && !dead.has(token) ? writeCopy(tgId, snap) : null));
}
async function writeCopy(tgId, s) {
  if ((diskUpdated.get(tgId) || 0) > s.data.updated) return; // на диске уже копия новее (её дало чтение, начатое позже)
  await mkdir(DISK_DIR, { recursive: true });
  const semester = currentSemester();
  const blob = await seal(s.data, aadOf(tgId, s.okey, semester, s.token));
  await writeJsonAtomic(fileOf(tgId), { v: DISK_V, tgId, at: s.at, semester, blob });
  diskUpdated.set(tgId, s.data.updated);
}
/** Удалить копию пользователя (в его очереди) и сразу поставить отметку сброса. Не отказывает. */
function dropDisk(tgId) {
  if (!DISK || !tgId) return Promise.resolve();
  pace.stamp(`dl-drop:${tgId}`, 0, true); // на диск сразу: процесс могут убить до того, как очередь дойдёт до удаления
  diskUpdated.delete(tgId);
  return diskJob(tgId, "drop", async () => { diskUpdated.delete(tgId); await unlinkRetry(fileOf(tgId)); });
}

/** Последние загруженные дедлайны, сколько бы им ни было (пока Moodle не отвечает, приложение показывает их). После перезапуска — и копия с диска. */
export const staleDeadlines = (token) => cache.get(token)?.data ?? null;
/**
 * Забыть прочитанные дедлайны (после прикрепления или отправки работы): со старым статусом их больше не отдаём — ни из
 * памяти, ни с диска после перезапуска. Память — сразу; файл — в очереди этого пользователя. tgId — если токен ещё не
 * связан с пользователем (выход: запрос /api/logout приходит раньше setOverrides). revoke — токен больше не этого
 * человека (выход, мёртвый токен; 15 окт 2026): он отзывается (см. revoked), и запоздавшее чтение или обход по старому
 * списку вошедших копию на диск уже не вернут. Прикрепление и отправка работы токен не отзывают. Обещание не отказывает.
 */
export function forgetDeadlines(token, tgId = null, { revoke = false } = {}) {
  const id = tgId != null ? Number(tgId) : tgIdOf.get(token);
  if (token) {
    cache.delete(token);
    if (revoke) { courseCache.delete(token); revokeToken(token, id); }
  }
  return dropDisk(id);
}
/**
 * Вход заново: забыть дедлайны пользователя по всем его прежним токенам (и по token, если передан) и копию на диске.
 * Moodle часто выдаёт тому же человеку прежний токен, а под тем же Telegram может войти другая учётная запись.
 * Прежние токены отзываются (см. revoked; обход мог взять один из них до входа). fresh — токен, выданный этим входом
 * (15 окт 2026): он не отзывается, а прежний отзыв и отметка «мёртвый» с него снимаются — даже если Moodle выдал тот же
 * токен, что был до выхода; он сразу связывается с человеком, и первое же чтение снова кладёт копию на диск.
 */
export function forgetUserDeadlines(tgId, token = null, fresh = null) {
  const id = Number(tgId);
  const old = [...tgIdOf].filter(([, x]) => x === id).map(([t]) => t);
  if (token) old.push(token);
  for (const t of old) {
    cache.delete(t); courseCache.delete(t); tgIdOf.delete(t);
    if (t !== fresh) revokeToken(t, id);
  }
  const p = dropDisk(id);
  if (fresh) { revoked.delete(fresh); dead.delete(fresh); bindTg(fresh, id); }
  return p;
}
/** Когда дедлайны по этому токену читались из Moodle последний раз (мс) или 0. У копии с диска — время её чтения. */
export const deadlinesAt = (token) => cache.get(token)?.at || 0;
/**
 * Дедлайны из кэша (моложе maxAge) или свежим чтением. allowDisk — копия с диска (после перезапуска) тоже годится как
 * кэш; без него она не в счёт, и Moodle читается, как при пустом кэше. Первое удачное чтение копию заменяет.
 */
export async function deadlines(token, force = false, { maxAge = CACHE_MS, allowDisk = false } = {}) {
  const c = cache.get(token) || {};
  if (!force && c.data && (allowDisk || !c.disk) && Date.now() - c.at < maxAge) return c.data;
  const bg = pace.isBackground();
  // Одно чтение на всех, кто спросил одновременно. Исключение: человек не присоединяется к чтению, начатому фоновым
  // обходом, — оно идёт по запросу в секунду и может встать на паузу; человек читает сам, быстро.
  if (!c.pending || (c.pendingBg && !bg)) {
    // Выбор курсов — в самом начале чтения: с ним Moodle и читается, и с его ключом копия ложится на диск.
    const started = Date.now(), ovr = overridesByToken.get(token), okey = ovr?.key ?? NO_OV;
    const p = loadDeadlines(token, ovr?.o || {}, okey)
      .then(async (d) => {
        // Токен жив: удачное чтение, начатое ПОСЛЕ отметки «мёртвый», её снимает (раньше начатое — нет: оно могло уйти
        // ещё до того, как токен отозвали).
        if (dead.has(token) && dead.get(token) < started) dead.delete(token);
        if (started >= (c.from || 0)) { // более раннее чтение не затирает более позднее
          c.data = d; c.at = Date.now(); c.from = started; c.disk = false; c.okey = okey;
          const w = persist(token, c, okey);
          if (w && bg) await within(w, 2000); // фон ждёт записи копии (см. выше); человек — нет
        }
        return d;
      })
      .finally(() => { if (c.pending === p) { c.pending = null; c.pendingBg = false; } });
    c.pending = p; c.pendingBg = bg;
    cache.set(token, c);
  }
  return c.pending;
}
const LATE = Symbol("late");
/**
 * Дедлайны для экрана приложения (GET /api/deadlines). Свежие данные в памяти (не копия с диска, моложе CACHE_MS) и без
 * «Обновить» — сразу, как раньше. Иначе — чтение Moodle (новое или уже идущее), и если показать есть что (копия с диска
 * или прежние данные в памяти), ждём его не дольше MOODLE_STALE_AFTER_MS (6 с): не успело — отдаём прежние данные с
 * пометкой { stale: true, source: "disk" | "memory" }, а чтение продолжает наполнять кэш. Наша же очередь (QueueError —
 * Moodle не перегружен, это мы ждём своей очереди) — тот же ответ. Сбой Moodle и пауза — исключение наверх (server.mjs
 * отвечает прежними данными с плашкой). Показать нечего — ждём чтения, как раньше. MOODLE_DISK=0 — всё как до 15 окт.
 * Мёртвый токен (см. dead) не прячется за копией: отказ invalidtoken — и до 6 с, и после — запоминается,
 * копия на диске удаляется, а этот и следующие вызовы бросают «invalidtoken: …» (server.mjs снимает вход и просит войти).
 */
/*
 * Обновления «вдогонку» (15 окт 2026, замер ops/stand/load-test.mjs --restart на 200 людях): после перезапуска все
 * открыли приложение разом, каждому через ~6 с ушла копия, а его чтение продолжало идти в очереди людей — 200 чтений,
 * около 1200 запросов, заняли её минуты на три: «Сессия» открывалась 35–45 с, а фоновые обходы (тесты, материалы) стояли,
 * потому что запросы людей в очереди всегда первые. Поэтому таких чтений одновременно не больше REFRESH_PARALLEL: когда
 * они заняты, человеку с прежними данными копия отдаётся сразу, а обновление его данных встаёт в очередь и идёт по
 * одному. «Обновить» самого человека (refresh) ждёт как раньше.
 */
const REFRESH_PARALLEL = Math.max(1, Number(process.env.MOODLE_REFRESH_PARALLEL) || 2);
let refreshing = 0;
const refreshQueue = new Set(); // токены в порядке постановки
/** Посчитать чтение «вдогонку»: место освобождается, когда оно закончится, и тогда идёт следующее из очереди. */
function holdRefresh(p, token) {
  refreshing++;
  p.catch((e) => { if (DEAD_RE.test(String(e?.message || ""))) markDead(token); }).finally(() => { refreshing--; pumpRefresh(); });
}
function pumpRefresh() {
  for (const token of refreshQueue) {
    if (refreshing >= REFRESH_PARALLEL) return;
    refreshQueue.delete(token);
    if (dead.has(token) || revoked.has(token)) continue;
    const c = cache.get(token);
    if (!c?.data || (!c.disk && Date.now() - c.at < CACHE_MS)) continue; // уже свежие или данные сброшены
    holdRefresh(deadlines(token, false), token);
  }
}
export async function deadlinesForApp(token, { refresh = false, staleAfterMs = STALE_AFTER_MS } = {}) {
  if (!DISK) return deadlines(token, refresh);
  // До свежих данных в памяти: иначе ещё полчаса (CACHE_MS) их бы и отдавали, не замечая, что токен уже недействителен.
  if (dead.has(token)) throw new Error("invalidtoken: токен Moodle больше не действует — нужно войти заново");
  const c = cache.get(token);
  if (!refresh && c?.data && !c.disk && Date.now() - c.at < CACHE_MS) return c.data;
  // Места для чтений «вдогонку» заняты — сразу прежние данные, обновление в очередь.
  if (!refresh && c?.data && refreshing >= REFRESH_PARALLEL) {
    refreshQueue.add(token);
    return { ...c.data, stale: true, source: c.disk ? "disk" : "memory" };
  }
  const p = deadlines(token, refresh);
  if (c?.data) holdRefresh(p, token);
  // Обработчик — сразу, до гонки с таймером: он же не даёт отказу, которого никто уже не ждёт, стать необработанной
  // ошибкой процесса. Ранний отказ (до 6 с) всё равно уходит наверх как раньше — через return p или гонку ниже.
  p.catch((e) => { if (DEAD_RE.test(String(e?.message || ""))) markDead(token); });
  if (!c?.data) return p;
  let timer;
  try {
    const r = await Promise.race([p, new Promise((res) => { timer = setTimeout(res, staleAfterMs, LATE); })]);
    if (r !== LATE) return r;
  } catch (e) {
    if (e?.name !== "QueueError") throw e;
  } finally { clearTimeout(timer); }
  const cur = cache.get(token);
  if (!cur?.data) return p; // пока ждали, данные сбросили (прикрепили работу) — старые не показываем
  return { ...cur.data, stale: true, source: cur.disk ? "disk" : "memory" };
}

/**
 * При старте сервера (до таймеров и listen) — копии дедлайнов с диска в память. list — вошедшие пользователи
 * [{ tgId, token, overrides, moodleUserId? }] (users.allLoggedIn). Копия берётся, только если совпало всё: версия кода,
 * семестр, срок (MOODLE_DISK_MAX_MS), сброса после неё не было (dl-drop), выбор курсов и токен (через aad шифра), номер
 * пользователя Moodle (если известен). Не подошла — файл удаляется: это кэш, других последствий нет. Затем чистка папки
 * и дальше раз в 6 часов. Возвращает счётчики { restored, missing, old, bad, removed }.
 * MOODLE_DISK=0 (15 окт 2026, находка ревью #27): копии не пишутся и не читаются, но и прежние (функция работала,
 * потом её выключили) не должны лежать без срока — с оценками и замечаниями, в том числе вышедших: сброс при
 * выключенной функции файлов не трогает, а чистки раз в 6 часов нет. Поэтому при старте папка копий очищается целиком
 * (*.json, *.tmp, *.bad-*); заодно после повторного включения не вернётся копия, сброс которой пришёлся на выключенное время.
 */
let cleanTimer = null;
export async function restoreDisk(list = []) {
  const n = { restored: 0, missing: 0, old: 0, bad: 0, removed: 0 };
  if (!DISK) {
    n.removed = await purgeDisk().catch(() => 0);
    if (n.removed) console.log(`deadlines-disk: выключено (MOODLE_DISK=0) — прежние копии удалены: ${n.removed}`);
    return n;
  }
  const now = Date.now(), sem = currentSemester();
  for (const u of list || []) {
    const tgId = Number(u?.tgId), token = u?.token;
    if (!tgId || !token) continue;
    // Список — те, кто вошёл сейчас: их токены действующие (отзыв и «мёртвый» с них снимаются, с прежних — нет).
    revoked.delete(token); dead.delete(token);
    const f = fileOf(tgId);
    let j;
    // Занят (EBUSY и т. п.) — считаем, что копии нет: файл перезапишет первое же чтение.
    try { j = await readJson(f, { missing: null, corrupt: "missing" }); } catch { n.missing++; continue; }
    if (!j || typeof j !== "object") { if (await unlinkQuiet(f)) n.bad++; else n.missing++; continue; } // испорченный JSON (отложен в .bad-*) — тоже удалить
    const okey = JSON.stringify(u.overrides || {}), drop = pace.stampAt(`dl-drop:${tgId}`);
    const at = Number(j.at);
    let data = null, why = "bad";
    if (j.v === DISK_V && j.tgId === tgId && j.semester === sem && typeof j.blob === "string") {
      if (!(now - at <= DISK_MAX_MS)) why = "old";
      else if (at > drop && at <= now + 60e3) data = await unseal(j.blob, aadOf(tgId, okey, sem, token)).catch(() => null);
    }
    // Время внутри шифра — главное: поле at лежит открытым текстом и его можно подправить.
    const uid = Number(u.moodleUserId) || null;
    const ok = !!data && Array.isArray(data.items) && Array.isArray(data.courses) && Number.isFinite(data.updated)
      && now - data.updated <= DISK_MAX_MS && data.updated > drop && (!uid || data.userId === uid);
    if (!ok) { await unlinkQuiet(f); n[why]++; continue; }
    cache.set(token, { at: Math.min(at, now), data, from: 0, disk: true, okey });
    // Иначе первый же setOverrides после старта счёл бы выбор курсов новым и стёр запись.
    overridesByToken.set(token, { key: okey, o: u.overrides || {} });
    bindTg(token, tgId);
    if (data.userId) userIds.set(token, data.userId); // копия привязана к токену — номер пользователя тот же
    diskUpdated.set(tgId, data.updated);
    n.restored++;
  }
  n.removed = await cleanDisk(new Set((list || []).map((u) => Number(u?.tgId)).filter(Boolean)), true).catch(() => 0);
  if (!cleanTimer) {
    cleanTimer = setInterval(() => {
      void allLoggedIn().then((l) => cleanDisk(new Set(l.map((u) => Number(u.tgId))), false))
        .then((k) => { if (k) console.log(`deadlines-disk: чистка — удалено файлов ${k}`); }, (e) => console.log(`deadlines-disk: чистка не прошла (${String(e?.message || e).slice(0, 120)})`));
    }, 6 * 3600e3);
    cleanTimer.unref?.();
  }
  console.log(`deadlines-disk: восстановлено ${n.restored} из ${(list || []).length} (копии нет ${n.missing}, старше срока ${n.old}, не подошли ${n.bad}; чистка удалила ${n.removed})`);
  return n;
}
/**
 * Чистка папки копий: обрывки записи (*.tmp) и отложенные испорченные (*.bad-*) — при старте все, потом старше 10 минут
 * (рядом может идти запись); копии тех, кто не вошёл; копии старше срока. Содержимое не читается (по времени файла):
 * копии другой версии и нерасшифровываемые уже удалил restoreDisk, а этот процесс пишет только своей версией.
 */
async function cleanDisk(loggedIn, startup) {
  const names = await readdir(DISK_DIR).catch(() => []);
  const older = (p, ms) => stat(p).then((s) => Date.now() - s.mtimeMs > ms, () => false);
  let n = 0;
  for (const f of names) {
    const p = join(DISK_DIR, f), m = /^(\d+)\.json$/.exec(f);
    let del = false;
    if (f.endsWith(".tmp") || f.includes(".bad-")) del = startup || await older(p, 10 * 60e3);
    else if (m) del = !loggedIn.has(Number(m[1])) || await older(p, DISK_MAX_MS);
    if (del && await unlinkQuiet(p)) n++;
  }
  return n;
}
/** MOODLE_DISK=0: удалить из папки копий всё, что туда писал этот модуль (копии, обрывки записи, отложенные испорченные). */
async function purgeDisk() {
  const names = await readdir(DISK_DIR).catch(() => []);
  let n = 0;
  for (const f of names) if ((f.endsWith(".json") || f.endsWith(".tmp") || f.includes(".bad-")) && await unlinkQuiet(join(DISK_DIR, f))) n++;
  return n;
}
/** Файл лежит в папке копий дедлайнов (это кэш: испорченный удаляется сам) — server.mjs не пишет о нём владельцу. */
export const isDiskCopyPath = (path) => resolve(dirname(String(path || ""))) === resolve(DISK_DIR);

/**
 * Отзыв по одной работе свежим запросом — для экрана лабы и для «Исправить отчёт»: замечания, состояние ответа, файлы.
 * Raw-вариант содержит адреса файлов и нужен только серверу (скачать сданный отчёт и файлы отзыва в папку лабы).
 */
export async function assignFeedbackRaw(token, assignId) {
  // Из дедлайнов нужны только медленно меняющиеся сведения (название, cmid, черновик, максимум, номер пользователя) —
  // копия с диска годится; замечания и состояние ответа — свежим запросом.
  const [d, s] = await Promise.all([deadlines(token, false, { allowDisk: true }), call(token, "mod_assign_get_submission_status", { assignid: assignId })]);
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
/** Файл из Moodle по токену. maxBytes — предел (заголовок content-length больше — не качаем: таблицы курса, 15 окт 2026). */
export async function downloadFile(url, token, { maxBytes = Infinity } = {}) {
  const full = url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
  return Buffer.from(await retry(() => mfetch(full, { timeoutMs: 60000 }).then((r) => {
    if (!r.ok) throw new Error(`файл из Moodle: HTTP ${r.status}`);
    const len = Number(r.headers.get("content-length"));
    if (len > maxBytes) { void r.body?.cancel().catch(() => {}); throw Object.assign(new Error(`файл из Moodle больше ${Math.round(maxBytes / 1048576)} МБ`), { tooBig: true }); }
    return r.arrayBuffer();
  })));
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
    const res = await mfetch(`${BASE}/webservice/upload.php`, { method: "POST", body: form, timeoutMs: 180000 });
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
  // Без копии с диска (allowDisk по умолчанию нет): «оставить прежние файлы или заменить» решается по maxFiles задания,
  // и устаревшая копия (maxFiles=1 при настоящем >1) безвозвратно убрала бы файлы студента из ответа.
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
  await forgetDeadlines(token); // дедлайны со старым статусом не отдаём — ни из памяти, ни с диска после перезапуска
  const after = await submissionState(token, assignId).catch(() => null);
  if (after && !after.files.some((f) => f.name === file.name)) throw new Error("Moodle принял запрос, но файла в ответе нет — проверьте на сайте Moodle");
  const view = (s) => s && { status: s.status, canEdit: s.canEdit, files: s.files.map((f) => f.name), drafts: item.submission?.drafts ?? true };
  return { before: view(before), state: view(after), removed: before.files.filter((f) => !keep.includes(f)).map((f) => f.name).filter((n) => n !== file.name), replacedSame: before.files.some((f) => f.name === file.name), line: stateLine(after) };
}

/** Кнопка «Отправить на проверку» в карточке работы (у заданий с черновиком). */
export async function submitOwn(token, assignId) {
  const d = await deadlines(token); // без копии с диска — как у attachOwnFile
  const item = d.items.find((x) => x.id === `moodle:assign:${assignId}`);
  if (!item) throw new Error("Этой работы нет среди ваших заданий Moodle");
  const now = await submissionState(token, assignId).catch(() => null);
  if (!now) throw new Error("Moodle не отвечает — ничего не отправлено, попробуйте через минуту");
  if (now.status === "submitted") return { state: { status: now.status, canEdit: now.canEdit, files: now.files.map((f) => f.name), drafts: item.submission?.drafts ?? true }, already: true, line: stateLine(now) };
  if (!now.files.length && !now.onlineText) throw new Error("В ответе нет файла — сначала прикрепите PDF");
  await submitForGrading(token, assignId);
  await forgetDeadlines(token);
  const after = await submissionState(token, assignId).catch(() => null);
  if (after && after.status !== "submitted") throw new Error("Moodle принял запрос, но статус ответа не изменился — проверьте на сайте Moodle");
  return { state: after && { status: after.status, canEdit: after.canEdit, files: after.files.map((f) => f.name), drafts: item.submission?.drafts ?? true }, line: stateLine(after) };
}

/** Имена групп пользователя во всех активных курсах (для автоопределения группы расписания). */
export async function userGroupNames(token) {
  const info = { userid: await userIdOf(token) }; // номер пользователя спрашивается один раз на процесс
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

/*
 * Журнал оценок и рейтинг-план курсов — для баллов «Сессии» по дисциплинам, которых нет в электронном журнале
 * (admission.mjs, разбор — moodle-plan.mjs). Одним пакетным запросом: по курсу gradereport_user_get_grade_items, плюс
 * mod_page_get_pages_by_courses и описания курсов для тех, чей план устарел. Оценки держим 10 минут, планы — 12 часов;
 * и то и другое по токену и курсу: страницы Moodle отдаёт по правам владельца токена (план, закрытый для чужой группы,
 * не должен уйти из кэша другому студенту — проверка 15 окт). live=false — только из уже прочитанного (фоновые
 * уведомления в Moodle за этим не ходят). Moodle недоступен или чтение сорвалось — тоже из прочитанного, без ожидания
 * и без потери кэша. Возвращает Map courseId → { items, plan: { text, cmid, name } | null }.
 */
const GRADES_MS = 10 * 60e3, PLANS_MS = 12 * 3600e3;
const gradeCache = new Map(); // `${token}:${courseId}` → { at, items }
const planCache = new Map(); // `${token}:${courseId}` → { at, text, cmid, name }
export async function courseScores(token, courseIds, { live = true } = {}) {
  const ids = [...new Set(courseIds.map(Number).filter(Boolean))];
  const now = Date.now(), gKey = (id) => `${token}:${id}`;
  const needGrades = ids.filter((id) => !(now - (gradeCache.get(gKey(id))?.at || 0) < GRADES_MS));
  const needPlans = ids.filter((id) => !(now - (planCache.get(gKey(id))?.at || 0) < PLANS_MS));
  if (live && (needGrades.length || needPlans.length) && !health().down) {
    try {
      const userid = await userIdOf(token);
      const reqs = needGrades.map((id) => ({ fn: "gradereport_user_get_grade_items", params: { courseid: id, userid } }));
      if (needPlans.length) reqs.push({ fn: "mod_page_get_pages_by_courses", params: { courseids: needPlans } }, { fn: "core_course_get_courses_by_field", params: { field: "ids", value: needPlans.join(",") } });
      const res = await callMany(token, reqs);
      needGrades.forEach((id, i) => { const items = res[i]?.data?.usergrades?.[0]?.gradeitems; if (items) gradeCache.set(gKey(id), { at: now, items }); });
      if (needPlans.length) {
        const pages = res[needGrades.length]?.data?.pages, summaries = res[needGrades.length + 1]?.data?.courses;
        if (pages) for (const id of needPlans) {
          const page = pages.filter((p) => p.course === id && p.visible !== 0 && plan.PLAN_PAGE.test(p.name))[0] || null;
          const summary = plan.pageText(summaries?.find((c) => c.id === id)?.summary || "");
          planCache.set(gKey(id), { at: now, text: [summary, page ? plan.pageText(page.content) : ""].filter(Boolean).join("\n"), cmid: page?.coursemodule ?? null, name: page?.name ?? null });
        }
      }
    } catch (e) {
      console.log(`moodle courseScores: ${String(e?.message || e).slice(0, 160)}`); // сбой, отказ, пауза, очередь — берём, что есть
    }
  }
  const out = new Map();
  for (const id of ids) {
    const g = gradeCache.get(gKey(id)), p = planCache.get(gKey(id));
    if (g || p) out.set(id, { items: g?.items ?? null, plan: p ?? null });
  }
  return out;
}

// Быстрый опрос тестов: один вызов API (курсы кэшируются на 30 мин по токену). Короткие тесты «в моменте» появляются
// внезапно, поэтому server.mjs зовёт это каждые 2 минуты, а полная синхронизация остаётся раз в 15 минут.
const courseCache = new Map(); // token → { at, info, courses }
async function coursesCached(token) {
  const c = courseCache.get(token);
  if (c && Date.now() - c.at < 30 * 60e3) return c;
  const info = { userid: await userIdOf(token) }; // номер пользователя спрашивается один раз на процесс
  const courses = await activeCourses(token, info.userid);
  const v = { at: Date.now(), info, courses };
  courseCache.set(token, v);
  return v;
}
export async function quizzesQuick(token) {
  const { courses } = await coursesCached(token);
  const out = { items: [], courses: courses.map((c) => ({ id: c.id, name: cleanCourse(c.fullname), short: shortName(cleanCourse(c.fullname)), auto: courseAuto(c).auto, debt: DEBT_COURSE.test(c.fullname) })) };
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
      opensAt: q.timeopen ? q.timeopen * 1000 : undefined, url: `${BASE}/mod/quiz/view.php?id=${q.coursemodule}`, status: "open",
      timeLimit: q.timelimit || 0, attempts: q.attempts || 0 }); // время на попытку (с) и число попыток — для сообщения «Тест открыт»
  }
  return out;
}
/**
 * Можно ли прямо сейчас начать попытку теста — так, как это видит сам студент в Moodle (правила доступа теста: время
 * открытия, число попыток и т. п.). До открытия Moodle отвечает причиной «В настоящее время этот тест недоступен».
 * itemIds — ["moodle:quiz:<id>"]. Возвращает Map: id → { ok, reasons }; тест, про который Moodle не ответил, в Map не попадает.
 * Один пакетный запрос на все тесты.
 */
export async function quizAccess(token, itemIds) {
  const ids = itemIds.map((id) => Number(String(id).split(":")[2])).filter(Boolean);
  const res = await callMany(token, ids.flatMap((q) => [{ fn: "mod_quiz_get_quiz_access_information", params: { quizid: q } }, { fn: "mod_quiz_get_attempt_access_information", params: { quizid: q, attemptid: 0 } }]));
  const out = new Map();
  ids.forEach((q, i) => {
    const a = res[2 * i], b = res[2 * i + 1];
    if (a.error) return;
    const reasons = [...(a.data.preventaccessreasons || []), ...(b.error ? [] : b.data.preventnewattemptreasons || [])].map(String);
    out.set(`moodle:quiz:${q}`, { ok: !reasons.length && a.data.canattempt !== false, reasons });
  });
  return out;
}
