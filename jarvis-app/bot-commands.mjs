// Быстрые команды в чате бота (просьба владельца, 5 окт 2026). Ответ собирает сам сервер из уже загруженных данных:
// нейросеть не используется; дедлайны берутся из тех, что сервер и так читает раз в полчаса (в Moodle идём, только если
// у сервера данных ещё нет вовсе, — как при открытии приложения).
//   /today — пары на сегодня (/pairs — прежнее имя)   /tomorrow, /week — расписание
//   /deadlines — работы на неделю                   /grades — оценки по работам
//   /journal — посещаемость и баллы                 /settings, /stop — уведомления
//   /session — сессия: даты, формы контроля, экзамены, долги (admission.mjs)
//   /digest — утренняя сводка (время или выключить)
//   /invite — ссылка-приглашение                    /terms, /privacy — документы
//   /stats — сводка для владельца
import * as admission from "./admission.mjs";
import * as attendance from "./attendance.mjs";
import * as bots from "./bots.mjs";
import * as botStats from "./bot-stats.mjs";
import * as ej from "./ej.mjs";
import * as moodle from "./moodle.mjs";
import * as pace from "./moodle-pace.mjs";
import * as notify from "./notify.mjs";
import { schedule } from "./schedule.mjs";
import { PRIVACY, TERMS } from "./terms.mjs";
import * as users from "./users.mjs";

