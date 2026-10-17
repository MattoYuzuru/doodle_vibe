// Объявления преподавателей и новые материалы курсов → сообщения бота (просьба владельца, 4 окт 2026).
// До этого бот сообщал только о новых заданиях и тестах: объявление в форуме «Объявления» («занятие 25.09 переносится»)
// и выложенную методичку студент видел, только зайдя в Moodle. Всё здесь — чтение Moodle токеном самого пользователя.
//
// Объявления: форумы типа «news» активных курсов (один запрос на все курсы), темы — только там, где они есть.
// Материалы: лёгкий запрос «что изменилось в курсе с прошлой проверки» (core_course_get_updates_since); только если
// что-то изменилось — список модулей курса без файлов. Новое — модуль, которого раньше не видели (в том числе открытый
// из скрытых); «обновлён файл» — у знакомого модуля заменили файл. Задания и тесты пропускаем: о них пишет notify.check.
//
// Первая проверка курса только запоминает, что в нём есть. Что уже видели — в notify/<tgId>.json (поля news, materials).
import { BASE } from "./users.mjs";
import * as moodle from "./moodle.mjs";
import * as notify from "./notify.mjs";

const NEWS_EVERY = Number(process.env.NEWS_EVERY_MS) || 10 * 60e3;       // объявления — раз в 10 минут (с 9 окт 2026, после курсовой)
const MATERIALS_EVERY = Number(process.env.MATERIALS_EVERY_MS) || 50e3;       // материалы — раз в минуту (было раз в час, до 15 окт 2026)
/*
 * Общая проверка курса (15 окт 2026). У одногруппников одни и те же курсы: на 7 человек 51 пара «человек × курс», а
 * разных курсов 15. «Что изменилось с момента T» спрашивает один пользователь, и результат «изменений нет» до минуты
 * годится всем студентам курса, чьи прошлые проверки не раньше T. Нашлись изменения — каждый смотрит курс сам (видимость
 * модулей у всех своя). Модуль, видимый только части группы, общая проверка чужим токеном не заметит — поэтому раз в
 * MATERIALS_OWN_EVERY каждый проверяет каждый свой курс сам.
 */
const MATERIALS_OWN_EVERY_S = (Number(process.env.MATERIALS_OWN_EVERY_MS) || 15 * 60e3) / 1000;
const SHARED_FRESH_S = 60;
const probes = new Map(); // courseId → { from, to } (с): в курсе не было изменений с from по to
/*
 * «Тихие» курсы — для опроса тестов (15 окт 2026, решение владельца: спрашивать тесты только там, где курс менялся).
 * Каждый ответ «изменений нет» за [since, сейчас] продлевает известный тихий промежуток курса; найденное изменение его
 * стирает. Новый тест или изменённые сроки теста — это изменение модуля курса, и проверка материалов (раз в ~50 с у
 * каждого, общая на курс — раз в минуту) его видит. Опрос тестов человека (server.mjs quickTick) в Moodle не идёт, если
 * все его курсы тихие с прошлого настоящего опроса; раз в QUICK_FULL_EVERY он всё равно спрашивает (тест, открытый
 * только другой группе курса, или ставший доступным по дате, изменением модуля не виден).
 */
const quietOf = new Map(); // courseId → { from, to } (с)
function noteQuiet(courseId, from, to) {
  const q = quietOf.get(courseId);
  if (q && from <= q.to) { q.from = Math.min(q.from, from); q.to = Math.max(q.to, to); }
  else quietOf.set(courseId, { from, to }); // промежутки не соприкасаются — о времени между ними ничего не известно
}
/** Не менялся ли ни один модуль этих курсов с момента fromS (с) по последние freshS секунд. */
export function quietSince(courseIds, fromS, { freshS = 120, nowS = Math.floor(Date.now() / 1000) } = {}) {
  return courseIds.length > 0 && courseIds.every((id) => { const q = quietOf.get(Number(id)); return !!q && q.from <= fromS && nowS - q.to <= freshS; });
}
/*
 * Курс изменился — сначала его студенты (17 окт 2026, нагрузка на VPS: при 300 людях «Новый материал» не дошёл за
 * 5 минут). Изменение находит проверка одного человека, а остальные студенты курса ждали своей очереди в обходе по всем
 * людям. Теперь найденное изменение запоминается (changedAt), и обход материалов (server.mjs materialsTick) следующими
 * берёт тех, кто этот курс после изменения ещё не проверял (needsCheck), — без обычной паузы MATERIALS_EVERY.
 * Только в памяти: после перезапуска обход идёт как обычно.
 */
