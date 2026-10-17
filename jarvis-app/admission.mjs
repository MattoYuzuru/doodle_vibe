// «Допуск и сессия» (просьба владельца, 15 окт 2026): сводка для экрана приложения и бота и уведомления.
// Откуда что: учебный план группы (curriculum.mjs) — курс, семестр, даты сессии, форма контроля по каждой дисциплине;
// расписание экзаменов (session.mjs) — даты, время и аудитории, когда учебный отдел его выложит; журнал (ej.mjs) —
// баллы рейтинга по дисциплине: сколько есть, сколько можно ещё набрать и пороги на 3/4/5 (у зачёта — порог тройки).
// Посещаемость и несданные работы здесь не повторяются: они во вкладке «Журнал» и в «Дедлайнах» (просьба владельца).
// Отдельного «допуска» у МИСИС в открытых источниках нет: риск — порог, которого уже не набрать оставшимися работами.
//
// Уведомления (tick раз в несколько минут, по уже загруженному): за 14 и за 3 дня до сессии — сводка; расписание
// экзаменов вышло (session.onNew) — даты по своей группе (кому не дошло — досылает tick); накануне экзамена вечером и
// утром в день экзамена — напоминание.
import * as attendance from "./attendance.mjs";
import * as courseSheets from "./course-sheets.mjs";
import * as curriculum from "./curriculum.mjs";
import * as ej from "./ej.mjs";
import * as moodle from "./moodle.mjs";
import * as mplan from "./moodle-plan.mjs";
import * as notify from "./notify.mjs";
import * as pace from "./moodle-pace.mjs";
import { BASE } from "./users.mjs";
import { normGroup } from "./official.mjs";
import * as session from "./session.mjs";
import * as users from "./users.mjs";