const DAY = 86400e3, TZ = "Europe/Moscow";
const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const DAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const parts = (ms) => Object.fromEntries(new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, year: "numeric", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" })
  .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
const isoDay = (ms) => new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(new Date(ms)); // 2026-10-05
// Срок 00:00 показываем как 23:59 накануне (как в приложении и в напоминаниях).
const effective = (ms) => { const p = parts(ms); return p.hour === "00" && p.minute === "00" ? ms - 60e3 : ms; };
const when = (ms) => { const p = parts(effective(ms)); return `${p.weekday}, ${Number(p.day)} ${MONTHS[p.month - 1]}, ${p.hour}:${p.minute}`; };
const left = (ms) => { const d = effective(ms) - Date.now(); return d < 3600e3 ? `${Math.max(1, Math.round(d / 60e3))} мин` : d < 2 * DAY ? `${Math.round(d / 3600e3)} ч` : `${Math.floor(d / DAY)} дн`; };
const cut = (t, n = 70) => (t.length > n ? t.slice(0, n - 3).trimEnd() + "…" : t); // длинные названия не должны занимать пол-экрана
const mark = (x) => (x.kind === "test" ? "📝" : x.kind === "coursework" ? "📚" : x.kind === "exam" ? "🎓" : "📋");
const num = (n) => String(Math.round(n * 100) / 100).replace(".", ",");

/** Дедлайны человека: уже загруженные сервером; если их нет совсем — одно обычное чтение. null — в Moodle не вошёл. */
async function data(tgId) {
  const token = await users.moodleToken(tgId);
  if (!token) return null;
  const have = moodle.staleDeadlines(token);
  if (have) return have;
  moodle.setOverrides(token, await users.courseOverrides(tgId));
  return moodle.deadlines(token);
}
const NEED_LOGIN = "Сначала войдите в Moodle в приложении — кнопка «Открыть Doodle» ниже. После входа команды заработают.";
const NEED_GROUP = "Группа не выбрана — укажите её в приложении: Профиль → группа.";
const open = (x) => x.status === "open" && x.due && effective(x.due) > Date.now();
const line = (x, short) => `${mark(x)} ${cut(x.title)}${short.get(x.courseId) ? ` · ${short.get(x.courseId)}` : ""}\n     до ${when(x.due)} · осталось ${left(x.due)}`;

// --- расписание ---
// Ответ на день — блоком на пару (просьба владельца, 16 окт 2026): номер и время, предмет с видом занятия, кто на паре
// («БИСТ-24-ПО-2 [1], БИСТ-24-ПО-2 [2]»), преподаватель, аудитория; пустые строки блока не пишем. Номер — по началу пары
// в звонках МИСИС; пара в нестандартное время (перенос) — только время.
const SLOTS = ["09:00", "10:50", "12:40", "14:30", "16:20", "18:00", "19:35"];
const lessonBlock = (l) => {
  const n = SLOTS.indexOf(l.start) + 1, time = `${l.start} — ${l.end}`;
  return [n ? `${n} пара (${time})` : time, `${l.name}${l.typeLabel ? ` (${l.typeLabel})` : ""}`, l.groups, l.teacher, l.place].filter(Boolean).join("\n");
};
/**
 * Пары по дням: Map «дата → пары своей подгруппы»; null — группа не выбрана; "down" — расписание не загрузилось.
 * who — номер человека (его группа и подгруппа из профиля) или { group, subgroup } беседы (chats.mjs); subgroup null —
 * пары всех подгрупп. Одна и та же пара у нескольких подгрупп (время, предмет, вид, аудитория) — одной записью: subs —
 * её подгруппы ([] — вся группа), groups — строка «кто на паре», teacher — преподаватели через запятую.
 */
async function lessonsByDay(who) {
  const prof = typeof who === "object" ? who : await users.profile(who);
  if (!prof.group) return null;
  const s = await schedule(prof.group).catch(() => null);
  if (!s) return "down";
  const sub = typeof who === "object" ? prof.subgroup : prof.subgroup || "1", map = new Map();
  // Подгруппы группы: номера идут с 1 — видна только «2» (у первой в эти недели отдельных пар нет) → всё равно 1 и 2.
  const seen = [...new Set((s.lessons || []).map((l) => l.subgroup).filter(Boolean))].sort();
  const all = seen.every((x) => /^\d+$/.test(x)) && seen.length ? Array.from({ length: Math.max(...seen.map(Number)) }, (_, i) => String(i + 1)) : seen;
  for (const l of s.lessons || []) {
    if ((sub && l.subgroup && l.subgroup !== sub) || l.change === "removed") continue; // чужая подгруппа; отменённая пара
    if (!map.has(l.date)) map.set(l.date, []);
    const list = map.get(l.date), twin = list.find((x) => x.start === l.start && x.end === l.end && x.name === l.name && x.typeLabel === l.typeLabel && x.place === l.place);
    if (!twin) { list.push({ ...l, subs: l.subgroup ? [l.subgroup] : [], teachers: [l.teacher] }); continue; }
    twin.subs = !twin.subs.length || !l.subgroup ? [] : [...new Set([...twin.subs, l.subgroup])].sort();
    twin.teachers.push(l.teacher);
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.start.localeCompare(b.start));
    for (const l of list) {
      l.groups = (l.subs.length ? l.subs : all).map((x) => `${prof.group} [${x}]`).join(", ") || prof.group;
      l.teacher = [...new Set(l.teachers.filter(Boolean))].join(", ");
      // В неделе беседы (все подгруппы) подгруппу видно только по названию — пометка, если пара не у всех.
      l.short = !sub && l.subs.length && l.subs.length < all.length ? `${l.name} (подгр. ${l.subs.join(", ")})` : l.name;
    }
  }
  map.last = (s.lessons || []).reduce((m, l) => (l.date > m ? l.date : m), ""); // по какой день расписание известно
  return map;
}
const dayTitle = (ms) => { const p = parts(ms); return `${p.weekday} ${Number(p.day)} ${MONTHS[p.month - 1]}`; };
async function dayLessons(tgId, ms, label) {
  const map = await lessonsByDay(tgId);
  const head = `📅 ${label}, ${dayTitle(ms)}`;
  if (map === null) return `${head}\n${NEED_GROUP}`;
  if (map === "down") return `${head}\nРасписание сейчас не загрузилось — попробуйте чуть позже.`;
  const list = map.get(isoDay(ms)) || [];
  return `${head}\n${list.length ? `\n${list.map(lessonBlock).join("\n\n")}` : isoDay(ms) > map.last ? "Расписание на этот день ещё не опубликовано." : "Пар нет."}`;
}
const pairs = (tgId) => dayLessons(tgId, Date.now(), "Сегодня");
const tomorrow = (tgId) => dayLessons(tgId, Date.now() + DAY, "Завтра");
async function week(tgId) {
  const map = await lessonsByDay(tgId);
  if (map === null) return NEED_GROUP;
  if (map === "down") return "Расписание сейчас не загрузилось — попробуйте чуть позже.";
  const out = ["🗓 Расписание на 7 дней"];
  for (let i = 0; i < 7; i++) {
    const ms = Date.now() + i * DAY, list = map.get(isoDay(ms)) || [];
    if (!list.length) continue;
    const name = DAYS[new Date(`${isoDay(ms)}T12:00:00Z`).getUTCDay()];
    out.push("", `${name[0].toUpperCase()}${name.slice(1)}, ${Number(parts(ms).day)} ${MONTHS[parts(ms).month - 1]}`, ...list.map((l) => `${l.start}  ${cut(l.short, 40)}${l.place ? ` · ${l.place}` : ""}`));
  }
  return out.length > 1 ? out.join("\n") : "🗓 На ближайшие 7 дней пар нет.";
}
/** Расписание для беседы (chats.mjs): kind — pairs | tomorrow | week; chat — { group, subgroup }. */
export const scheduleText = (kind, chat) => (kind === "week" ? week(chat) : kind === "tomorrow" ? tomorrow(chat) : pairs(chat));

