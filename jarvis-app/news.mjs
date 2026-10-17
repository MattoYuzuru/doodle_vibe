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

const NEWS_EVERY = Number(process.env.NEWS_EVERY_MS) || 30 * 60e3;       // объявления — раз в полчаса
const MATERIALS_EVERY = Number(process.env.MATERIALS_EVERY_MS) || 60 * 60e3; // материалы — раз в час
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

/**
 * Новые объявления. courses — [{ id, short }] активных курсов. Возвращает число отправленных сообщений.
 * mute — пользователь отключил эти уведомления: состояние всё равно обновляется, чтобы при включении не пришла пачка.
 */
export async function checkNews(tgId, token, courses, { mute = false } = {}) {
  if (!courses.length) return 0;
  const snap = await notify.withState(tgId, (s) => ({ at: s.news?.at || 0, forums: { ...(s.news?.forums || {}) } }));
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
      if (mute || !fresh.length) continue;
      fresh.sort((a, b) => (a.created || 0) - (b.created || 0));
      const shown = fresh.slice(-MAX_PER_FORUM);
      shown.forEach((x, i) => {
        const text = cut(moodle.stripHtml(x.message || "").replace(/\n{2,}/g, "\n"), 700);
        const more = i === shown.length - 1 && fresh.length > shown.length ? `\n\nИ ещё ${fresh.length - shown.length} более ранних — в «Объявлениях» курса.` : "";
        out.push({
          text: `📣 Объявление · ${short.get(f.course) ?? "курс"}\n${String(x.name || x.subject || "").trim()}\n${[shortFio(x.userfullname), x.created ? when(x.created * 1000) : ""].filter(Boolean).join(" · ")}${text ? `\n«${text}»` : ""}${more}`,
          url: `${BASE}/mod/forum/discuss.php?d=${x.discussion}`,
        });
      });
    }
  });
  for (const m of out) await notify.send(tgId, m.text, undefined, await notify.buttonsFor({ url: m.url }));
  return out.length;
}

/**
 * Новые и обновлённые материалы курсов. skipCmids — модули, о которых уже сообщает проверка работ (задания со сроком).
 * Возвращает число отправленных сообщений (по одному на курс).
 */
export async function checkMaterials(tgId, token, courses, { mute = false, skipCmids = new Set() } = {}) {
  if (!courses.length) return 0;
  const snap = await notify.withState(tgId, (s) => ({ at: s.materials?.at || 0, courses: { ...(s.materials?.courses || {}) } }));
  if (Date.now() - snap.at < MATERIALS_EVERY) return 0;
  const nowS = Math.floor(Date.now() / 1000);
  const got = new Map(); // courseId → { sections, updated: Set<cmid с заменённым файлом> } | { same: true }
  for (const c of courses) {
    const known = snap.courses[String(c.id)];
    try {
      let updated = new Set();
      if (known) {
        // С запасом в минуту назад: изменение, сделанное во время прошлой проверки, не должно потеряться.
        const u = await moodle.call(token, "core_course_get_updates_since", { courseid: c.id, since: Math.max(0, (known.at || 0) - 60) });
        const inst = (u.instances || []).filter((i) => i.contextlevel === "module");
        if (!inst.length) { got.set(c.id, { same: true }); continue; }
        updated = new Set(inst.filter((i) => (i.updates || []).some((x) => x.name === "contentfiles")).map((i) => i.id));
      }
      const sections = await moodle.call(token, "core_course_get_contents", { courseid: c.id, "options[0][name]": "excludecontents", "options[0][value]": 1 });
      if (Array.isArray(sections)) got.set(c.id, { sections, updated });
    } catch { /* курс не ответил — в следующий раз, отметку времени не двигаем */ }
  }
  const out = [];
  await notify.withState(tgId, (s) => {
    s.materials ??= { courses: {} };
    s.materials.courses ??= {};
    s.materials.at = Date.now();
    for (const c of courses) {
      const g = got.get(c.id), key = String(c.id), known = s.materials.courses[key];
      if (!g) continue;
      if (g.same) { if (known) known.at = nowS; continue; }
      const mods = g.sections.flatMap((sec) => (sec.modules || []).filter((m) => m.uservisible !== false && m.visible !== 0).map((m) => ({ ...m, section: String(sec.name || "").trim() })));
      const seen = new Set(known?.ids || []);
      s.materials.courses[key] = { at: nowS, ids: mods.map((m) => m.id) };
      if (!known || mute) continue; // первая проверка курса — только запоминаем
      const worth = (m) => !["label", "quiz"].includes(m.modname) && !skipCmids.has(m.id) && !(m.modname === "forum" && /объявлен|новост|announce|news/i.test(m.name));
      const added = mods.filter((m) => !seen.has(m.id) && worth(m));
      const changed = mods.filter((m) => seen.has(m.id) && g.updated.has(m.id) && ["resource", "folder"].includes(m.modname));
      if (!added.length && !changed.length) continue;
      const line = (m) => `• ${cut(String(m.name).trim(), 90)}${KIND[m.modname] ? ` (${KIND[m.modname]})` : ""}${m.section ? ` — ${cut(m.section, 50)}` : ""}`;
      const lines = [];
      if (added.length) lines.push(`📎 ${added.length === 1 ? "Новый материал" : `Новые материалы (${added.length})`} · ${c.short || c.name}`, ...added.slice(0, MAX_ITEMS).map(line), added.length > MAX_ITEMS ? `…и ещё ${added.length - MAX_ITEMS}` : "");
      if (changed.length) lines.push(`${added.length ? "\n" : ""}🔄 ${changed.length === 1 ? "Обновлён файл" : "Обновлены файлы"}${added.length ? "" : ` · ${c.short || c.name}`}`, ...changed.slice(0, MAX_ITEMS).map(line));
      const one = added.length + changed.length === 1 ? (added[0] || changed[0]) : null;
      out.push({ text: lines.filter(Boolean).join("\n"), url: one?.url || `${BASE}/course/view.php?id=${c.id}` });
    }
  });
  for (const m of out) await notify.send(tgId, m.text, undefined, await notify.buttonsFor({ url: m.url }));
  return out.length;
}