const changedAt = new Map(); // courseId → когда (с) проверка нашла изменения
const checkedAt = new Map(); // tgId → начало последней проверки материалов (с)
const CHANGED_KEEP_S = 30 * 60;
/** Есть ли в этих курсах изменение, найденное после последней проверки материалов этого человека. */
export function needsCheck(tgId, courseIds) {
  const mine = checkedAt.get(tgId) || 0, nowS = Math.floor(Date.now() / 1000);
  return courseIds.some((id) => { const t = changedAt.get(Number(id)); return !!t && t > mine && nowS - t < CHANGED_KEEP_S; });
}
const FRESH_MS = 7 * 86400e3;   // о темах старше недели не пишем (защита от пачки при сбросе состояния)
const MAX_PER_FORUM = 3;        // больше трёх новых тем разом — три последние и «ещё N»
const MAX_ITEMS = 8;            // больше восьми новых материалов в курсе — первые восемь и «ещё N»
const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const when = (ms) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${Number(p.day)} ${MONTHS[p.month - 1]}, ${p.hour}:${p.minute}`;
};
/** «Жердев Алексей Александрович» → «Жердев А. А.» */
const shortFio = (name) => { const w = String(name || "").trim().split(/\s+/); return w.length > 1 ? `${w[0]} ${w.slice(1, 3).map((x) => `${x[0]}.`).join(" ")}` : w[0] || ""; };
const KIND = { resource: "файл", folder: "папка", url: "ссылка", page: "страница", book: "книга", lesson: "лекция", h5pactivity: "интерактив", hvp: "интерактив", workshop: "семинар",
  glossary: "глоссарий", choice: "опрос", feedback: "анкета", scorm: "пакет SCORM", lti: "внешний инструмент", data: "база данных", wiki: "вики", forum: "форум", assign: "задание без срока", bigbluebuttonbn: "видеовстреча", attendance: "посещаемость" };
const cut = (t, n) => (t.length > n ? `${t.slice(0, n).replace(/\s+\S*$/, "")}…` : t);
const ids = (courses) => { const p = {}; courses.forEach((c, i) => (p[`courseids[${i}]`] = c.id)); return p; };

/*
 * Разослать сообщения и вернуть записанное для тех, что не дошли (15 окт 2026, баг «отметка „отправлено“ ставится до
 * отправки»). Виденное по-прежнему записывается под замком ДО отправки — так одновременная проверка не пришлёт дубль, а
 * перезапуск посреди рассылки не повторит уже ушедшие. Но сообщение, не ушедшее из-за временного сбоя (сеть, 5xx, 429),
 * раньше терялось навсегда; теперь вторым withState для него снимается записанное (revert) — следующая проверка пришлёт
 * его снова. Попыток не больше notify.retryExhausted (постоянная ошибка не крутится бесконечно). m: { key, text, url }.
 * Возвращает число дошедших.
 */
const QUIET = { status: "quiet", ok: false, retryable: false };
async function sendAll(tgId, out, revert, courses = null) {
  const done = [], failed = [];
  let n = 0;
  for (const m of out) {
    // В беседы, где человек — источник уведомлений (chats.mjs): раньше личной отправки; ключ — защита от повтора.
    // relayText === null — в сообщении нет ничего, что видно всей группе (см. forAll): в беседу не идёт.
    if (m.relayText !== null) await notify.relay(tgId, { key: m.relayKey || m.key, text: m.relayText ?? m.text, url: m.url, ttl: m.ttl, courseIds: m.courseIds, courses });
    // У самого человека эти уведомления выключены — собрано только для беседы, ему не шлём.
    if (m.quiet) { done.push({ m, r: QUIET }); continue; }
    const r = await notify.deliver(tgId, m.text, undefined, await notify.buttonsFor({ url: m.url }));
    if (r.ok) n++;
    (notify.settled(r) ? done : failed).push({ m, r });
  }
  // Ничего не поменялось (всё дошло, счётчиков попыток нет) — withState файл не пишет.
  if (out.length) await notify.withState(tgId, (s) => {
    for (const { m } of done) notify.retryClear(s, m.key);
    for (const { m, r } of failed) if (!notify.retryExhausted(s, m.key, r)) revert(s, m);
  });
  return n;
}

/**
 * Новые объявления. courses — [{ id, short }] активных курсов. Возвращает число отправленных сообщений.
 * mute — пользователь отключил эти уведомления: состояние всё равно обновляется, чтобы при включении не пришла пачка.
 */
export async function checkNews(tgId, token, courses, { mute = false } = {}) {
  if (!courses.length) return 0;
  // Только прочитать (peekState, без записи): раньше этот снимок шёл через withState и переписывал файл каждый раз.
  const snap = { at: (await notify.peekState(tgId)).news?.at || 0 };
  if (Date.now() - snap.at < NEWS_EVERY) return 0;
  const forums = (await moodle.call(token, "mod_forum_get_forums_by_courses", ids(courses))).filter((f) => f.type === "news");
  const found = new Map(); // forumId → темы (свежие первыми)
  for (const f of forums) {
    if (!Number(f.numdiscussions)) { found.set(f.id, []); continue; }
    const d = await moodle.call(token, "mod_forum_get_forum_discussions", { forumid: f.id, sortorder: -1, page: 0, perpage: 10 }).catch(() => null);
    if (d?.discussions) found.set(f.id, d.discussions);
  }
  const short = new Map(courses.map((c) => [c.id, c.short || c.name]));
  const out = [];
  // Объявления у человека выключены, но он источник уведомлений беседы — собираем для неё (quiet: ему не шлём).
  const relay = mute && await notify.isRelaySource(tgId);
  await notify.withState(tgId, (s) => {
    s.news ??= { forums: {} };
    s.news.forums ??= {};
    s.news.at = Date.now();
    for (const f of forums) {
      const list = found.get(f.id);
      if (!list) continue; // форум не ответил — в следующий раз
      const key = String(f.id), known = s.news.forums[key];
      const seen = new Set(known?.seen || []);
      const fresh = known ? list.filter((x) => !seen.has(x.discussion) && (x.created || x.timemodified || 0) * 1000 > Date.now() - FRESH_MS) : []; // первый раз — только запоминаем
      s.news.forums[key] = { seen: [...new Set([...seen, ...list.map((x) => x.discussion)])].slice(-200) };
      if ((mute && !relay) || !fresh.length) continue;
      fresh.sort((a, b) => (a.created || 0) - (b.created || 0));
      const shown = fresh.slice(-MAX_PER_FORUM);
      shown.forEach((x, i) => {
        const text = cut(moodle.stripHtml(x.message || "").replace(/\n{2,}/g, "\n"), 700);
        const last = i === shown.length - 1, more = last && fresh.length > shown.length ? `\n\nИ ещё ${fresh.length - shown.length} более ранних — в «Объявлениях» курса.` : "";
        out.push({
          text: `📣 Объявление · ${short.get(f.course) ?? "курс"}\n${String(x.name || x.subject || "").trim()}\n${[shortFio(x.userfullname), x.created ? when(x.created * 1000) : ""].filter(Boolean).join(" · ")}${text ? `\n«${text}»` : ""}${more}`,
          url: `${BASE}/mod/forum/discuss.php?d=${x.discussion}`,
          // Что снять из виденного, если сообщение не уйдёт: свою тему, а у последнего («и ещё N») — и более ранние.
          // Тема только для одной группы курса (groupid > 0: «Подгруппа 2», «Должники») — не всей беседе: relayText null.
          key: `news:${x.discussion}`, courseIds: [f.course], ...(Number(x.groupid) > 0 ? { relayText: null } : {}), quiet: mute, forum: key, ids: last ? [...fresh.slice(0, fresh.length - shown.length).map((y) => y.discussion), x.discussion] : [x.discussion],
        });
      });
    }
  });
  return sendAll(tgId, out, (s, m) => { const f = s.news?.forums?.[m.forum]; if (Array.isArray(f?.seen)) f.seen = f.seen.filter((id) => !m.ids.includes(id)); }, courses);
}

const line = (m) => `• ${cut(String(m.name).trim(), 90)}${KIND[m.modname] ? ` (${KIND[m.modname]})` : ""}${m.section ? ` — ${cut(m.section, 50)}` : ""}`;
/**
 * Текст о новых (added) и обновлённых (changed) модулях курса c; нечего сказать — "". Задания без срока (лабораторная,
 * выложенная без даты сдачи, и т. п.) — не «материал», а работа: отдельной строкой сверху (16 окт 2026, владелец:
 * «уведомления о появлении новых лабораторных, материалах и других работ»). Задания со сроком сюда не попадают — о них
 * пишет проверка работ (skipCmids).
 */
function describe(c, added, changed) {
  const lines = [];
  const works = added.filter((m) => m.modname === "assign" || m.modname === "workshop"), mats = added.filter((m) => !works.includes(m));
  if (works.length) lines.push(`🆕 ${works.length === 1 ? "Новое задание" : `Новые задания (${works.length})`} · ${c.short || c.name}`, ...works.slice(0, MAX_ITEMS).map(line), works.length > MAX_ITEMS ? `…и ещё ${works.length - MAX_ITEMS}` : "");
  if (mats.length) lines.push(`${works.length ? "\n" : ""}📎 ${mats.length === 1 ? "Новый материал" : `Новые материалы (${mats.length})`}${works.length ? "" : ` · ${c.short || c.name}`}`, ...mats.slice(0, MAX_ITEMS).map(line), mats.length > MAX_ITEMS ? `…и ещё ${mats.length - MAX_ITEMS}` : "");
  if (changed.length) lines.push(`${added.length ? "\n" : ""}🔄 ${changed.length === 1 ? "Обновлён файл" : "Обновлены файлы"}${added.length ? "" : ` · ${c.short || c.name}`}`, ...changed.slice(0, MAX_ITEMS).map(line));
  return lines.filter(Boolean).join("\n");
}
/**
 * Модуль виден всей группе — можно в общую беседу. Ограничение доступа, кроме даты (группа курса, оценка, «должникам»),
 * и разделы для должников и пересдач — личное: по такому модулю беседа узнала бы, в какой группе курса человек или что
 * у него долг. Ограничение не разобралось — тоже личное.
 */
function forAll(m) {
  if (/должник|пересда|задолж|ликвидац/i.test(`${m.name} ${m.section}`)) return false;
  if (!m.availability) return true;
  try { const a = JSON.parse(m.availability); return Array.isArray(a?.c) && a.c.every((x) => x?.type === "date"); } catch { return false; }
}
/**
 * Новые и обновлённые материалы курсов. skipCmids — модули, о которых уже сообщает проверка работ (задания со сроком).
 * Возвращает число отправленных сообщений (по одному на курс).
 */
export async function checkMaterials(tgId, token, courses, { mute = false, skipCmids = new Set() } = {}) {
  if (!courses.length) return 0;
  // Только прочитать (peekState, без записи): проверка идёт каждые ~50 с у каждого, и раньше каждый раз переписывала файл.
  const st0 = await notify.peekState(tgId);
  const snap = { at: st0.materials?.at || 0, courses: { ...(st0.materials?.courses || {}) } };
  // В курсе человека найдено изменение, которого он ещё не видел, — проверяем сразу, не дожидаясь обычного срока.
  if (Date.now() - snap.at < MATERIALS_EVERY && !needsCheck(tgId, courses.map((c) => c.id))) return 0;
  const nowS = Math.floor(Date.now() / 1000);
  const got = new Map(); // courseId → { sections, updated: Set<cmid с заменённым файлом> } | { same: true }
  // Запросы — пакетами (moodle.callMany, 15 окт 2026): «что изменилось» по всем курсам человека одним запросом, списки
  // модулей новых и изменившихся курсов — вторым. Раньше по запросу на курс: проверка материалов давала две трети всех
  // фоновых запросов к Moodle. Курс не ответил — его в следующий раз, отметку времени не двигаем; пауза Moodle — наверх.
  const many = async (reqs) => {
    try { return await moodle.callMany(token, reqs); }
    catch (e) { if (e?.name === "PausedError") throw e; return reqs.map(() => ({ error: e })); }
  };
  const probe = [], since = new Map(), contents = [];
  for (const c of courses) {
    const known = snap.courses[String(c.id)];
    if (!known) { contents.push({ c, updated: new Set() }); continue; } // первая проверка курса — сразу список модулей
    // С запасом в минуту назад: изменение, сделанное во время прошлой проверки, не должно потеряться.
    const s = Math.max(0, (known.at || 0) - 60);
    const p = probes.get(c.id);
    // Берём только более свежую проверку одногруппника (p.to > known.at): свою прошлую проверку повторяем сами.
    if (p && p.from <= s && p.to > (known.at || 0) && nowS - p.to < SHARED_FRESH_S && nowS - (known.own || 0) < MATERIALS_OWN_EVERY_S) { got.set(c.id, { same: true, at: p.to }); continue; }
    probe.push(c); since.set(c.id, s);
  }
  if (probe.length) {
    const res = await many(probe.map((c) => ({ fn: "core_course_get_updates_since", params: { courseid: c.id, since: since.get(c.id) } })));
    probe.forEach((c, i) => {
      if (res[i]?.error || !res[i]) return;
      const inst = (res[i].data?.instances || []).filter((x) => x.contextlevel === "module");
      if (!inst.length) { probes.set(c.id, { from: since.get(c.id), to: nowS }); noteQuiet(c.id, since.get(c.id), nowS); got.set(c.id, { same: true, at: nowS, own: true }); return; }
      probes.delete(c.id); quietOf.delete(c.id);
      if ((changedAt.get(c.id) || 0) < nowS) changedAt.set(c.id, nowS);
      contents.push({ c, updated: new Set(inst.filter((x) => (x.updates || []).some((u) => u.name === "contentfiles")).map((x) => x.id)) });
    });
  }
  if (contents.length) {
    const res = await many(contents.map(({ c }) => ({ fn: "core_course_get_contents", params: { courseid: c.id, options: [{ name: "excludecontents", value: "1" }] } })));
    contents.forEach(({ c, updated }, i) => { const sections = res[i]?.data; if (!res[i]?.error && Array.isArray(sections)) got.set(c.id, { sections, updated }); });
  }
  const out = [];
  const relay = mute && await notify.isRelaySource(tgId); // как у объявлений: выключено у человека, но нужно беседе
  // Проверка дошла до ответов Moodle — изменения, найденные до её начала, этот человек увидел (needsCheck).
  checkedAt.set(tgId, nowS);
  await notify.withState(tgId, (s) => {
    s.materials ??= { courses: {} };
    s.materials.courses ??= {};
    s.materials.at = Date.now();
    for (const c of courses) {
      const g = got.get(c.id), key = String(c.id), known = s.materials.courses[key];
      if (!g) continue;
      if (g.same) { if (known) { known.at = Math.max(known.at || 0, g.at); if (g.own) known.own = nowS; } continue; }
      const mods = g.sections.flatMap((sec) => (sec.modules || []).filter((m) => m.uservisible !== false && m.visible !== 0).map((m) => ({ ...m, section: String(sec.name || "").trim() })));
      const seen = new Set(known?.ids || []);
      s.materials.courses[key] = { at: nowS, own: nowS, ids: mods.map((m) => m.id) };
      if (!known || (mute && !relay)) continue; // первая проверка курса — только запоминаем
      const worth = (m) => !["label", "quiz"].includes(m.modname) && !skipCmids.has(m.id) && !(m.modname === "forum" && /объявлен|новост|announce|news/i.test(m.name));
      const added = mods.filter((m) => !seen.has(m.id) && worth(m));
      const changed = mods.filter((m) => seen.has(m.id) && g.updated.has(m.id) && ["resource", "folder"].includes(m.modname));
      if (!added.length && !changed.length) continue;
      const one = added.length + changed.length === 1 ? (added[0] || changed[0]) : null;
      // Не уйдёт — у курса вернётся прежняя запись (ids и at): следующая проверка снова спросит «что изменилось» с
      // прежнего времени и пересчитает новые и обновлённые модули.
      const text = describe(c, added, changed);
      // Беседе (chats.mjs) — только то, что видно всей группе (forAll); ничего такого нет — null, не пересылается. Ключ
      // «mat:<курс>» у курса один на все сообщения — беседе свой, по тексту: тот же текст (повтор после сбоя) в течение
      // 12 ч она второй раз не получит, позже (файл обновили ещё раз) — получит.
      const relayText = describe(c, added.filter(forAll), changed.filter(forAll)) || null;
      out.push({ text, url: one?.url || `${BASE}/course/view.php?id=${c.id}`, key: `mat:${c.id}`, relayText, relayKey: relayText && `mat:${c.id}:${notify.hashOf(relayText)}`, ttl: 12 * 3600e3,
        courseIds: [c.id], quiet: mute, course: key, prev: known, at: nowS });
    }
  });
  return sendAll(tgId, out, (s, m) => { const cs = s.materials?.courses; if (cs?.[m.course]?.at === m.at) cs[m.course] = m.prev; }, courses);
}