// --- работы и оценки ---
/** Утренняя сводка: пары на сегодня и ближайшие сроки (/today с 16 окт 2026 — только пары). */
async function digestText(tgId) {
  const out = [await pairs(tgId)];
  const d = await data(tgId);
  if (d) {
    const short = new Map(d.courses.map((c) => [c.id, c.short]));
    const soon = d.items.filter(open).sort((a, b) => a.due - b.due).slice(0, 3);
    out.push("", "⏳ Ближайшие сроки", soon.length ? soon.map((x) => line(x, short)).join("\n") : "Работ со сроком впереди нет.");
  } else out.push("", NEED_LOGIN);
  return out.join("\n");
}
async function deadlines(tgId) {
  const d = await data(tgId);
  if (!d) return NEED_LOGIN;
  const short = new Map(d.courses.map((c) => [c.id, c.short]));
  const all = d.items.filter(open).sort((a, b) => a.due - b.due);
  const soon = all.filter((x) => effective(x.due) - Date.now() <= 7 * DAY);
  if (!all.length) return "📋 Работ со сроком впереди нет.";
  if (!soon.length) return `📋 На ближайшую неделю сроков нет.\nСледующий:\n${line(all[0], short)}`;
  const shown = soon.slice(0, 15);
  return `📋 Сроки на неделю: ${soon.length}\n\n${shown.map((x) => line(x, short)).join("\n")}${soon.length > shown.length ? `\n…и ещё ${soon.length - shown.length} — в приложении.` : ""}${all.length > soon.length ? `\n\nПозже — ещё ${all.length - soon.length}.` : ""}`;
}
async function grades(tgId) {
  const d = await data(tgId);
  if (!d) return NEED_LOGIN;
  const short = new Map(d.courses.map((c) => [c.id, c.short]));
  // Даты выставления оценки Moodle не отдаёт — показываем оценённые работы от более поздних сроков к ранним.
  const graded = d.items.filter((x) => x.grade != null).sort((a, b) => b.due - a.due).slice(0, 12);
  if (!graded.length) return "📝 Оценённых работ пока нет.";
  return `📝 Оценки по работам (последние по сроку)\n\n${graded.map((x) => `${num(x.grade)}${x.gradeMax ? ` из ${num(x.gradeMax)}` : ""} — ${cut(x.title)}${short.get(x.courseId) ? ` · ${short.get(x.courseId)}` : ""}`).join("\n")}\n\nПосещаемость и баллы из журнала — команда /journal.`;
}
/**
 * Журнал: последние загруженные данные; если их нет — одна попытка загрузить (журнал подключается при входе в приложение).
 * Дисциплины, которые студент назвал не своими (в боте или в «Сессии», admission.journalView), — не в списке и не в
 * средних, а строкой ниже с кнопками «Вернуть» (ejj:<id>, 16 окт 2026).
 */