const DAY = 86400e3, TZ = "Europe/Moscow";
const MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const MONTHS_G = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const MONTHS_N = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const mskParts = (ms) => Object.fromEntries(new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
const addDays = (day, n) => new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)) + n * DAY).toISOString().slice(0, 10);
/** «2027-01-12» → «12 янв»; long — «12 января». */
export const dayText = (d, long = false) => (d ? `${Number(d.slice(8, 10))} ${(long ? MONTHS_G : MONTHS)[Number(d.slice(5, 7)) - 1]}` : "");
/** «5–25 января» или «29 декабря – 8 января». */
export const rangeText = (from, to) => (from.slice(0, 7) === to.slice(0, 7) ? `${Number(from.slice(8, 10))}–${dayText(to, true)}` : `${dayText(from, true)} – ${dayText(to, true)}`);
const plural = (n, one, few, many) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many}`;

// ---------- сопоставление названий ----------
// Дисциплина в плане, журнале и Moodle называется чуть по-разному («Теория инф. процессов», «Теория информационных
// процессов и систем»): сравниваем по словам длиннее трёх букв — совпало больше половины у более короткого названия.
const STOP = new Set(["основы", "теория", "введение", "практика", "курс", "часть", "модуль"]);
const tokens = (s) => new Set(String(s || "").toLowerCase().replace(/ё/g, "е").split(/[^a-zа-я0-9]+/).filter((w) => w.length > 3 && !STOP.has(w)).map((w) => w.slice(0, 6)));
export function sameName(a, b) {
  const ta = tokens(a), tb = tokens(b);
  if (!ta.size || !tb.size) return false;
  let hit = 0;
  for (const t of ta) if (tb.has(t)) hit++;
  return hit >= Math.max(1, Math.ceil(Math.min(ta.size, tb.size) / 2)) && (hit >= 2 || Math.min(ta.size, tb.size) === 1);
}
const normName = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, " ").trim();
/** Доля общих слов от более длинного названия (0…1): чем ближе к 1, тем вернее это одна дисциплина. */
const similarity = (a, b) => { const ta = tokens(a), tb = tokens(b); let hit = 0; for (const t of ta) if (tb.has(t)) hit++; return hit / Math.max(ta.size, tb.size, 1); };
/**
 * Дисциплина из списка по названию: точное совпадение, иначе самое похожее из подходящих по sameName. Первое
 * попавшееся брать нельзя: «Теория информационных процессов и систем» и «Моделирование информационных процессов и
 * систем» делят три слова, и баллы одной показывались у другой (найдено 15 окт 2026 на журнале владельца).
 */
const findBy = (list, name, get = (x) => x.name) => {
  const exact = list.find((x) => normName(get(x)) === normName(name));
  if (exact) return exact;
  // Ничья по сходству (курс «Базы данных. Осень 2026» и дисциплины «Базы данных» / «Распределённые базы данных» — обе
  // 0,5) — побеждает кандидат, у которого совпала бо́льшая доля его собственных слов, а не тот, что раньше в списке.
  const tn = tokens(name);
  let best = null, score = 0, own = 0;
  for (const x of list) {
    if (!sameName(get(x), name)) continue;
    const v = similarity(get(x), name), tx = tokens(get(x));
    let h = 0;
    for (const t of tx) if (tn.has(t)) h++;
    const o = h / Math.max(tx.size, 1);
    if (v > score || (v === score && o > own)) { best = x; score = v; own = o; }
  }
  return best;
};
export { findBy };
/**
 * Курс Moodle для дисциплины семестра — только взаимная пара: курс находится по дисциплине, а дисциплина — по курсу.
 * Иначе «Теория информационных процессов и систем» без своего курса брала курс «Моделирования…» (3 общих слова из 4,
 * проверка 15 окт). Обратный поиск — по всем дисциплинам семестра (subjects — те же объекты). Чистая функция.
 */
export function matchCourse(subjects, mcourses, s) {
  const mc = findBy(mcourses, s.name);
  return mc && findBy(subjects, mc.name) === s ? mc : null;
}

const CONTROL_OF = { "Экзамен": "Эк", "Зачёт с оценкой": "ЗаО", "Зачёт": "За" };
const r1 = (x) => Math.round(x * 10) / 10;

// ---------- «не моё»: одно на бота и «Сессию» ----------
// 16 окт 2026: ответ «Нет, не моя» на вопрос бота о дисциплине журнала без курса в Moodle (notify journalAsk[id журнала],
// attendance.mjs) и «Не моё» в «Сессии» (users.sessionChoices.hidden[ключ]) — одно и то же решение студента. Оба
// учитываются везде: уведомления журнала и вопрос бота, вкладка «Журнал» и /journal (отдельным списком с «Вернуть»,
// средние без них), «Сессия» и её сводки. Ключи разные (s:<семестр>:<индекс плана> или x:…:<название> против id
// журнала) — сопоставляются через пару arrange (_js). Хранится по-прежнему в двух местах; решает последнее слово:
// «Не моё» в «Сессии» после «Да, моя» в боте — не его, «Всё-таки моя» в боте после «Не моё» в «Сессии» — его. «Вернуть»
// (во вкладке «Журнал», /journal, /settings, «Сессии») снимает обе отметки.
/** Время отметки «Не моё» «Сессии»: число (с 16 окт 2026) или true (раньше — самая старая); нет отметки — null. */
const hiddenAt = (h) => (!h ? null : typeof h === "number" ? h : 0);
/** Не своя ли дисциплина: h — отметка «Сессии» (или нет), q — запись вопроса бота journalAsk. Чистая функция. */
export function notMineNow(h, q) {
  const said = q?.answer === "no" || q?.answer === "yes";
  if (hiddenAt(h) == null) return said && q.answer === "no";
  return !said || q.answer === "no" || hiddenAt(h) >= (q.answeredAt || 0);
}
/** Откуда последнее «не моё»: "session" — «Не моё» в «Сессии», "bot" — ответ в боте. */
const notMineFrom = (h, q) => (hiddenAt(h) != null && !(q?.answer === "no" && (q.answeredAt || 0) > hiddenAt(h)) ? "session" : "bot");
/** Отметки «Сессии» по дисциплинам журнала: pairs (arrange) + hidden → Map id журнала (строкой) → самая поздняя отметка. */
export function hiddenByJournal(pairs, hidden) {
  const out = new Map();
  for (const p of pairs || []) {
    const h = hidden?.[p.key], id = String(p.ejId);
    if (hiddenAt(h) != null && (!out.has(id) || hiddenAt(h) > hiddenAt(out.get(id)))) out.set(id, h);
  }
  return out;
}
/** Не свои дисциплины журнала: Map id (строкой) → "bot" | "session". asked — journalAsk, byJ — hiddenByJournal. */
export function notMineIds(subjects, asked, byJ) {
  const out = new Map();
  for (const s of subjects || []) {
    const id = String(s.id), h = byJ?.get(id), q = asked?.[id];
    if (notMineNow(h, q)) out.set(id, notMineFrom(h, q));
  }
  return out;
}

// ---------- какие дисциплины у студента на самом деле ----------
// План группы описывает «обычного» студента: все варианты дисциплин по выбору, факультативы. У переведённого из другой
// группы бывают ещё академическая разница и пересдачи (Волков, БИВТ-24, 15 окт 2026: «История России» 1 курса и
// «Пересдачи Иностранный язык» в Moodle). Что выбрал сам студент, видно по электронному журналу и курсам Moodle.
const MONTHS_RE = [/январ/, /феврал/, /март/, /апрел/, /ма[йя]/, /июн/, /июл/, /август/, /сентябр/, /октябр/, /ноябр/, /декабр/];
/**
 * Курс Moodle пересдачи: «Математика пересдача октябрь 2026», «Пересдачи Иностранный язык -» → { subject, month };
 * stale — месяц в названии уже прошёл (такие курсы в Moodle не убирают). null — не курс пересдачи. Чистая функция.
 */
export function retakeOf(name, today) {
  const s = String(name || "");
  if (!/пересдач/i.test(s)) return null;
  // Месяц и год: «октябрь 2026», «январь-февраль 2027» (берётся последний месяц), «2026 октябрь». [а-яё]*, а не \w*:
  // без флага u \w в JS — только латиница, и «октябрь» обрывался на «ь».
  // Срок — по последнему упоминанию: «декабрь 2026 – январь 2027» живёт до января (повторная проверка 15 окт).
  const all = [...s.matchAll(WHEN_RE)];
  const when = all.at(-1);
  const mon = when && (when[1] || when[4]), yr = when && (when[2] || when[3]);
  const subject = all.reduce((t, m) => t.replace(m[0], " "), s).replace(/\s[-–—]\s/g, " ")
    .replace(/(?:(?<![а-яё])(?:по|для)\s+)?пересдач[а-яё]*(?:\s+(?:по|для)(?![а-яё]))?/gi, " ")
    .replace(/\(\s*[,;:\-–—\s]*\)/g, " ")
    .replace(/[\s\-–—.,:;]+$/, "").replace(/^[\s\-–—.,:;]+/, "").replace(/\s+/g, " ").trim();
  let stale = false, month = null;
  if (mon) {
    const m = MONTHS_RE.findIndex((r) => r.test(mon.toLowerCase())) + 1;
    month = `${yr}-${String(m).padStart(2, "0")}`;
    stale = !!today && month < today.slice(0, 7);
  }
  // «по математике» → «математике» не превращаем в именительный падеж — лишь первая буква заглавная.
  const subj = subject || s.trim();
  return { subject: subj.charAt(0).toUpperCase() + subj.slice(1), month, stale };
}
const MON = "январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр";
const WHEN_RE = new RegExp(`(?<![а-яё])(?:(?:${MON})[а-яё]*\\s*[-–—]\\s*)?((?:${MON})[а-яё]*)\\s+(20\\d\\d)|(?<!\\d)(20\\d\\d)\\s+((?:${MON})[а-яё]*)`, "gi");

/**
 * Дисциплины семестра для одного студента. plan — curriculum.status (subjects этого семестра, earlier — прошлых);
 * без плана — дисциплины журнала. journal — данные ej (или null: не загружен). mcourses — курсы Moodle [{ id, name }].
 * Возвращает { subjects, optional, extra, counts } и у дисциплин служебные _js (журнал) и _mc (курс Moodle — взаимная
 * пара). Чистая функция (для стенда).
 * - По выбору: оставляется вариант, найденный в журнале или среди курсов Moodle; не нашёлся ни один — все варианты
 *   с electiveOpen = их число (в счётчиках группа считается один раз). Варианты с одинаковым названием (НИР, практика
 *   у разных кафедр) — одна дисциплина.
 * - Факультативы (ФТД, kind optional) — отдельным списком и не в счётчиках: аттестация по ним нужна, только если
 *   студент на них записан (attending — нашёлся в журнале или Moodle).
 * - extra — вне плана группы на этот семестр: дисциплины журнала, которых в плане семестра нет; курсы Moodle
 *   дисциплин прошлых семестров плана (академическая разница); курсы пересдач, месяц которых не прошёл.
 * choices — уточнения самого студента (users.sessionChoices), они главнее догадок: выбранный вариант дисциплины по
 * выбору (electiveFrom "user"), «записан / не записан» на факультатив, «не моё» (hidden — в списке hidden, без счёта).
 * asked — ответы бота о дисциплинах журнала (notify journalAsk): «не моя» у пары дисциплины — то же «не моё»
 * (notMineNow; у скрытой — hiddenFrom "bot" | "session").
 * У каждой дисциплины key — по нему приложение присылает «не моё»; у дисциплин по выбору variants — все варианты группы.
 * pairs — [{ key, ejId }]: какая дисциплина журнала — пара какого ключа (и у скрытых, и у невыбранных вариантов).
 */
export function arrange({ plan, journal, mcourses = [], today = "", choices = {}, asked = {} }) {
  // Журнал другого семестра (ej.misis.ru переключает «текущий» семестр не день в день с графиком плана) с планом этого
  // семестра не сравниваем: иначе все его дисциплины оказались бы «вне плана», а варианты по выбору — не найдены.
  const jPar = /^осенн/i.test(journal?.semester || "") ? 1 : /^весенн/i.test(journal?.semester || "") ? 0 : null;
  const jsubs = journal?.subjects && !(plan?.semester && jPar != null && plan.semester % 2 !== jPar) ? journal.subjects : null;
  const pick = choices.electives || {}, opt = choices.optional || {}, hid = choices.hidden || {};
  // «Не моё» — отметка «Сессии» или ответ бота о паре из журнала (последнее слово студента).
  const off = (x) => notMineNow(hid[x.key], x._js ? asked?.[x._js.id] : null);
  const sem = plan?.semester ?? "";
  const all = plan?.subjects ? plan.subjects.map((s) => ({ ...s })) : (jsubs || []).map((s) => {
    const c = CONTROL_OF[s.control] || null;
    return { index: null, name: s.name, kind: "discipline", controls: c ? [c] : [], labels: c ? [curriculum.LABEL[c]] : [], elective: null, exam: c === "Эк", graded: c === "ЗаО", pass: c === "За", coursework: false };
  });
  const earlier = plan?.subjects ? plan.earlier || [] : [];
  // Обратный поиск пары у вариантов по выбору — по этому семестру и прошлым вместе (сначала этот: при равенстве побеждает
  // он). Иначе журнал или курс «Математика» (академическая разница) находил в семестре только «Математические модели…» —
  // вариант по выбору — и выдавал его за выбранный, а сама разница пропадала (проверка 15 окт). У обязательных — только
  // по этому семестру: «Физическая культура и спорт» журнала — пара «Элективных курсов по физической культуре», а не
  // одноимённой дисциплины 2 и 4 семестра (иначе у всех физкультура стала бы «академической разницей»; повторная проверка).
  const pool = [...all, ...earlier];
  const regular = mcourses.filter((c) => !/пересдач/i.test(c.name));
  for (const s of all) {
    s.key = `s:${sem}:${s.index || normName(s.name)}`;
    const back = s.elective ? pool : all;
    const js = jsubs ? findBy(jsubs, s.name) : null;
    // Взаимная пара: «Иностранный язык» журнала — обязательной дисциплине, а не одноимённому факультативу.
    s._js = js && findBy(back, js.name) === s ? js : null;
    s._mc = matchCourse(back, regular, s);
  }
  const drop = new Set();
  const groups = new Map();
  for (const s of all) if (s.elective) { if (!groups.has(s.elective)) groups.set(s.elective, []); groups.get(s.elective).push(s); }
  for (const [g, vs] of groups) {
    // Варианты с одинаковым названием (НИР, практика у разных кафедр) — для студента одна дисциплина.
    const uniq = [];
    for (const v of vs) if (uniq.some((u) => normName(u.name) === normName(v.name))) drop.add(v); else uniq.push(v);
    const variants = uniq.map((v) => ({ index: v.index, name: v.name }));
    for (const v of uniq) v.variants = uniq.length > 1 ? variants : null;
    // Скрытый самим студентом вариант («не моё») в выборе не участвует: остальные остаются видны.
    const live = uniq.filter((v) => !off(v));
    const mine = live.find((v) => v.index === pick[g]);
    // Свой выбор → журнал → Moodle. Нашлось несколько (поток записан на курсы всех вариантов) — выбор не ясен.
    const byJ = live.filter((v) => v._js), byM = live.filter((v) => v._mc);
    const found = mine ? [mine] : byJ.length ? byJ : byM;
    if (found.length === 1) {
      for (const v of live) if (v !== found[0]) drop.add(v);
      found[0].electiveFrom = mine ? "user" : found[0]._js ? "journal" : "moodle";
      continue;
    }
    // Не ясно — открыты все варианты, а не только нашедшиеся: курс одного варианта может называться в Moodle иначе, и он
    // пропал бы вместе с экзаменом из рассылки расписания (повторная проверка 15 окт).
    if (live.length > 1) for (const v of live) v.electiveOpen = live.length;
  }
  const hidden = [];
  const subjects = [], optional = [];
  for (const s of all) {
    if (drop.has(s)) continue;
    if (off(s)) { hidden.push(s); continue; }
    if (s.kind === "optional") {
      // Записан: так сказал сам студент или дисциплина нашлась в журнале или Moodle (если он не сказал «не записан»).
      s.attending = s.index in opt ? opt[s.index] === true : !!(s._js || s._mc);
      s.attendingFrom = s.index in opt ? "user" : s.attending ? (s._js ? "journal" : "moodle") : null;
      (s.attending ? subjects : optional).push(s);
      continue;
    }
    subjects.push(s);
  }
  const counts = { exam: 0, graded: 0, pass: 0, coursework: 0, none: 0 };
  const counted = new Set();
  for (const s of subjects) {
    if (s.electiveOpen) { if (counted.has(s.elective)) continue; counted.add(s.elective); }
    if (s.exam) counts.exam++; if (s.graded) counts.graded++; if (s.pass) counts.pass++; if (s.coursework) counts.coursework++; if (!s.controls.length) counts.none++;
  }

  const extra = [];
  // Вне плана — только то, что не стало парой ни одной дисциплины семестра (а не всё, что на какую-то похоже: «Моделирование
  // информационных процессов и систем» из журнала похоже на «Теорию информационных процессов и систем» плана, но не она).
  if (plan?.subjects && jsubs) {
    for (const js of jsubs) {
      if (all.some((s) => s._js === js)) continue;
      const hit = findBy(pool, js.name);
      const e = hit && earlier.includes(hit) ? hit : null;
      const c = CONTROL_OF[js.control] || null;
      extra.push({ name: js.name, why: e ? "earlier" : "journal", label: c ? curriculum.LABEL[c] : js.control || null, pass: c === "За", planSemesters: e?.semesters ?? null, course: null, _js: js, _plan: e });
    }
  }
  for (const c of mcourses) {
    const r = retakeOf(c.name, today);
    let item = null;
    if (r) {
      if (r.stale) continue;
      const p = earlier.length ? findBy(earlier, r.subject) : null;
      item = { name: r.subject, why: "retake", label: null, pass: false, planSemesters: null, month: r.month, course: { id: c.id, name: c.name }, _js: null, _plan: p && normName(p.name) === normName(r.subject) ? p : null };
    } else {
      // Курс дисциплины этого семестра (её пара) или не похож ни на одну дисциплину прошлых семестров (ESP, кураторские) — мимо.
      if (!plan?.subjects || all.some((s) => s._mc === c)) continue;
      const e = findBy(pool, c.name);
      if (!e || !earlier.includes(e) || findBy(regular, e.name) !== c) continue;
      item = { name: e.name, why: "earlier", label: null, pass: false, planSemesters: e.semesters, course: { id: c.id, name: c.name }, _js: null, _plan: e };
    }
    // Та же дисциплина уже есть (из журнала или другим курсом) — одна запись: пересдача главнее, баллы журнала остаются.
    // «Та же» — то же название или та же дисциплина плана; похожести мало: «Иностранный язык» и «Русский язык как
    // иностранный», «Математика» и «Математический анализ» — разные (повторная проверка 15 окт).
    const same = extra.find((x) => normName(x.name) === normName(item.name) || (x._plan && x._plan === item._plan));
    if (same) {
      if (item.why === "retake" && same.why !== "retake") Object.assign(same, { why: "retake", month: item.month, course: item.course });
      else same.course ??= item.course;
      continue;
    }
    extra.push(item);
  }
  for (const x of extra) { x.key = `x:${x.why === "retake" ? `retake:${x.month || ""}` : sem}:${normName(x.name)}`; delete x._plan; }
  // journalSkipped — журнал есть, но за другой семестр: с планом не сравнивали (overview скажет об этом).
  const pairs = [...all, ...extra].filter((x) => x._js?.id != null).map((x) => ({ key: x.key, ejId: x._js.id }));
  const gone = [...hidden, ...extra.filter(off)];
  for (const x of gone) x.hiddenFrom = notMineFrom(hid[x.key], x._js ? asked?.[x._js.id] : null);
  return { subjects, optional, extra: extra.filter((x) => !off(x)), hidden: gone, counts, journalSkipped: !!journal?.subjects && !jsubs, pairs };
}

// ---------- справки по дисциплинам без баллов онлайн ----------
// Английский (просьба владельца, 15 окт 2026, этап А): ни баллов, ни пропусков нет ни в электронном журнале, ни в
// Moodle («ESP 2026» — только задания) — их ведёт преподаватель. Вместо «баллы неизвестны» — что известно из открытых
// документов: разбивка баллов и пороги из рабочей программы (сверено с текстом РПД 15 окт 2026); кто отмечает пропуски
// (П 239.09-18 п. 2.4, 2.6; П 239.40-25 п. 7.15.1); когда ставят зачёт с оценкой (П 239.09-18 п. 4.1.4б); что и кому
// нести после пропуска — подтверждающий документ, по иным причинам объяснительную (П 239.40-25 п. 3.2.31). Только для плана, по которому сверена программа: у других потоков
// своя РПД. Не пишем «недопуска нет» (в РПД это про экзамен 7 семестра) и пороги часов для выговора и отчисления.
const SUBJECT_INFO = [{
  plan: /\/09\.03\.02-BIST-24\.plx[^/]*\.pdf$/i, name: /^иностранный язык$/i,
  scale: 100, parts: [["Работа на занятии", 40], ["Онлайн-платформа", 10], ["Внутрисеместровый контроль", 20], ["Проект", 10], ["Итоговый тест", 20]],
  thresholds: { 3: 51, 4: 70, 5: 85 },
  attendance: "Отдельного порога по пропускам в программе нет, но 40 баллов из 100 дают за работу на занятиях — пропуски бьют по ним.",
  url: "https://misis.ru/sveden/files/rik/Inostrannyi_yazyk(452).pdf",
}];
/** Справка по дисциплине плана (planUrl — адрес учебного плана) или null. Чистая функция (для стенда). */
export function subjectInfo(planUrl, s) {
  let url = String(planUrl || "");
  try { url = decodeURI(url); } catch {}
  const r = SUBJECT_INFO.find((x) => x.plan.test(url) && x.name.test(String(s.name || "").trim()));
  if (!r) return null;
  const t = r.thresholds;
  const notes = ["У вас по этой дисциплине нет ни баллов, ни пропусков в электронном журнале и Moodle — их отмечают преподаватель и староста группы.", r.attendance];
  if (s.graded && !s.exam) notes.push("Зачёт с оценкой ставят на последнем занятии.");
  // П 239.40-25 п. 3.2.31: при уважительной причине — подтверждающий документ (при болезни — справка), объяснительная —
  // при пропуске по иным причинам; без документа пропуск неуважительный (П 239.09-18, прил. 8). Проверка 15 окт.
  notes.push("Пропустили по уважительной причине — в первый день, как пришли, отдайте куратору документ, который это подтверждает (при болезни — справку): без него пропуск считают неуважительным. По другой причине — в тот же день объяснительную куратору. Знаете о пропуске заранее — письменно предупредите старосту или куратора.");
  return {
    scale: r.scale, parts: r.parts.map(([name, max]) => ({ name, max })), notes, url: r.url,
    bands: s.exam || s.graded || !s.pass ? `3 — от ${t[3]}, 4 — от ${t[4]}, 5 — от ${t[5]}` : `зачёт — от ${t[3]}`,
  };
}

/**
 * Баллы рейтинга по дисциплине (из 100, как в журнале): сколько есть, сколько ещё можно набрать (работы без оценки и
 * не заведённые в журнал контрольные мероприятия) и по каждому порогу — сколько не хватает и достижим ли он. Пороги —
 * из журнала дисциплины: у экзамена и зачёта с оценкой — на 3, 4 и 5, у зачёта — порог тройки как «зачёт».
 * Чистая функция (для стенда). null — дисциплины нет в журнале или журнал не дал порогов.
 */
export function scoreOf(js, { pass = false } = {}) {
  if (!js || js.rating == null || !js.thresholds) return null;
  const have = js.rating, left = js.points?.left ?? null;
  const marks = pass ? [["pass", "зачёт", js.thresholds[3]]] : [["3", "на 3", js.thresholds[3]], ["4", "на 4", js.thresholds[4]], ["5", "на 5", js.thresholds[5]]];
  // need — с точностью до сотых: округление до десятых давало «ещё 0» при невзятом пороге (60,96 при 61).
  const targets = marks.map(([key, label, at]) => ({ key, label, at, need: Math.max(0, Math.round((at - have) * 100) / 100), done: have >= at, reachable: left == null ? null : have + left + 0.05 >= at }));
  const failed = (js.works || []).filter((w) => w.failed).map((w) => w.name);
  return { source: "ej", scale: 100, have, left, pending: js.points?.pending ?? null, max: left == null ? null : r1(Math.min(100, have + left)), targets, failed, grade: js.grade ?? null, confidence: "high" };
}

/**
 * Баллы из Moodle (moodle-plan.mjs) в виде для «Сессии»: курс, журнал оценок и рейтинг-план. Пороги, шкала («из N») и
 * полоса — только при уверенности high/medium (иначе выходило «130 из 100»); иначе — пороги плана текстом (planBands) и
 * пояснение. planNote — почему порогов нет (одно на приложение и бота). loaded=false — план курса не загрузился.
 * Чистая функция (для стенда).
 */
export function moodleScoreView({ courseId, items, plan: planText, cmid, loaded }, { group, pass = false } = {}) {
  const p = mplan.parsePlan(planText || "");
  const m = mplan.moodleScore(items || [], p, { group });
  const sure = m.confidence === "high" || m.confidence === "medium";
  let targets = m.targets;
  if (pass && targets.length) targets = [{ ...targets[0], key: "pass", label: "зачёт" }];
  const at = (k) => (p.thresholds ? (p.unit === "%" ? `${p.thresholds[k]} %` : `${p.thresholds[k]}`) : null);
  const w = (k) => (p.strict[k] ? "более" : "от");
  const planNote = p.thresholds || p.pass != null ? null
    : p.status === "ambiguous" ? "в рейтинг-плане пороги отдельно для каждого института — посмотрите свой в плане"
    : p.status === "unparsed" ? "пороги в рейтинг-плане записаны так, что разобрать их не получилось — посмотрите план"
    : loaded === false ? "рейтинг-план курса не удалось загрузить"
    : !cmid ? "рейтинг-плана в курсе Moodle не нашлось"
    : "сколько баллов нужно на оценку, в рейтинг-плане курса не написано";
  return {
    source: "moodle", scale: sure ? m.scale : null, have: m.have, left: m.left, pending: m.pending.length, max: sure ? r1(Math.min(m.scale, m.have + m.left)) : null,
    sumMax: m.sumMax, targets, failed: [], grade: null, confidence: m.confidence, note: m.note, graded: m.graded, pendingWorks: m.pending.slice(0, 6), finals: m.finals,
    planStatus: p.status, planFound: !!cmid || p.status !== "none", planNote,
    planBands: p.thresholds ? (pass ? `зачёт — ${w(3)} ${at(3)}` : `3 — ${w(3)} ${at(3)}, 4 — ${w(4)} ${at(4)}, 5 — ${w(5)} ${at(5)}`) + (p.max != null ? ` из ${p.max}` : "") : null,
    planPass: p.pass, planUrl: cmid ? `${BASE}/mod/page/view.php?id=${cmid}` : null, gradesUrl: `${BASE}/grade/report/user/index.php?id=${courseId}`,
  };
}

// ---------- таблицы преподавателей ----------
const SHEET_PART = { lecture: "Лекции", lab: "Лабораторные", practice: "Практические", lesson: "Занятия", control: "Контрольные", points: "Работы" };
const dec = (x) => String(Math.round(x * 100) / 100).replace(".", ",");
const near = (a, b) => a != null && b != null && Math.abs(a - b) <= Math.max(1, b * 0.02);
/** Пороги плана текстом: «3 — от 55, 4 — от 70, 5 — от 85» (в процентах — «от 55 %»), у зачёта — только первый. */
function bandsText(p, pass) {
  const at = (k) => `${p.strict?.[k] ? "более" : "от"} ${dec(p.thresholds[k])}${p.unit === "%" ? " %" : ""}`;
  return (pass ? `зачёт — ${at(3)}` : `3 — ${at(3)}, 4 — ${at(4)}, 5 — ${at(5)}`) + (p.unit !== "%" && p.max != null ? ` из ${dec(p.max)}` : "");
}
/**
 * Баллы из таблицы преподавателя (course-sheets.mjs → sheets.sheetRecord, rec.src — откуда) в виде для «Сессии».
 * Пороги считаются, только если таблица — вся дисциплина (full): её максимум ≈ 100 (как рейтинг журнала) или равен
 * максимуму рейтинг-плана. Таблица на часть дисциплины («Лаб 1–3, из 30») — только баллы и части, без «не хватает»: 55 %
 * от 30 — не порог тройки (проверка 16 окт: такая таблица давала ложное «не набрать» и обгоняла Moodle).
 * Откуда пороги: электронный журнал (ej — { 3, 4, 5 } в %, этого учебного года) → рейтинг-план курса Moodle (plan —
 * parsePlan; у «Методов оптимизации» план прошлогодний, «экзамен 40», а в таблице 2026 экзамена нет — максимум тот
 * же, 100, но журнал главнее) → рейтинг-план в Excel курса (sheetPlan). План только с проходным баллом — порог зачёта
 * (у экзамена — строкой), план для нескольких институтов или неразобранный — пояснение и ссылка (planUrl). Чистая функция.
 */
export function sheetScoreView(rec, { ej = null, plan = null, sheetPlan = null, pass = false, planUrl = null } = {}) {
  const scale = rec.scale ?? null;
  const sure = (rec.confidence === "high" || rec.confidence === "medium") && scale != null;
  const fitsMax = (p) => (p?.max != null ? near(scale, p.max) : near(scale, 100));
  const fits = (p) => !!p?.thresholds && fitsMax(p) && (p.unit === "%" || p.thresholds[5] <= scale * 1.001);
  const fromEj = ej && ej[3] != null && ej[4] != null && ej[5] != null ? { thresholds: ej, unit: "%", strict: {}, max: null } : null;
  const full = sure && (near(scale, 100) || (plan?.max != null && near(scale, plan.max)) || (sheetPlan?.max != null && near(scale, sheetPlan.max)));
  let p = null, from = null;
  if (full) {
    if (fromEj && near(scale, 100)) { p = fromEj; from = "journal"; }
    else if (fits(plan)) { p = plan; from = "moodle"; }
    else if (fits(sheetPlan)) { p = sheetPlan; from = "sheet"; }
  }
  let targets = p ? mplan.planTargets(p, { have: rec.have, left: rec.left ?? null, scale, whole: !!rec.whole }) : [];
  if (pass && targets.length) targets = [{ ...targets[0], key: "pass", label: "зачёт" }];
  // План Moodle только с проходным баллом («не менее 60 из 100»): у зачёта это и есть порог, у экзамена — строкой.
  let planPass = null;
  if (!targets.length && full && plan?.status === "pass" && plan.pass != null && fitsMax(plan)) {
    if (pass) targets = [{ ...mplan.planTargets({ thresholds: { 3: plan.pass, 4: plan.pass, 5: plan.pass }, unit: "pts", strict: {} }, { have: rec.have, left: rec.left ?? null, scale, whole: !!rec.whole })[0], key: "pass", label: "зачёт" }];
    else { planPass = plan.pass; from = "moodle"; }
  }
  // Порогов для расчёта нет — почему; и пороги дисциплины из журнала (в % рейтинга), если шкала таблицы неизвестна.
  const planBands = !targets.length && !sure && fromEj ? `пороги дисциплины в журнале (в % рейтинга): ${bandsText(fromEj, pass)}` : null;
  const planNote = targets.length || planPass != null ? null
    : !sure ? rec.note || (scale == null ? "максимум баллов в таблице не указан — сколько не хватает до оценки, не посчитать" : "таблицу разобрать уверенно не получилось — сверьте с ней сами")
    : !full ? `таблица, похоже, охватывает только часть дисциплины (из ${dec(scale)}) — пороги оценки к ней не применить`
    : plan?.status === "ambiguous" ? "в рейтинг-плане пороги отдельно для каждого института — посмотрите свой в плане"
    : plan?.status === "unparsed" ? "пороги в рейтинг-плане записаны так, что разобрать их не получилось — посмотрите план"
    : fromEj || plan?.thresholds || sheetPlan?.thresholds ? `пороги из журнала и рейтинг-плана рассчитаны на другую шкалу, а в таблице — из ${dec(scale)}`
    : "пороги оценок не нашлись ни в электронном журнале, ни в рейтинг-плане курса";
  const g = rec.grade?.value;
  return {
    source: "sheet", scale: sure ? scale : null, have: rec.have, left: sure ? rec.left ?? null : null, pending: rec.pending ?? null,
    max: sure && rec.left != null ? r1(Math.min(scale, rec.have + rec.left)) : null,
    targets, failed: [], grade: typeof g === "number" && Number.isInteger(g) && g >= 2 && g <= 5 ? g : null,
    gradeText: g != null && typeof g !== "number" ? String(g).slice(0, 40) : null,
    confidence: rec.confidence, full, note: rec.note ?? null, thresholdsFrom: from, planBands, planNote, planPass, planUrl: planUrl ?? null,
    parts: sure ? (rec.parts || []).map((x) => ({ name: SHEET_PART[x.kind] || "Работы", have: x.have, max: x.max })) : [],
    totalLabel: rec.total?.label ? String(rec.total.label).replace(/\s+/g, " ").slice(0, 80) : null,
    sheet: { ...(rec.src || {}), sheet: rec.sheet ?? null, group: rec.groupCode ?? null, groupRel: rec.groupRel ?? null, match: rec.match ?? null },
  };
}
/**
 * Откуда баллы дисциплины (чистая функция, для стенда): таблица преподавателя на всю дисциплину, разобранная уверенно,
 * главнее журнала оценок Moodle (просьба владельца: «в Moodle не всегда актуальная информация»); дальше — как было:
 * Moodle, когда там есть оценки, иначе таблица на часть дисциплины или без максимума, иначе Moodle (если журнал ничего
 * не дал) или электронный журнал (в нём хотя бы пороги). Сюда приходят только дисциплины без оценок в журнале.
 */
export function pickScore({ controls = true, ejSc = null, mv = null, sv = null } = {}) {
  if (!controls) return null;
  if (sv?.full) return sv;
  if (mv && mv.graded > 0) return mv;
  if (sv) return sv;
  return mv && !ejSc ? mv : ejSc;
}
const KIND_RU = { lecture: "Лекция", lab: "Лабораторная", practice: "Практика", lesson: "Занятие" };
/**
 * Семестр журнала ej («Осенний семестр 26–27 г.») совпадает с семестром курсов Moodle — по тому же календарю, что и
 * moodle.currentSemester (осень — август–январь): иначе в конце августа весенний журнал сопоставлялся с осенними курсами.
 */
function ejThisSemester(ejData, now = Date.now()) {
  const s = String(ejData?.semester || "");
  const autumn = /^осень/i.test(moodle.currentSemester(new Date(now)));
  return /^осенн/i.test(s) ? autumn : /^весенн/i.test(s) ? !autumn : true;
}
/**
 * Дисциплины журнала ej без курса среди курсов Moodle этого семестра (16 окт 2026, владелец: «при расхождении лучше
 * уточнять информацию у самого студента, существует ли у него такой курс или нет» — бот спрашивает, attendance.mjs).
 * Пара — взаимная, как в journalSheets: «Теория информационных процессов и систем» курс «Моделирование информационных
 * процессов и систем» не получает. Курсы — из прочитанных дедлайнов d (курсы семестра с ручным выбором студента) и
 * курсы прошлых семестров, о которых его уже спрашивают (d.pendingCourses): такой курс в Moodle есть. Одноимённые
 * дисциплины журнала (два журнала одной дисциплины) делят пару первой. null — сравнивать не с чем: курсов ещё нет (после
 * перезапуска, Moodle на паузе), журнал другого семестра или без курса больше половины дисциплин — это не расхождение, а
 * Moodle, ещё не заполненный к семестру (курсы заводят и записывают позже журнала), или курсы, названные совсем иначе:
 * вопрос о каждой дисциплине был бы ворохом неверных вопросов (проверка 16 окт). Чистая функция.
 */
export function unmatchedSubjects(ejData, d, now = Date.now()) {
  const courses = [...(d?.courses || []), ...(d?.pendingCourses || [])];
  const subjects = ejData?.subjects || [];
  if (!courses.length || !subjects.length || !ejThisSemester(ejData, now)) return null;
  const un = subjects.filter((s) => { const mc = findBy(courses, s.name), back = mc && findBy(subjects, mc.name); return !(back && normName(back.name) === normName(s.name)); });
  return un.length * 2 > subjects.length ? null : un;
}
/**
 * Пары «ключ «Сессии» ↔ дисциплина журнала» (arrange.pairs) для данных журнала ejData: те же план, курсы и дата, что у
 * overview, — значит, те же ключи. Без группы — пар нет («Сессии» без группы нет). courses — курсы Moodle семестра
 * (по умолчанию — из уже прочитанных дедлайнов; в Moodle отсюда не ходим).
 */
export async function journalPairs(tgId, ejData, { courses = null, now = Date.now() } = {}) {
  if (!ejData?.subjects?.length) return [];
  const prof = await users.profile(tgId);
  if (!prof.group) return [];
  const plan = await curriculum.status(prof.group, now).catch(() => null);
  let mc = courses;
  if (!mc) { const token = await users.moodleToken(tgId); mc = (token && moodle.staleDeadlines(token)?.courses) || []; }
  return arrange({ plan: plan?.subjects ? plan : null, journal: ejData, mcourses: mc, today: curriculum.todayMsk(now) }).pairs;
}
/** Отметки «Не моё» «Сессии» по дисциплинам журнала (hiddenByJournal); отметок нет — пустая карта, план не читается. */
export async function sessionMarks(tgId, ejData, opts = {}) {
  const hidden = (await users.sessionChoices(tgId)).hidden;
  if (!Object.keys(hidden).length) return new Map();
  return hiddenByJournal(await journalPairs(tgId, ejData, opts), hidden);
}
/**
 * Журнал для вкладки «Журнал» и /journal (16 окт 2026): дисциплины, которые студент назвал не своими (в боте или в
 * «Сессии»), — не прячутся молча, а идут отдельным списком notMine (у каждой from: "bot" | "session"); subjects и
 * summary (средние, пропуски) — без них. ejData (кэш ej) не меняется — новый объект. Возвращает { data, off }, off —
 * Map id (строкой) → from: по нему же отсеиваются таблицы преподавателей этих дисциплин.
 */
export async function journalView(tgId, ejData) {
  if (!Array.isArray(ejData?.subjects)) return { data: ejData, off: new Map() };
  const [asked, byJ] = await Promise.all([notify.peekState(tgId).then((s) => s.journalAsk || {}, () => ({})),
    sessionMarks(tgId, ejData).catch((e) => { console.log(`journal-view ${tgId}: ${e.message || e}`); return new Map(); })]);
  const off = notMineIds(ejData.subjects, asked, byJ);
  if (!off.size) return { data: { ...ejData, notMine: [] }, off };
  const mine = ejData.subjects.filter((s) => !off.has(String(s.id)));
  const notMine = ejData.subjects.filter((s) => off.has(String(s.id))).map((s) => ({ ...s, from: off.get(String(s.id)) }));
  return { data: { ...ejData, subjects: mine, summary: ej.summaryOf(mine), notMine }, off };
}
/** «Вернуть» дисциплину журнала (attendance.restoreMine): снять «Не моё» «Сессии» с её пары. Возвращает число снятых. */
export async function unhideJournal(tgId, ejId) {
  const hidden = (await users.sessionChoices(tgId)).hidden;
  if (!Object.keys(hidden).length) return 0;
  const j = ej.lastGood(tgId) || await ej.journal(tgId).catch(() => null);
  let n = 0;
  for (const p of await journalPairs(tgId, j)) {
    if (String(p.ejId) !== String(ejId) || !hidden[p.key]) continue;
    await users.setSessionChoice(tgId, "hidden", p.key, null);
    n++;
  }
  return n;
}
/**
 * Уточнение «Сессии» (POST api/session/choice). «Вернуть» скрытое (hidden → null) снимает и ответ «не моя» в боте у
 * пары из журнала (attendance.answerAsk: «моя», владельцу — как обычный ответ): иначе дисциплина осталась бы скрытой.
 */
export async function choose(tgId, kind, key, value) {
  await users.setSessionChoice(tgId, kind, key, value);
  if (kind !== "hidden" || value !== null) return;
  const asked = (await notify.peekState(tgId)).journalAsk || {};
  if (!Object.values(asked).some((q) => q?.answer === "no")) return;
  const j = ej.lastGood(tgId) || await ej.journal(tgId).catch(() => null);
  for (const p of await journalPairs(tgId, j)) if (p.key === key && asked[p.ejId]?.answer === "no") await attendance.answerAsk(tgId, String(p.ejId), true);
}
/**
 * Посещения и баллы из таблиц преподавателей для вкладки «Журнал» (просьба владельца, 15 окт 2026: «если в курсе нет
 * информации о баллах или посещениях — смотреть таблицы»). Курсы Moodle семестра (из прочитанных дедлайнов), по
 * которым электронный журнал не знает посещений или оценок: дисциплины нет в журнале, или в ней нет ни одной отметки
 * о посещении, или ни одной оценки (у дисциплины, чьи подробности не загрузились, — тоже). Журнал другого семестра с
 * курсами не сопоставляется. Без группы в профиле — ничего: по одному ФИО без группы легко взять однофамильца.
 * ejData — данные журнала (или null). Возвращает [{ id: "sheet:<курс>", courseId, ejId (дисциплина журнала, к которой
 * относится, или null), name, attendance (%), lessons, absences, rating (% из 100 — только для таблицы на всю
 * дисциплину), points, sheet, attendanceSheet }] — только своя строка. waitMs — сколько ждать чтения Moodle.
 */
export async function journalSheets(tgId, ejData, { live = true, waitMs = 0, fresh = false } = {}) {
  const token = await users.moodleToken(tgId);
  if (!token) return [];
  const prof = await users.profile(tgId);
  if (!prof.group) return [];
  // Курсы — из прочитанных дедлайнов; после перезапуска сервера их ещё нет — одно чтение (как в overview), но не дольше
  // waitMs: иначе первый заход во «Журнал» после перезапуска был без таблиц до «Обновить» (проверка на стенде 16 окт).
  let d = moodle.staleDeadlines(token);
  if (!d && live) {
    const load = moodle.deadlines(token).catch(() => null);
    let timer;
    d = waitMs ? await Promise.race([load, new Promise((r) => { timer = setTimeout(() => r(null), waitMs); timer.unref?.(); })]).finally(() => clearTimeout(timer)) : await load;
  }
  const courses = d?.courses || [];
  if (!courses.length) return [];
  const ejs = ejThisSemester(ejData) ? ejData?.subjects || [] : [];
  const pair = new Map();
  for (const c of courses) {
    const js0 = findBy(ejs, c.name);
    const js = js0 && findBy(courses, js0.name) === c ? js0 : null;
    const hasAtt = !!js && !js.error && !!js.lessons && js.lessons.present + js.lessons.absent > 0;
    const hasMarks = !!js && !js.error && (js.works || []).some((w) => w.mark != null);
    if (!(js && hasAtt && hasMarks)) pair.set(c.id, { course: c, js, hasAtt, hasMarks });
  }
  if (!pair.size) return [];
  const got = await courseSheets.forCourses(token, [...pair.keys()], { live, group: prof.group, waitMs, fresh });
  const out = [];
  for (const [id, { course, js, hasAtt, hasMarks }] of pair) {
    const g = got.get(id);
    const att = !hasAtt ? g?.attendance : null;
    const rec = !hasMarks && g?.record?.have != null ? g.record : null;
    if (!att && !rec) continue;
    const sv = rec ? sheetScoreView(rec, { ej: js?.thresholds ?? null }) : null;
    const who = (r) => ({ groupRel: r.groupRel ?? null, match: r.match ?? null, group: r.groupCode ?? null });
    out.push({
      // ejKnown — сервер сопоставлял с журналом этого семестра: ejId null значит «в журнале нет», и приложение не должно
      // приклеивать карточку по названию к дисциплине из своей старой копии журнала (другого семестра).
      id: `sheet:${id}`, courseId: id, ejId: js?.id ?? null, ejKnown: ejs.length > 0, name: js?.name || course.name,
      attendance: att?.percent ?? null,
      lessons: att ? { past: att.past, present: att.present, absent: att.absent, excused: att.excused, unmarked: att.unmarked, missedHours: att.missedHours } : null,
      absences: att ? att.absences.map((a) => ({ date: a.date, kind: KIND_RU[a.kind] || "Занятие", n: a.n ?? null, hours: 2, excused: !!a.excused })) : [],
      rating: sv?.full ? r1((sv.have / sv.scale) * 100) : null,
      points: sv ? { have: sv.have, scale: sv.scale, left: sv.left, parts: sv.parts, label: sv.totalLabel, confidence: sv.confidence, full: !!sv.full, note: sv.planNote } : null,
      sheet: rec ? { ...rec.src, sheet: rec.sheet ?? null, ...who(rec) } : att ? { ...att.src, sheet: att.sheet ?? null, groupRel: att.groupRel ?? null, match: att.match ?? null, group: att.group ?? null } : null,
      attendanceSheet: att ? { ...att.src, sheet: att.sheet ?? null, groupRel: att.groupRel ?? null, match: att.match ?? null, group: att.group ?? null } : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "ru"));
}

/**
 * Почему нет баллов журнала (journal.state сводки): j — загруженный журнал, ejSt — users.ejState, jErr — ошибка загрузки.
 * rejected — MISIS ID не принял сохранённый пароль (он забыт): «возможно, сменили», как во вкладке «Журнал», а не «вход
 * истёк» — и когда банки входа уже нет (connected false), иначе вышло бы «журнал не подключён».
 */
export function journalState(j, ejSt, jErr = null) {
  return j ? { state: "ok", at: j.at ?? null }
    : ejSt?.rejected ? { state: "rejected" }
    : !ejSt?.connected ? { state: "not_connected" }
    : jErr?.code === "need_password" || /пароль/i.test(ejSt.error || "") ? { state: "need_password" }
    : { state: jErr ? "error" : "not_loaded", error: jErr ? String(jErr.message || jErr) : null };
}

/**
 * Сводка для пользователя: { needGroup } | { group, course, semester, session, upcoming, periods, program, planError,
 * exams: { published, at, title, url, page }, subjects: [...с score], counts, risks, at }. now — для стенда.
 */
export async function overview(tgId, now = Date.now(), { live = true, loadJournal = live, loadMoodle = live } = {}) {
  const prof = await users.profile(tgId);
  if (!prof.group) return { needGroup: true, group: null, at: now };
  const [plan, ex, info, choices, asked] = await Promise.all([curriculum.status(prof.group, now), session.examsFor(prof.group), session.info(), users.sessionChoices(tgId),
    notify.peekState(tgId).then((s) => s.journalAsk || {}, () => ({}))]);
  // Журнал — уже загруженный; нет его в памяти (перезапуск) — одна загрузка (держится 10 минут), без неё баллов не будет.
  // Не загрузился — приложение и бот говорят почему (15 окт 2026 у 4 из 7 пользователей истёк вход MISIS ID, а «Сессия»
  // писала «этой дисциплины нет в электронном журнале»).
  const ejSt = await users.ejState(tgId);
  let j = ej.lastGood(tgId), jErr = null;
  if (!j && loadJournal && ejSt.connected) j = await ej.journal(tgId).catch((e) => { jErr = e; return null; });
  const journal = journalState(j, ejSt, jErr);
  // Курсы Moodle этого семестра (из уже прочитанных дедлайнов): какую дисциплину по выбору взял студент, академическая
  // разница и пересдачи, баллы по дисциплинам, которых нет в журнале.
  // После перезапуска сервера списка ещё нет (фон перечитывает его через ~10 мин) — одна загрузка, иначе «не нашлось в
  // Moodle» значило бы «ещё не читали»: варианты по выбору открывались, академическая разница и пересдачи пропадали.
  const token = await users.moodleToken(tgId);
  let d = token ? moodle.staleDeadlines(token) : null;
  if (!d && token && loadMoodle) d = await moodle.deadlines(token).catch(() => null);
  const moodleState = { state: !token ? "not_connected" : d ? "ok" : "not_loaded" };
  const today = curriculum.todayMsk(now);
  const ar = arrange({ plan: plan?.subjects ? plan : null, journal: j, mcourses: d?.courses || [], today, choices, asked });
  if (ar.journalSkipped) Object.assign(journal, { state: "other_semester", semester: j?.semester ?? null });
  const subjects = ar.subjects;
  // Посещаемость, рейтинг и несданные работы уже есть во вкладке «Журнал» и в «Дедлайнах» (просьба владельца, 15 окт
  // 2026: не дублировать) — здесь по каждой дисциплине только баллы до оценки: есть, нужно, можно ещё набрать.
  // Баллы: из электронного журнала, если там по дисциплине уже есть оценки; иначе — из журнала оценок Moodle и
  // рейтинг-плана курса (у части преподавателей баллы только в Moodle: «Цифровая электроника», «Моделирование…»).
  const want = [];
  for (const s of subjects) {
    s.examDates = (ex?.list || []).filter((e) => sameName(e.name, s.name)).map((e) => ({ date: e.date, time: e.time, kind: e.kind, place: e.place, teacher: e.teacher }));
    s.inJournal = !!s._js;
    s._ejMarks = !!s._js && (s._js.works || []).some((w) => w.mark != null);
    if (!(s.controls.length && !s._ejMarks && token)) s._mc = null;
    if (s._mc) want.push(s._mc.id);
  }
  // Таблицы преподавателей в тех же курсах (course-sheets.mjs) — параллельно с журналом оценок Moodle. Чтение Moodle
  // ждём не дольше 12 с, дальше — что уже прочитано (доскачивание продолжится, при следующем открытии будет готово).
  const [fromMoodle, fromSheets] = await Promise.all([
    want.length ? moodle.courseScores(token, want, { live }).catch((e) => { console.log(`session-moodle ${tgId}: ${e.message || e}`); return moodle.courseScores(token, want, { live: false }).catch(() => new Map()); }) : new Map(),
    want.length ? courseSheets.forCourses(token, want, { live, group: prof.group, waitMs: 12e3 }).catch((e) => { console.log(`session-sheets ${tgId}: ${e.message || e}`); return new Map(); }) : new Map(),
  ]);
  for (const s of subjects) {
    const pass = s.pass && !s.exam && !s.graded;
    const m = s._mc ? fromMoodle.get(s._mc.id) : null;
    const mv = m?.items ? moodleScoreView({ courseId: s._mc.id, items: m.items, plan: m.plan?.text, cmid: m.plan?.cmid, loaded: !!m.plan }, { group: prof.group, pass }) : null;
    // Таблица преподавателя в курсе (своя строка с баллами) — главнее журнала оценок Moodle; пороги — журнала, плана
    // Moodle или плана в Excel (pickScore, sheetScoreView).
    const sh = s._mc ? fromSheets.get(s._mc.id) : null;
    const sv = sh?.record?.have != null ? sheetScoreView(sh.record, { ej: s._js?.thresholds ?? null, plan: m?.plan?.text ? mplan.parsePlan(m.plan.text) : null, sheetPlan: sh.plan, pass,
      planUrl: m?.plan?.cmid ? `${BASE}/mod/page/view.php?id=${m.plan.cmid}` : null }) : null;
    const ejSc = scoreOf(s._js, { pass });
    s.score = pickScore({ controls: s.controls.length > 0, ejSc, mv, sv });
    s.moodleCourse = s._mc ? { id: s._mc.id, name: s._mc.name } : null;
    // Таблица нашлась, но баллы из неё не взяты — почему (однофамильцы, не прочиталась).
    const amb = sh?.files?.find((f) => f.status === "ambiguous"), bad = sh?.files?.find((f) => f.status === "error" && /журнал|ведомост|балл|рейтинг|брс|итог/i.test(`${f.title} ${f.file}`));
    s.sheetNote = s.score?.source === "sheet" ? null
      : amb ? `в таблице «${amb.title || amb.file}» несколько строк с вашими фамилией и именем — баллы из неё не взяты, сверьте сами`
      : bad && !sh?.record ? (bad.transient ? `таблицу «${bad.title || bad.file}» из курса пока не удалось скачать — попробую ещё раз через несколько минут` : `таблицу «${bad.title || bad.file}» из курса прочитать не удалось (${bad.error})`)
      : null;
    // Баллов онлайн нет совсем (английский) — справка из рабочей программы, а не «баллы неизвестны». Есть баллы в журнале,
    // оценки в Moodle или своя строка в таблице преподавателя — справки нет: её «у вас нет баллов» спорило бы с ними.
    const online = s.inJournal || !!sh?.record || (s.score && (s.score.source === "ej" || s.score.source === "sheet" || s.score.graded > 0));
    s.info = s.controls.length && !online ? subjectInfo(plan?.program?.url, s) : null;
    delete s._js; delete s._ejMarks; delete s._mc;
    // Порог уже не набрать даже со всеми оставшимися работами — это и есть риск по допуску.
    const low = s.score?.targets[0];
    s.level = !s.score ? "ok" : low && low.reachable === false ? "red" : s.score.failed.length ? "yellow" : "ok";
  }
  // Вне плана группы: баллы — только из журнала; курс Moodle — ссылкой.
  const extra = ar.extra.map((x) => {
    const score = x._js ? scoreOf(x._js, { pass: x.pass }) : null;
    return { key: x.key, name: x.name, why: x.why, label: x.label, planSemesters: x.planSemesters, month: x.month ?? null, inJournal: !!x._js, score,
      course: x.course ? { ...x.course, url: `${BASE}/course/view.php?id=${x.course.id}` } : null,
      level: score?.targets[0]?.reachable === false ? "red" : "ok" };
  });
  const optional = ar.optional.map((s) => ({ key: s.key, index: s.index, name: s.name, labels: s.labels }));
  // from — где студент сказал «не моё» последним: "session" — здесь, "bot" — ответом на вопрос бота о дисциплине журнала.
  const hidden = ar.hidden.map((s) => ({ key: s.key, index: s.index ?? null, name: s.name, labels: s.labels ?? (s.label ? [s.label] : []), from: s.hiddenFrom || "session" }));
  for (const s of subjects) { delete s._js; delete s._mc; }
  return {
    group: prof.group, course: plan?.course ?? null, semester: plan?.semester ?? null, session: plan?.session ?? null, upcoming: plan?.upcoming ?? null,
    periods: plan?.periods ?? [], program: plan?.program ?? null, planError: plan?.error ?? null, today,
    exams: { published: !!ex, at: ex?.seenAt ?? null, title: ex?.title ?? null, url: ex?.url ?? null, page: info.page, checkedAt: info.at || null },
    subjects, optional, extra, hidden, counts: ar.counts, journal, moodle: moodleState,
    risks: subjects.filter((s) => s.level === "red").length + extra.filter((x) => x.level === "red").length, journalAt: j?.at ?? null, at: now,
  };
}

// ---------- текст для бота ----------
const examLine = (s) => {
  const e = s.examDates.find((x) => x.kind === "exam") || s.examDates[0];
  const when = e ? `${dayText(e.date)}${e.time ? `, ${e.time}` : ""}${e.place ? `, ${e.place}` : ""}` : "";
  return `• ${s.name}${when ? ` — ${when}` : ""}`;
};
const num = (v) => String(Math.round(v * 10) / 10).replace(".", ",");
/** Сколько не хватает — с округлением вверх до десятых: 0,04 → «0,1», а не «0» при невзятом пороге. */
const up = (v) => String(Math.ceil(Math.round(v * 100) / 10) / 10).replace(".", ",");
/** «• ОКСП: 33 → на 3 ещё 29,2, на 4 ещё 38,4, на 5 ещё 53,7 (можно набрать 68,1)»; из Moodle — с пометкой источника. */
const scoreLine = (s) => {
  const sc = s.score, parts = sc.targets.map((t) => (t.done ? `${t.label} ✓` : `${t.label} ещё ${up(t.need)}${t.reachable === false ? " ⚠️" : ""}`));
  if (sc.source === "sheet") {
    // «• Методы оптимизации: 14,6 из 100 по таблице «Журнал» (14 окт) → на 3 ещё 40,5 … (можно набрать 79)».
    const when = sc.sheet?.modified ? ` (${dayText(new Date(sc.sheet.modified + 3 * 3600e3).toISOString().slice(0, 10))})` : "";
    const head = `• ${s.name}: ${num(sc.have)}${sc.scale != null ? ` из ${num(sc.scale)}` : ""} по таблице «${sc.sheet?.title || sc.sheet?.file || "преподавателя"}»${when}${sc.totalLabel && sc.scale == null ? ` — «${sc.totalLabel}»` : ""}${sc.gradeText || sc.grade ? `, в таблице: ${sc.gradeText || sc.grade}` : ""}`;
    const caveat = sc.sheet?.match === "initials" ? " (строка найдена по фамилии и инициалам — сверьте)" : sc.sheet?.groupRel === "other" ? ` (строка на листе группы ${sc.sheet.group} — сверьте)` : "";
    if (parts.length) return `${head}${caveat} → ${parts.join(", ")}${sc.left != null ? ` (можно набрать ${num(sc.left)})` : ""}`;
    return `${head}${caveat}${sc.planPass != null ? ` — проходной балл по рейтинг-плану: ${num(sc.planPass)}` : sc.planBands ? ` — ${sc.planBands}${sc.planNote ? `; ${sc.planNote}` : ""}` : sc.planNote ? ` — ${sc.planNote}` : ""}`;
  }
  if (sc.source !== "moodle") return `• ${s.name}: ${num(sc.have)} → ${parts.join(", ")}${sc.left != null ? ` (можно набрать ${num(sc.left)})` : ""}`;
  const word = (n, one, few, many) => plural(n, one, few, many).replace(/^\d+ /, "");
  // «Без оценки», а не «ждут проверки»: журнал оценок не знает, сдана ли работа (тест без оценки — скорее не пройден).
  const head = `• ${s.name}: ${num(sc.have)}${sc.scale != null ? ` из ${num(sc.scale)}` : ""} по Moodle (оценено ${sc.graded} ${word(sc.graded, "работа", "работы", "работ")}${sc.pending ? `, ещё ${sc.pending} без оценки` : ""})`;
  if (parts.length) return `${head} → ${parts.join(", ")}${sc.left ? ` (можно набрать ${num(sc.left)})` : ""}`;
  return `${head} — ${sc.planBands ? `пороги по рейтинг-плану: ${sc.planBands}${sc.note ? `; ${sc.note}` : ""}` : sc.planPass != null ? `проходной балл по рейтинг-плану: ${num(sc.planPass)}` : sc.planNote || "порогов в рейтинг-плане нет"}`;
};
/** Почему нет баллов журнала — одна строка для бота (в приложении — плашка с переходом в «Журнал»). */
export const JOURNAL_NOTE = {
  need_password: "Вход в электронный журнал истёк — баллов из журнала нет. Откройте Doodle → Журнал и введите пароль ещё раз.",
  rejected: "Сохранённый пароль от журнала не подошёл — возможно, вы его сменили. Баллов из журнала нет. Откройте Doodle → Журнал и введите текущий пароль.",
  not_connected: "Электронный журнал не подключён — баллов из журнала нет. Подключить: Doodle → Журнал.",
  error: "Электронный журнал сейчас не отвечает — баллы из журнала не показаны.",
  not_loaded: "Электронный журнал ещё не загружен — баллы и выбор дисциплин из журнала не учтены.",
  other_semester: "Электронный журнал пока показывает другой семестр — баллы и выбор дисциплин из него не учтены.",
};
/** Курсы Moodle не прочитаны — что из-за этого не показано. */
export const MOODLE_NOTE = "Курсы Moodle сейчас не прочитаны — пересдачи, академическая разница и баллы из Moodle не показаны.";
/** Почему не ясно, какой вариант дисциплины по выбору взят: не нашёлся, нашлось несколько или источники ещё не прочитаны. */
const openWhy = (o) => (o.journal?.state !== "ok" && o.moodle?.state !== "ok" ? "журнал и курсы Moodle ещё не прочитаны"
  : o.journal?.state !== "ok" ? "журнал не загружен, а по курсам Moodle однозначно не определить"
  : o.moodle?.state !== "ok" ? "курсы Moodle ещё не прочитаны, а по журналу не видно"
  : "ни журнал, ни курсы Moodle однозначно этого не показывают");
/** Названия через «; », варианты одной дисциплины по выбору (не знаем, какую взял) — «А / Б (одна на выбор)». */
const names = (list) => {
  const out = [], seen = new Set();
  for (const x of list) {
    if (!x.electiveOpen) { out.push(x.name); continue; }
    if (seen.has(x.elective)) continue;
    seen.add(x.elective);
    out.push(`${list.filter((y) => y.elective === x.elective).map((y) => y.name).join(" / ")} (одна на выбор)`);
  }
  return out.join("; ");
};
const semText = (a) => (a?.length ? `${[...new Set(a)].sort((x, y) => x - y).join(", ")} семестр` : "");
/** Дисциплина вне плана группы на этот семестр: пересдача, академическая разница или только в журнале. */
const extraLine = (x) => {
  const why = x.why === "retake" ? `пересдача${x.month ? ` (курс Moodle на ${MONTHS_N[+x.month.slice(5, 7) - 1]} ${x.month.slice(0, 4)})` : ""}`
    : x.why === "earlier" ? `похоже на академическую разницу (в плане группы — ${semText(x.planSemesters)})`
    : "есть в электронном журнале, в плане группы на этот семестр нет";
  return `• ${x.name}${x.label ? ` (${x.label})` : ""} — ${why}`;
};
/** Справка по дисциплине без баллов онлайн (английский): пороги из рабочей программы. */
const infoLine = (s) => `ℹ️ ${s.name}: баллов и пропусков нет ни в электронном журнале, ни в Moodle — их ведёт преподаватель. По рабочей программе из ${s.info.scale}: ${s.info.bands}. Сколько у вас баллов и пропусков, уточните у преподавателя.`;
/** Сводка «Сессия» для команды /session и уведомлений: строка текста. */
export function summaryText(o) {
  if (o.needGroup) return "🎓 Сессия\nГруппа не выбрана — укажите её в приложении: Профиль → группа.";
  const head = `🎓 Сессия${o.semester ? ` · ${o.semester} семестр` : ""}`;
  const out = [head];
  const s = o.upcoming;
  if (s) {
    const when = `${s.label} сессия ${rangeText(s.from, s.to)}${s.from.slice(0, 4) !== o.today.slice(0, 4) ? ` ${s.from.slice(0, 4)}` : ""}`;
    out.push(s.state === "now" ? `Идёт ${when} — до конца ${plural(s.days, "день", "дня", "дней")}.` : s.days === 0 ? `Сегодня начинается ${when}.` : `До сессии ${plural(s.days, "день", "дня", "дней")}: ${when}.`);
    const study = o.periods.find((p) => p.kind === "theory" && p.to < s.from && p.to >= addDays(s.from, -14));
    if (study && s.state === "ahead") out.push(`Зачёты — на последних занятиях, курсовые — на последней учебной неделе (до ${dayText(study.to, true)}).`);
  } else if (o.planError) out.push(`Учебный план группы не найден: ${o.planError}.`);
  if (o.counts && (o.counts.exam || o.counts.graded || o.counts.pass)) out.push(curriculum.countsText(o.counts) + ".");
  const jl = JOURNAL_NOTE[o.journal?.state];
  if (jl) out.push(`⚠️ ${jl}`);
  if (o.moodle?.state === "not_loaded") out.push(`⚠️ ${MOODLE_NOTE}`);
  const exams = o.subjects.filter((x) => x.exam), graded = o.subjects.filter((x) => x.graded && !x.exam), pass = o.subjects.filter((x) => x.pass && !x.exam && !x.graded), kr = o.subjects.filter((x) => x.coursework);
  if (exams.length) out.push("", "📝 Экзамены:", ...exams.map((x) => examLine(x) + (x.electiveOpen ? " (по выбору)" : "")));
  if (graded.length) out.push("", `✅ Зачёты с оценкой: ${names(graded)}`);
  if (pass.length) out.push("", `✅ Зачёты: ${names(pass)}`);
  if (kr.length) out.push("", `📚 Курсовые: ${names(kr)}`);
  if (o.subjects.some((x) => x.electiveOpen)) out.push("", `Какую дисциплину по выбору вы взяли, не ясно (${openWhy(o)}) — показаны варианты.`);
  if (o.optional?.length) out.push("", `Факультативы (необязательные; аттестация — только если вы на них записались): ${o.optional.map((x) => `${x.name}${x.labels.length ? ` — ${x.labels.join(", ")}` : ""}`).join("; ")}`);
  if (o.extra?.length) out.push("", "📌 Вне плана группы на этот семестр:", ...o.extra.map(extraLine));
  if (o.subjects.some((x) => x.electiveOpen) || o.extra?.length || o.optional?.length) out.push("Что-то не так (перевелись, другой предмет по выбору, перезачли)? Уточните в приложении: Журнал → Сессия.");
  // Скрытое студентом («Не моё» здесь или «не моя» в боте) — не молча: одна строка, чтобы ошибку было видно.
  if (o.hidden?.length) out.push("", `🚫 Вы отметили как не ваши (в приложении или в боте) — в сводке не считаются: ${o.hidden.map((x) => x.name).join("; ")}. Вернуть: Doodle → Журнал → Сессия.`);
  const scored = [...o.subjects, ...(o.extra || [])].filter((x) => x.score);
  if (scored.length) out.push("", "🎯 Баллы: есть → не хватает (электронный журнал — из 100)", ...scored.map(scoreLine));
  if (scored.some((x) => x.level === "red")) out.push("⚠️ — порог уже не набрать оставшимися работами: стоит поговорить с преподавателем.");
  if (scored.length) out.push(`Расчёт ориентировочный (электронный журнал, оценки и рейтинг-планы Moodle${scored.some((x) => x.score.source === "sheet") ? ", таблицы преподавателей в курсах" : ""}) — уточните у преподавателя.`);
  const sn = o.subjects.filter((x) => x.sheetNote);
  if (sn.length) out.push(...sn.map((x) => `ℹ️ ${x.name}: ${x.sheetNote}.`));
  const info = o.subjects.filter((x) => x.info);
  if (info.length) out.push("", ...info.map(infoLine));
  if (o.exams.published) out.push("", `Расписание экзаменов опубликовано${o.exams.title ? ` («${o.exams.title}»)` : ""}, даты выше — по нему.`);
  else if (s && s.state !== "past") out.push("", "Расписания экзаменов ещё нет: misis.ru выкладывает его не позже чем за неделю до сессии — сообщу, как появится.");
  return out.join("\n");
}

// ---------- уведомления ----------
const AHEAD_DAYS = [14, 3];
const appButton = async (text = "Открыть в Doodle") => notify.appButton(text, "session");
/*
 * Разовое сообщение «Сессии» (сводка, напоминание об экзамене, даты экзаменов) — один раз на ключ sessionSent[key].
 * Отметка ставится ДО отправки, под замком состояния: одновременный обход (tick раз в 5 минут и рассылка при публикации
 * расписания) второго сообщения не даст. С 15 окт 2026 она снимается, если сообщение точно не дошло — временный сбой
 * (сеть, 5xx, 429) или исключение при сборке текста: следующий tick повторит, пока открыто окно (раньше такое сообщение
 * терялось навсегда, а счётчик «отправлено» врал). make() собирает { text, buttons } уже после отметки; null — слать
 * нечего (досылка, а все экзамены уже прошли): отметка остаётся без отправки. limit — предел повторов
 * (notify.retryExhausted) там, где окно само их не ограничивает.
 * Неоднозначный исход (unknown: таймаут или обрыв после отправки — Telegram мог принять) повторяется один раз и у
 * напоминаний без limit (15 окт 2026): раньше отметка снималась при каждом unknown, и при медленном Telegram
 * «⏰ Завтра экзамен» приходило с каждым tick до конца окна, «📅» — до суток. Точный сбой (сеть, 5xx, 429) — как
 * прежде, повтор, пока открыто окно.
 * pass — один обход (tick или рассылка announce): после исхода «down» (Telegram недоступен, см. notify outcome) остальные
 * сообщения этого обхода не пробуются — ни отметки, ни засчитанной попытки, следующий обход начнёт с них.
 * Возвращает 1, если сообщение дошло.
 */
async function sendOnce(tgId, key, now, make, limit = null, pass = null) {
  if (pass?.down) return 0;
  const due = await notify.withState(tgId, (st) => { st.sessionSent ??= {}; if (st.sessionSent[key]) return false; st.sessionSent[key] = now; return true; });
  if (!due) return 0;
  const lim = limit || { max: Infinity, min: Infinity, ms: Infinity };
  const undo = (r) => notify.withState(tgId, (st) => {
    if (notify.retryExhausted(st, `session:${key}`, r, lim)) return; // попытки кончились (или второй unknown) — отметка остаётся
    if (st.sessionSent?.[key] === now) delete st.sessionSent[key];
  });
  let m, r;
  try { m = await make(); if (m) r = await notify.deliver(tgId, m.text, undefined, m.buttons); }
  catch (e) { await undo({ status: "failed", description: String(e.message || e) }).catch(() => {}); throw e; }
  if (r?.down && pass && !pass.down) { pass.down = true; console.log(`session-notify: Telegram сейчас недоступен (${r.status}) — остальное в этом обходе не отправляю`); }
  if (r && !notify.settled(r)) { await undo(r); return 0; }
  // Дошло, не дойдёт никогда или слать нечего — счётчик попыток больше не нужен (withState без изменений файл не пишет).
  await notify.withState(tgId, (st) => notify.retryClear(st, `session:${key}`));
  return r?.ok ? 1 : 0;
}
/** Сводка за 14 и 3 дня до сессии — по разу; днём (9–21 по Москве). pass — обход (см. sendOnce). Экспорт — для стенда. */
export async function sessionReminders(u, o, now, pass = null) {
  const s = o.upcoming;
  if (!s || s.state !== "ahead" || !AHEAD_DAYS.includes(s.days)) return 0;
  const h = Number(mskParts(now).hour);
  if (h < 9 || h >= 21) return 0;
  // Сводка разовая — пока курсы Moodle не прочитаны (Moodle на паузе или не отвечает), до 18:00 ждём: она ушла бы без
  // пересдач и выбора дисциплин. Позже — отправляем с пометкой (MOODLE_NOTE), чтобы не потерять. Проверка — до отметки.
  if (o.moodle?.state === "not_loaded" && h < 18) return 0;
  return sendOnce(u.tgId, `sess:${s.from}:${s.days}`, now, async () => ({ text: summaryText(o), buttons: await appButton() }), null, pass);
}
/**
 * Накануне экзамена (18–22 по Москве) и утром в день экзамена (7–11, пока экзамен не начался). pass — обход (см.
 * sendOnce); без него — свой на этот вызов (несколько экзаменов в один вечер). Экспорт — для стенда.
 */
export async function examReminders(u, o, now, pass = { down: false }) {
  const h = Number(mskParts(now).hour), hm = `${mskParts(now).hour}:${mskParts(now).minute}`;
  let n = 0;
  for (const s of o.subjects) {
    for (const e of s.examDates.filter((x) => x.kind !== "consult")) {
      const eve = addDays(e.date, -1);
      let slot = null;
      if (o.today === eve && h >= 18 && h < 22) slot = "eve";
      else if (o.today === e.date && h >= 7 && h < 11 && (!e.time || hm < e.time)) slot = "day";
      if (!slot) continue;
      const key = `exam:${e.date}:${s.index || s.name}:${slot}`;
      const what = e.kind === "test" ? "зачёт" : "экзамен";
      // Какой вариант дисциплины по выбору взял студент, неизвестно — напоминаем обо всех, но с оговоркой.
      const maybe = s.electiveOpen ? "\n(если вы выбрали эту дисциплину; отметить свой вариант — Doodle → Журнал → Сессия)" : "";
      const text = slot === "eve" ? `⏰ Завтра ${what}: ${s.name}\n${dayText(e.date, true)}${e.time ? `, ${e.time}` : ""}${e.place ? ` · ${e.place}` : ""}${e.teacher ? ` · ${e.teacher}` : ""}${maybe}`
        : `⏰ Сегодня ${what}: ${s.name}${e.time ? ` в ${e.time}` : ""}${e.place ? ` · ${e.place}` : ""}${e.teacher ? ` · ${e.teacher}` : ""}${maybe}\nУдачи!`;
      // Не дошло — отметка снимается, повтор следующим tick внутри окна (накануне 18–22, в день — 7–11 и до начала);
      // после неоднозначного исхода (unknown) — один повтор, не больше.
      n += await sendOnce(u.tgId, key, now, async () => ({ text, buttons: await appButton() }), null, pass);
    }
  }
  return n;
}
const HOUR = 3600e3;
const reloaded = new Map(); // tgId → когда тик последний раз дочитывал журнал и курсы Moodle
/** Будет ли сейчас что-то отправлено: сводка перед сессией или напоминание об экзамене сегодня или завтра. */
function dueSoon(o, now) {
  const h = Number(mskParts(now).hour), s = o.upcoming;
  if (s && s.state === "ahead" && AHEAD_DAYS.includes(s.days) && h >= 9 && h < 21) return true;
  return o.subjects.some((x) => x.examDates.some((e) => e.date === o.today || addDays(e.date, -1) === o.today));
}
/**
 * Досылка дат экзаменов (tick) человеку группы group: marks — его отметки sessionSent. Берутся файлы с его группой, где
 * экзамены ещё не прошли (until >= today), и из них досылается только самый новый по времени появления на странице
 * (seenAt), если по нему дат человек ещё не получал. Остальные файлы без отметки — superseded: отмечаются без
 * сообщения (15 окт 2026). Раньше досылка шла по каждому файлу, и опоздавший получал в одном обходе два почти
 * одинаковых «📅» — по первой выкладке и по исправленной (тело собирается из общего по группе списка, а кнопка старого
 * файла могла вести на удалённый файл). Возвращает { file: что дослать или null, superseded: [имена] }. Чистая
 * функция (для стенда).
 */
export function lateAnnounce(files, group, today, marks = {}) {
  const g = normGroup(group);
  const mine = files.filter((f) => f.until >= today && f.groups.some((x) => normGroup(x) === g));
  if (!mine.length) return { file: null, superseded: [] };
  const newest = mine.reduce((a, b) => ((b.seenAt || 0) > (a.seenAt || 0) ? b : a));
  return { file: marks[`exams:${newest.name}`] ? null : newest, superseded: mine.filter((f) => f !== newest && !marks[`exams:${f.name}`]).map((f) => f.name) };
}
/** lateAnnounce по отметкам человека. Чтение без записи; от дубля защищает отметка в announceOne. */
async function missedAnnounce(tgId, group, files, today) {
  if (!files.length) return { file: null, superseded: [] };
  return lateAnnounce(files, group, today, (await notify.peekState(tgId)).sessionSent || {});
}
/**
 * Обход всех вошедших: сводки перед сессией и напоминания об экзаменах. Возвращает число отправленных сообщений.
 * at — время обхода (для стенда); по умолчанию «сейчас», взятое ПОСЛЕ session.files(): время экзамена сравнивается с
 * ним («Сегодня экзамен в 9:00» — только до начала), и оно не должно отставать на ожидание списка файлов.
 */
export async function tick(at) {
  let sent = 0;
  // Рассылка дат при публикации (announce) — разовая, по одному файлу: кому она не дошла (сбой Telegram, сервер
  // перезапустили посреди рассылки, человек вошёл или включил сообщения позже), даты досылает этот обход (15 окт 2026).
  const files = (await session.files().catch(() => [])).filter((f) => f.parsed && f.groups.length && f.until);
  const now = at ?? Date.now();
  // Один обход — один предохранитель: Telegram не отвечает (или 429, токен отклонён) — остальным в этом обходе не пишем,
  // следующий tick (5 мин) начнёт с них. Раньше каждое следующее сообщение ждало свой таймаут.
  const pass = { down: false };
  for (const u of await users.allLoggedIn()) {
    if (pass.down) break;
    try {
      if (await notify.isMuted(u.tgId)) continue;
      const prof = await users.profile(u.tgId);
      if (!prof.group) continue;
      let o = await overview(u.tgId, now, { live: false }); // фоновая проверка: только уже прочитанное, в Moodle не ходим
      const late = await missedAnnounce(u.tgId, prof.group, files, o.today);
      // Пора что-то отправить, а журнал или курсы Moodle ещё не прочитаны (перезапуск сервера) — один раз дочитать,
      // иначе сводка ушла бы без баллов и с «не ясно, какой вариант по выбору» (проверка 15 окт).
      // Не чаще раза в час на человека: неудачная загрузка ничего не кладёт в память, и без предела тик (раз в 5 минут)
      // весь день стучался бы в недоступный журнал или Moodle (повторная проверка 15 окт).
      if ((dueSoon(o, now) || late.file) && (o.journal?.state === "not_loaded" || o.moodle?.state === "not_loaded") && now - (reloaded.get(u.tgId) || 0) >= HOUR) {
        reloaded.set(u.tgId, now);
        o = await pace.background("session", () => overview(u.tgId, now, { live: false, loadJournal: true, loadMoodle: true }));
      }
      sent += await sessionReminders(u, o, now, pass);
      sent += await examReminders(u, o, now, pass);
      // Старые выкладки, заменённые более новой, — отмечены без сообщения (??=: отметку идущей отправки не трогаем).
      if (late.superseded.length) await notify.withState(u.tgId, (st) => { st.sessionSent ??= {}; for (const name of late.superseded) st.sessionSent[`exams:${name}`] ??= "superseded"; });
      if (late.file) sent += await announceOne(u, prof, late.file, () => o, { late: true, pass });
    } catch (e) { console.log(`session-notify ${u.tgId}: ${e.message || e}`); }
  }
  return sent;
}

/**
 * Новый файл расписания сессии на misis.ru: тем, чья группа в нём есть, — даты экзаменов; файл не разобран или групп
 * в нём не нашлось — владельцу (поправить session_xls.py под настоящий вид файла).
 */
export async function announce(file) {
  let sent = 0;
  if (!file.parsed || !file.groups.length) {
    await notify.send(users.OWNER_ID, `📅 На misis.ru появился файл расписания сессии «${file.title || file.name}», но разобрать его не удалось${file.error ? ` (${file.error})` : file.skipped?.length ? ` (${file.skipped[0]})` : ""}.\nСтудентам ничего не отправлено. Посмотрите файл и поправьте session_xls.py: ${file.url}`);
    return 0;
  }
  const inFile = new Set(file.groups.map(normGroup));
  // Предохранитель, как в tick: Telegram недоступен — остальным не пробуем; им даты дошлёт tick (их отметок нет).
  const pass = { down: false };
  for (const u of await users.allLoggedIn()) {
    if (pass.down) break;
    try {
      const prof = await users.profile(u.tgId);
      if (!prof.group || !inFile.has(normGroup(prof.group))) continue;
      if (await notify.isMuted(u.tgId)) continue;
      // Разовое событие — журнал и курсы Moodle дочитываются, чтобы варианты по выбору были определены.
      sent += await announceOne(u, prof, file, () => pace.background("session", () => overview(u.tgId, Date.now(), { live: false, loadJournal: true, loadMoodle: true })), { pass });
    } catch (e) { console.log(`session-announce ${u.tgId}: ${e.message || e}`); }
  }
  console.log(`session: «${file.title || file.name}» — разослано ${sent}${pass.down ? " (остальным — следующим обходом: Telegram недоступен)" : ""}`);
  return sent;
}
/**
 * Даты экзаменов из файла file одному человеку (prof — его профиль): из announce при публикации и из tick — тем, кому
 * не дошло. view() → overview (announce дочитывает журнал и курсы Moodle, tick отдаёт уже собранную). Отметка
 * exams:<файл> — до отправки (одновременные announce и tick второго сообщения не дадут), не дошло — снимается; повторы
 * не дольше суток с первой неудачи. Возвращает 1, если сообщение дошло. Экспорт — для стенда.
 * late — досылка из tick (15 окт 2026): в списке только экзамены с сегодняшнего дня, прошедшие не показываем; не
 * осталось ни одного — отметка ставится без сообщения. Раньше опоздавшему (вошёл, когда у его группы экзамены уже
 * кончились, а у других групп файла ещё идут) приходил список сданных экзаменов. «Напомню накануне…» — только когда
 * у человека есть экзамен позже сегодняшнего дня (и при рассылке в момент публикации тоже): иначе обещание ложное.
 * pass — обход (см. sendOnce).
 */
export async function announceOne(u, prof, file, view, { late = false, pass = null } = {}) {
  return sendOnce(u.tgId, `exams:${file.name}`, Date.now(), async () => {
    const o = await view();
    const ahead = (e) => !late || !e.date || e.date >= o.today;
    const subj = o.subjects.map((s) => ({ ...s, examDates: s.examDates.filter(ahead) })).filter((s) => s.examDates.length);
    const lines = subj.map((s) => examLine(s) + (s.electiveOpen ? " (по выбору)" : ""));
    const ex = await session.examsFor(prof.group);
    // Экзамены группы, которых нет у студента: скрытые им («не моё»), невыбранные варианты по выбору, факультативы —
    // не его, о них молчим; остальные (ни на что в плане не похожи) — отдельным списком без обещания напомнить.
    const known = [...o.subjects.flatMap((s) => [s.name, ...(s.variants || []).map((v) => v.name)]), ...(o.hidden || []).map((s) => s.name), ...(o.optional || []).map((s) => s.name)];
    const other = (ex?.list || []).filter((e) => ahead(e) && !known.some((n) => sameName(e.name, n))).map((e) => `• ${e.name} — ${dayText(e.date)}${e.time ? `, ${e.time}` : ""}${e.place ? `, ${e.place}` : ""}`);
    if (late && !lines.length && !other.length) return null; // всё уже прошло — слать нечего, отметка остаётся
    const remind = subj.some((s) => s.examDates.some((e) => e.kind !== "consult" && e.date > o.today));
    const body = [...lines, ...(other.length ? [...(lines.length ? [""] : []), "Есть в расписании группы, в вашем плане не нашлось:", ...other] : [])].join("\n");
    return { text: `📅 Расписание экзаменов опубликовано${file.title ? ` («${file.title}»)` : ""}\nГруппа ${prof.group}:\n${body || "в файле по вашей группе записей нет"}${remind ? "\n\nНапомню накануне каждого из ваших экзаменов." : ""}`,
      buttons: [...(await appButton("Сессия в Doodle") || []), [{ text: "Файл на misis.ru", url: file.url }]] };
  }, { max: Infinity }, pass);
}
session.onNew(announce);