const pct = (v) => (v == null ? "—" : `${num(v)} %`);
// Баллы таблицы на часть дисциплины или без максимума — числом («баллы 12 из 30»), а не «—».
const ptsText = (s) => (s.raw ? `баллы ${num(s.raw.have)}${s.raw.scale ? ` из ${num(s.raw.scale)}` : ""}` : `${s.word} ${pct(s.rating)}`);
const attMark = (a) => (a != null && a < 50 ? "🔴" : a != null && a < 75 ? "🟡" : "🟢");
async function journal(tgId) {
  const { j, sh, notMine, list } = await journalData(tgId);
  const back = notMine.length ? {
    text: `\n\n🚫 Вы отметили как не ваши (в боте или в «Сессии») — в списке и средних их нет: ${notMine.map((s) => s.name).join("; ")}. Ошиблись — нажмите кнопку ниже, чтобы вернуть.`,
    buttons: notMine.slice(0, 8).map((s) => [{ text: `↩️ ${cut(s.name, 45)}`, callback_data: `ejj:${s.id}` }]),
  } : null;
  const out = (text) => (back ? { text: text + back.text, buttons: back.buttons } : text);
  if (!j?.subjects?.length && !sh.length) return out(notMine.length ? `📊 Журнал${j.semester ? ` · ${j.semester}` : ""}` : "📊 Данных журнала пока нет. Откройте вкладку «Журнал» в приложении — если журнал не подключён, там же его можно подключить.");
  const rows = list.slice(0, 14).map((s) => `${attMark(s.attendance)} ${cut(s.name, 34)}\n     посещаемость ${pct(s.attendance)} · ${ptsText(s)}${s.tag}`);
  const head = j?.subjects?.length ? `📊 Журнал${j.semester ? ` · ${j.semester}` : ""}\nВ среднем: посещаемость ${pct(j.summary?.attendance)}, рейтинг ${pct(j.summary?.rating)}${j.summary?.absences ? `, пропусков ${j.summary.absences}` : ""}` : "📊 Журнал · по таблицам преподавателей (электронный журнал не загружен)";
  return out(`${head}\n\n${rows.join("\n")}${sh.length ? "\n\n«таблица» — из таблиц преподавателей в курсах Moodle (своя строка — по ФИО и группе)." : ""}`);
}
/** Данные журнала для /journal (полного и короткого): list — дисциплины от худшей посещаемости к лучшей. */
async function journalData(tgId) {
  const j0 = ej.lastGood(tgId) || await ej.journal(tgId).catch(() => null);
  // Таблицы преподавателей в курсах Moodle (15 окт 2026): посещения и баллы по дисциплинам, о которых журнал не знает
  // (как во вкладке «Журнал»: у дисциплины журнала без отметок — из таблицы её курса, остальные — отдельно). Таблицы
  // «не моих» дисциплин не показываются.
  const [sh0, view] = await Promise.all([admission.journalSheets(tgId, j0, { live: true, waitMs: 8e3 }).catch(() => []),
    admission.journalView(tgId, j0).catch(() => ({ data: j0, off: new Map() }))]);
  const j = view.data, sh = sh0.filter((x) => !view.off.has(String(x.ejId)));
  const notMine = j?.notMine || [];
  const subs = j?.subjects || [], of = new Map(sh.filter((x) => x.ejId != null).map((x) => [x.ejId, x]));
  const list = subs.map((s) => {
    const x = of.get(s.id), att = !!x && !(s.lessons && s.lessons.present + s.lessons.absent > 0) && x.attendance != null;
    const pts = !!x && x.rating != null && !(s.works || []).some((w) => w.mark != null);
    const raw = !!x && x.rating == null && !!x.points && !(s.works || []).some((w) => w.mark != null) ? x.points : null;
    return { name: s.name, attendance: att ? x.attendance : s.attendance, rating: pts ? x.rating : s.rating, word: pts ? "баллы" : "рейтинг", raw, tag: att || pts || raw ? " · таблица" : "" };
  });
  for (const x of sh) if (!subs.some((s) => s.id === x.ejId)) list.push({ name: x.name, attendance: x.attendance, rating: x.rating, word: "баллы", raw: x.rating == null ? x.points : null, tag: " · таблица" });
  list.sort((a, b) => (a.attendance ?? 101) - (b.attendance ?? 101));
  return { j, sh, notMine, list };
}
/** /journal для правки того же сообщения после «Вернуть» (ejj:<id>): кнопок не осталось — убираются и у сообщения. */
const journalView = async (tgId) => { const r = await journal(tgId); return typeof r === "string" ? { text: r, buttons: [] } : r; };

// --- короткие ответы для беседы (16 окт 2026, владелец: «лаконичнее и покрасивее», вариант A) ---
// Ответ, который видит только автор (chats.mjs, эфемерные команды), — выжимка: заголовок, три главные строки, остальное
// в сворачиваемой цитате. Разметка HTML (имена работ и дисциплин экранируются). В личке — прежние полные ответы.
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const FOLD_MAX = 3000; // знаков в цитате: весь ответ должен остаться в 4096
function fold(lines) {
  const out = [];
  let n = 0;
  for (const l of lines) { if (n + l.length > FOLD_MAX) { out.push("…остальное — в личке"); break; } out.push(l); n += l.length + 1; }
  return out.length ? `\n<blockquote expandable>${out.join("\n")}</blockquote>` : "";
}
/** Срок коротко: «сегодня 18:00», «завтра 23:59», «вт 18:00» (в пределах недели), дальше — «19 окт». */
function shortWhen(ms) {
  const e = effective(ms), p = parts(e), t = `${p.hour}:${p.minute}`;
  if (isoDay(e) === isoDay(Date.now())) return `сегодня ${t}`;
  if (isoDay(e) === isoDay(Date.now() + DAY)) return `завтра ${t}`;
  return e - Date.now() < 6 * DAY ? `${p.weekday} ${t}` : `${Number(p.day)} ${MONTHS[p.month - 1]}`;
}
const course = (x, short) => (short.get(x.courseId) ? ` · ${esc(short.get(x.courseId))}` : "");
async function deadlinesShort(tgId) {
  const d = await data(tgId);
  if (!d) return { text: esc(NEED_LOGIN), more: "Открыть Doodle в личке" };
  const short = new Map(d.courses.map((c) => [c.id, c.short]));
  const all = d.items.filter(open).sort((a, b) => a.due - b.due), soon = all.filter((x) => effective(x.due) - Date.now() <= 7 * DAY);
  const row = (x) => `${effective(x.due) - Date.now() < DAY ? "🔥" : "⏳"} ${esc(cut(x.title, 40))}${course(x, short)} — ${shortWhen(x.due)}`;
  if (!all.length) return { text: "<b>🔒 Ваши сроки</b>\nРабот со сроком впереди нет." };
  if (!soon.length) return { text: `<b>🔒 Ваши сроки</b> · на неделю нет\nСледующий: ${row(all[0])}`, more: "Все сроки — в личке" };
  return { text: `<b>🔒 Ваши сроки</b> · ${soon.length} на неделю\n${soon.slice(0, 3).map(row).join("\n")}${fold(soon.slice(3).map(row))}`, more: "Все сроки — в личке" };
}
async function gradesShort(tgId) {
  const d = await data(tgId);
  if (!d) return { text: esc(NEED_LOGIN), more: "Открыть Doodle в личке" };
  const short = new Map(d.courses.map((c) => [c.id, c.short]));
  const graded = d.items.filter((x) => x.grade != null).sort((a, b) => b.due - a.due).slice(0, 15);
  if (!graded.length) return { text: "<b>🔒 Ваши оценки</b>\nОценённых работ пока нет." };
  const scaled = graded.filter((x) => x.gradeMax > 0);
  const avg = scaled.length ? Math.round(scaled.reduce((s, x) => s + (x.grade / x.gradeMax) * 100, 0) / scaled.length) : null;
  const row = (x) => `<b>${num(x.grade)}${x.gradeMax ? `/${num(x.gradeMax)}` : ""}</b> ${esc(cut(x.title, 40))}${course(x, short)}`;
  return { text: `<b>🔒 Ваши оценки</b>${avg != null ? ` · в среднем ${avg} %` : ""}\n${graded.slice(0, 3).map(row).join("\n")}${fold(graded.slice(3).map(row))}`, more: "Все оценки — в личке" };
}
async function journalShort(tgId) {
  const { j, notMine, list } = await journalData(tgId);
  const off = notMine.length ? `\n🚫 Не ваши: ${notMine.length} — вернуть можно в личке (/journal)` : "";
  if (!list.length) return { text: `<b>🔒 Ваш журнал</b>\n${notMine.length ? "Других дисциплин нет." : "Данных пока нет — откройте вкладку «Журнал» в Doodle."}${off}`, more: "Открыть Doodle в личке" };
  const head = j?.subjects?.length ? ` · посещаемость ${pct(j.summary?.attendance)}, рейтинг ${pct(j.summary?.rating)}` : "";
  const row = (s) => `${attMark(s.attendance)} ${esc(cut(s.name, 30))} — ${pct(s.attendance)} · ${esc(ptsText(s))}`;
  return { text: `<b>🔒 Ваш журнал</b>${head}\n${list.slice(0, 3).map(row).join("\n")}${fold(list.slice(3, 14).map(row))}${off}`, more: "Весь журнал — в личке" };
}
async function sessionShort(tgId) {
  if (!(await users.moodleToken(tgId))) return { text: esc(NEED_LOGIN), more: "Открыть Doodle в личке" };
  const o = await admission.overview(tgId);
  // Сводка «Сессии» как в личке: на виду — две первые строки (сколько до сессии, сколько экзаменов и зачётов), остальное свёрнуто.
  const lines = admission.summaryText(o).split("\n").slice(1);
  while (lines.length && !lines[0].trim()) lines.shift();
  const top = [], rest = [...lines];
  while (top.length < 2 && rest.length && rest[0].trim()) top.push(rest.shift());
  while (rest.length && !rest[0].trim()) rest.shift();
  return { text: `<b>🔒 Ваша сессия</b>${o.semester ? ` · ${o.semester} семестр` : ""}${top.length ? `\n${top.map(esc).join("\n")}` : ""}${fold(rest.map(esc))}`, more: "Подробнее — в личке" };
}
const SHORT = { deadlines: deadlinesShort, grades: gradesShort, journal: journalShort, session: sessionShort };
/** Короткий ответ для беседы (chats.mjs): { text — HTML, more — подпись кнопки в личку } или null, если команды нет. */
export async function compact(tgId, command) {
  const fn = SHORT[command];
  if (!fn) return null;
  try {
    const r = await fn(Number(tgId));
    botStats.note("commands");
    return r;
  } catch (e) {
    console.log(`команда /${command} ${tgId} (коротко): ${e.message || e}`);
    return { text: moodle.isOutage(e) ? "Moodle сейчас не отвечает — попробуйте через несколько минут." : "Не получилось собрать ответ — попробуйте ещё раз чуть позже." };
  }
}

// --- уведомления ---
async function settingsView(tgId) {
  const muted = await notify.isMuted(tgId), p = await users.notifyPrefs(tgId);
  const row = (on, label, key) => [{ text: `${on ? "✅" : "⬜️"} ${label}`, callback_data: `set:${key}:${on ? 0 : 1}` }];
  // Дисциплины журнала, которые студент назвал не своими (вопрос о дисциплине без курса в Moodle, attendance.mjs, или
  // «Не моё» в «Сессии» — admission.journalView), — вернуть их. Только дисциплины нынешнего журнала, если он уже
  // загружен: «не моя» прошлого семестра здесь не нужна; не загружен — ответы бота «не моя».
  const cur = ej.lastGood(tgId);
  const notMine = muted || !p.journal ? []
    : cur?.subjects?.length ? ((await admission.journalView(tgId, cur).catch(() => null))?.data?.notMine || []).map((s) => [String(s.id), s])
    : Object.entries((await notify.peekState(tgId).catch(() => ({}))).journalAsk || {}).filter(([, x]) => x?.answer === "no");
  return {
    text: `🔔 Уведомления бота\n\n${muted ? "Сейчас выключены все сообщения." : "Сроки, новые задания и тесты, оценки и замечания приходят всегда; напоминание по отдельной работе настраивается в её карточке в приложении."}\nНажмите, чтобы переключить:${notMine.length ? "\n\n🚫 Ниже — дисциплины журнала, отмеченные как не ваши (в боте или в «Сессии»): уведомлений журнала по ним нет, в «Журнале» и «Сессии» они не считаются. Нажмите, чтобы вернуть." : ""}`,
    buttons: [row(!muted, "Все сообщения бота", "all"), ...(muted ? [] : [row(p.news, "Объявления и материалы курсов", "news"), row(p.journal, "Пропуски и посещаемость", "journal")]),
      ...notMine.map(([id, x]) => [{ text: `↩️ ${cut(x.name || "Дисциплина журнала", 45)}`, callback_data: `ejs:${id}` }])],
  };
}
async function stop(tgId) {
  await notify.setMuted(tgId, true);
  return "🔕 Все сообщения бота выключены — напоминания о сроках, тестах, оценках и сообщения по лабораторным приходить не будут. Команды в чате работают как раньше.\nВключить обратно: /settings";
}
/**
 * Нажатие кнопки: set:<all|news|journal>:<0|1> (настройки), dg:<час|off> (утренняя сводка), ejq:<y|n>:<id> (ответ «моя /
 * не моя» о дисциплине журнала без курса в Moodle, attendance.answerAsk), ejs:<id> и ejj:<id> («вернуть» не свою
 * дисциплину журнала в /settings и в /journal, attendance.restoreMine) → вид для правки того же сообщения или null.
 */
export async function callback(tgId, cb) {
  const ask = /^ejq:([yn]):(\d{1,15})$/.exec(String(cb || ""));
  if (ask) return attendance.answerAsk(Number(tgId), ask[2], ask[1] === "y");
  const back = /^ej([sj]):(\d{1,15})$/.exec(String(cb || ""));
  if (back) { await attendance.restoreMine(Number(tgId), back[2]); return back[1] === "s" ? settingsView(Number(tgId)) : journalView(Number(tgId)); }
  const dg = /^dg:(off|\d{1,2})$/.exec(String(cb || ""));
  if (dg) {
    const hour = dg[1] === "off" ? null : Number(dg[1]);
    if (hour !== null && !DIGEST_HOURS.includes(hour)) return null;
    await notify.withState(tgId, (s) => { if (hour === null) delete s.digest; else s.digest = { hour, last: s.digest?.last }; });
    return digestView(Number(tgId));
  }
  const m = /^set:(all|news|journal):([01])$/.exec(String(cb || ""));
  if (!m) return null;
  if (m[1] === "all") await notify.setMuted(tgId, m[2] === "0");
  else await users.setNotifyPref(tgId, m[1], m[2] === "1");
  return settingsView(Number(tgId));
}

// --- утренняя сводка ---
// Настройка хранится в состоянии уведомлений человека: digest = { hour } (час по Москве) или её нет — сводка выключена.
const DIGEST_HOURS = [6, 7, 8, 9, 10];
async function digestView(tgId) {
  const hour = (await notify.peekState(tgId)).digest?.hour ?? null; // только показать — без записи файла
  const btn = (h) => ({ text: `${hour === h ? "✅ " : ""}${h}:00`, callback_data: `dg:${h}` });
  return {
    text: `☀️ Утренняя сводка

Раз в день в выбранное время (по Москве) пришлю пары на сегодня (как по команде /today) и ближайшие сроки.
Сейчас: ${hour == null ? "выключена" : `в ${hour}:00`}.`,
    buttons: [DIGEST_HOURS.map(btn), [{ text: `${hour == null ? "✅ " : ""}Выключить`, callback_data: "dg:off" }]],
  };
}
/**
 * Рассылка сводок: вызывается сервером раз в несколько минут. Человеку — один раз в день, в его час и не позже чем через
 * три часа после него (если сервер в это время не работал, утреннюю сводку вечером не шлём). Данные — уже загруженные.
 */
export async function digestTick() {
  const now = new Date(Date.now() + 3 * 3600e3), hourNow = now.getUTCHours(), day = now.toISOString().slice(0, 10);
  let sent = 0;
  for (const u of await users.allLoggedIn()) {
    try {
      let prev;
      const due = await notify.withState(u.tgId, (s) => {
        const h = s.digest?.hour;
        if (h == null || s.digest.last === day || hourNow < h || hourNow >= h + 3) return false;
        prev = s.digest.last;
        s.digest.last = day; // отметка до отправки: при сбое сводка не придёт дважды
        return true;
      });
      if (!due) continue;
      // Сводка точно не ушла (429, 5xx, ответ не JSON, исключение при сборке текста) — отметка снимается, и следующий
      // тик (5 мин) повторит внутри окна h..h+3 (15 окт 2026; раньше сводки в этот день уже не было). Неоднозначный исход
      // (таймаут сети: Telegram мог и принять) — отметка остаётся: дубль сводки хуже потери (settled с dupOk: false).
      const undo = () => notify.withState(u.tgId, (s) => { if (s.digest?.last === day) s.digest.last = prev; });
      let r;
      try { r = await notify.deliver(u.tgId, `☀️ Доброе утро!\n\n${await pace.background("digest", () => digestText(u.tgId))}`); }
      catch (e) { await undo().catch(() => {}); throw e; }
      if (r.ok) sent++;
      else if (!notify.settled(r, { dupOk: false })) await undo();
    } catch (e) { console.log(`сводка ${u.tgId}: ${e.message || e}`); }
  }
  return sent;
}

// --- приглашения ---
let botName = null;
const username = async () => (botName ??= (await bots.call("getMe", {})).result?.username || null);
async function invite(tgId) {
  const name = await username();
  if (!name) return "Ссылку сейчас не получилось собрать — попробуйте чуть позже.";
  const link = `https://t.me/${name}?start=ref_${tgId}`, n = botStats.invitedCount(tgId);
  const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent("Doodle — дедлайны, расписание и журнал МИСИС в одном приложении, с напоминаниями в Telegram")}`;
  return { text: `🤝 Ваша ссылка-приглашение:\n${link}\n\nОтправьте её одногруппникам. По вашей ссылке пришло: ${n}.`, buttons: [[{ text: "Поделиться ссылкой", url: share }]] };
}
/** Первый Start человека: запоминаем время и пригласившего (payload «ref_<id>» из ссылки). */
export function started(tgId, payload = "") {
  const ref = /^ref_(\d{4,15})$/.exec(String(payload))?.[1] || null;
  return botStats.firstStart(tgId, ref);
}

// --- сводка для владельца ---
/** Недельная сводка: люди, активность, сообщения, нагрузка на Moodle. Только цифры. */
export async function ownerReport() {
  const all = await users.listUsers(), s = botStats.summary(7), load = pace.lastDays(7), since = Date.now() - 7 * DAY;
  const active = pace.stampsOf("seen:").filter(([, at]) => at >= since).length;
  return `📈 Doodle за неделю\n\nЛюди: всего ${all.length}, вошли в Moodle ${all.filter((u) => u.loggedIn).length}\nОткрывали приложение за 7 дней: ${active}\nНовых (первый Start): ${s.started}${s.invited ? `, из них по приглашению ${s.invited}` : ""}\nПришло по приглашениям за всё время: ${s.totalInvited}\n\nСообщений бота людям: ${s.sent}\nКоманд в чате: ${s.commands}\n\nЗапросов к сайтам МИСИС: ${load.total}${load.days ? ` (в среднем ${Math.round(load.total / load.days)} в сутки)` : ""}, сбоев ${load.fail}, пик ${load.peakMin} в минуту`;
}
const stats = async (tgId) => (Number(tgId) === users.OWNER_ID ? ownerReport() : null);

/** Сессия: до неё дней, формы контроля семестра, даты экзаменов (если расписание вышло), долги по журналу и Moodle. */
async function sessionCmd(tgId) {
  if (!(await users.moodleToken(tgId))) return NEED_LOGIN;
  const o = await admission.overview(tgId);
  return { text: admission.summaryText(o), buttons: await notify.appButton("Сессия в Doodle", "session") };
}
const COMMANDS = { today: pairs, pairs, tomorrow, week, deadlines, grades, journal, session: sessionCmd, settings: settingsView, digest: digestView, stop, invite, stats, terms: async () => TERMS, privacy: async () => PRIVACY };
/** Список для меню команд бота (setMyCommands). */
export const LIST = [
  { command: "today", description: "Пары на сегодня" },
  { command: "tomorrow", description: "Пары на завтра" },
  { command: "week", description: "Расписание на неделю" },
  { command: "deadlines", description: "Работы на неделю" },
  { command: "grades", description: "Оценки по работам" },
  { command: "journal", description: "Посещаемость и баллы" },
  { command: "session", description: "Сессия: даты, зачёты и экзамены" },
  { command: "invite", description: "Позвать одногруппника" },
  { command: "digest", description: "Утренняя сводка" },
  { command: "settings", description: "Уведомления" },
  { command: "stop", description: "Выключить все сообщения" },
  { command: "terms", description: "Условия использования" },
  { command: "privacy", description: "Политика конфиденциальности" },
];
/**
 * Ответ на команду: { text, buttons? } или null, если такой команды нет. Сбой Moodle или расписания — понятная строка,
 * а не молчание.
 */
export async function answer(tgId, command) {
  const fn = COMMANDS[command];
  if (!fn) return null;
  try {
    const r = await fn(Number(tgId));
    if (r == null) return null;
    botStats.note("commands");
    return typeof r === "string" ? { text: r } : r;
  } catch (e) {
    console.log(`команда /${command} ${tgId}: ${e.message || e}`);
    return { text: moodle.isOutage(e) ? "Moodle сейчас не отвечает — попробуйте через несколько минут." : "Не получилось собрать ответ — попробуйте ещё раз чуть позже." };
  }
}
