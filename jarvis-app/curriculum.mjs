// Учебный план группы с misis.ru: когда сессия и какая форма контроля по каждой дисциплине (просьба владельца, 15 окт
// 2026: «Допуск и сессия»). Источник — «Сведения об образовательной организации → Образование → Программы»
// (misis.ru/sveden/education/eduop/): у каждой программы по году набора лежит учебный план «<код>-<ГРУППА>-<ГГ>.plx.pdf»
// (БИСТ-24 → 09.03.02-BIST-24.plx.pdf), утверждается раз в год (май) на следующий учебный год. В плане — календарный
// график по неделям на каждый курс (сессии, каникулы, практика) и таблица дисциплин по семестрам с формой контроля
// (экзамен / зачёт / зачёт с оценкой, курсовая). По распоряжению о сессии её сроки — именно из этого графика; точное
// расписание экзаменов выкладывается отдельно, перед сессией (session.mjs).
//
// Страница программ — 20 МБ (42 тыс. ссылок): перечитывается раз в неделю; план группы скачивается один раз и
// разбирается curriculum_pdf.py (pymupdf); результат — schedule-cache/curriculum/<ГРУППА-ГГ>.json, переживает перезапуск.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normGroup } from "./official.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const CACHE = process.env.CURRICULUM_CACHE || join(DIR, "schedule-cache", "curriculum");
const EDUOP = process.env.MISIS_EDUOP_URL || "https://misis.ru/sveden/education/eduop/";
const SITE = new URL(EDUOP).origin;
const PARSER = join(DIR, "curriculum_pdf.py");
const PARSER_VERSION = 1; // меняется — планы разбираются заново
const INDEX_REFRESH_MS = Number(process.env.CURRICULUM_REFRESH_MS) || 7 * 86400e3, RETRY_MS = 60 * 60e3;
const UA = { "user-agent": "Mozilla/5.0 (Doodle mini app)" };

export const LABEL = { "Эк": "экзамен", "За": "зачёт", "ЗаО": "зачёт с оценкой", "КР": "курсовая работа", "КП": "курсовой проект", "РГР": "расчётно-графическая работа" };
const PERIOD = { "Т": ["theory", "учёба"], "Э": ["exam", "сессия"], "К": ["holiday", "каникулы"], "У": ["practice", "практика"], "П": ["practice", "практика"], "Д": ["diploma", "защита ВКР"], "Н": ["research", "НИР"] };
const ROMAN = ["", "I", "II", "III", "IV", "V", "VI"];
// Имена файлов на сайте латиницей (BIST-24); группы — кириллицей. Соответствие берётся из самой страницы (см. loadIndex),
// это — запасной путь для планов, у которых кириллического упоминания нет.
const LAT2CYR = { B: "Б", I: "И", S: "С", T: "Т", V: "В", P: "П", M: "М", A: "А", E: "Э", K: "К", F: "Ф", G: "Г", D: "Д", N: "Н", R: "Р", O: "О", U: "У", L: "Л", H: "Х", Z: "З", C: "Ц", Y: "Ы", J: "Й", W: "В", X: "Х" };

function python() {
  for (const p of [process.env.PYTHON, "C:\\Program Files\\Python312\\python.exe"]) if (p && existsSync(p)) return p;
  return "python";
}
function parse(file) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PYTHONUSERBASE: process.env.PYTHONUSERBASE || join(userInfo().homedir, "AppData", "Roaming", "Python"), PYTHONIOENCODING: "utf-8" };
    const p = spawn(python(), [PARSER, file], { windowsHide: true, env });
    const out = [], err = [];
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => err.push(d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code) return reject(new Error(`curriculum_pdf.py: ${Buffer.concat(err).toString("utf8").trim().split("\n").pop() || `код ${code}`}`));
      try { resolve(JSON.parse(Buffer.concat(out).toString("utf8"))); } catch (e) { reject(e); }
    });
  });
}

/** «БИСТ-24-ПО-2» → «БИСТ-24» (поток набора, по нему называется план); null — на группу не похоже. */
export function prefixOf(group) {
  const m = /^([А-ЯЁ]{2,8})-(\d\d)(?:-|$)/.exec(normGroup(group));
  return m ? `${m[1]}-${m[2]}` : null;
}
// NFC: на странице misis.ru «й» бывает записана как «и» + отдельный значок — без приведения «Учебный план» не узнаётся.
const stripTags = (s) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;|­/g, " ").replace(/\s+/g, " ").trim().normalize("NFC");

// ---------- список планов ----------
let index = null, indexLoading = null, lastTry = 0; // { at, plans: { "БИСТ-24": { code, url, name } } }
const INDEX_FILE = join(CACHE, "index.json");

/**
 * Разбор страницы программ: ссылки «Учебный план» → по потоку («БИСТ-24», у программ с несколькими траекториями —
 * «БИВТ-24-2»). Имена файлов: «09.03.02-BIST-24.plx.pdf», чаще с номером повторной выкладки «…plx(2).pdf». Кириллическое
 * имя потока берётся из соседней ссылки «Описание результатов … 09.03.02-БИСТ-24.plx»; нет её — транслитерация.
 * Чистая функция (для стенда).
 */
export function parseIndex(html) {
  const cyr = new Map(); // латинский ключ «09.03.02-BIST-24» → «БИСТ-24»
  const plans = [];
  for (const m of html.matchAll(/<a\b[^>]*href="([^"]+\.plx(?:\(\d+\))?\.pdf)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1], text = stripTags(m[2]);
    const name = decodeURIComponent(href.split("/").pop());
    const stem = /(\d\d\.\d\d\.\d\d)-([A-Za-z]+-\d\d(?:-[A-Za-z0-9]+)*)\.plx(?:\(\d+\))?\.pdf$/i.exec(name);
    if (!stem) continue;
    const c = /(\d\d\.\d\d\.\d\d)-([А-ЯЁ]+-\d\d(?:-[А-ЯЁ0-9]+)*)\.plx/i.exec(text);
    if (c) cyr.set(`${stem[1]}-${stem[2]}`.toUpperCase(), c[2].toUpperCase());
    if (/^учебный план/i.test(text)) plans.push({ code: stem[1], lat: stem[2], href, name });
  }
  const out = {};
  for (const { code, lat, href, name } of plans) {
    const prefix = cyr.get(`${code}-${lat}`.toUpperCase()) || lat.toUpperCase().replace(/[A-Z]/g, (ch) => LAT2CYR[ch] || ch);
    if (!out[prefix]) out[prefix] = { code, url: new URL(href, SITE).href, name };
  }
  return out;
}
/** Какой план у группы: самое длинное начало названия, которое есть среди планов («БИВТ-24-2» раньше «БИВТ-24»); null — нет. */
export function planKey(group, plans) {
  const parts = normGroup(group).split("-");
  for (let n = parts.length; n >= 2; n--) { const k = parts.slice(0, n).join("-"); if (plans[k]) return k; }
  return null;
}
async function loadIndex() {
  await mkdir(CACHE, { recursive: true });
  const html = await fetch(EDUOP, { headers: UA, signal: AbortSignal.timeout(120000) }).then((r) => { if (!r.ok) throw new Error(`misis.ru ${r.status}`); return r.text(); });
  const plans = parseIndex(html);
  if (!Object.keys(plans).length) throw new Error("на странице программ не нашлось ни одного учебного плана");
  index = { at: Date.now(), plans };
  await writeFile(INDEX_FILE, JSON.stringify(index));
  console.log(`curriculum: планов на странице программ ${Object.keys(plans).length}`);
  return index;
}
/** Список планов: с диска, перечитывается раз в неделю (в фоне); совсем нет — ждём первой загрузки. */
async function getIndex() {
  if (!index) index = await readFile(INDEX_FILE, "utf8").then(JSON.parse).catch(() => null);
  const stale = !index || Date.now() - index.at > INDEX_REFRESH_MS;
  if (stale && !indexLoading && Date.now() - lastTry > (index ? RETRY_MS : 60e3)) {
    lastTry = Date.now();
    indexLoading = loadIndex().catch((e) => { console.log(`curriculum: список планов не получен (${e.message})`); return index; }).finally(() => { indexLoading = null; });
  }
  if (!index && indexLoading) await indexLoading;
  return index;
}

// ---------- план группы ----------
const plans = new Map(); // «БИСТ-24» → разобранный план
const loading = new Map();
const failed = new Map(); // поток → { at, error }: неудачное скачивание или разбор не повторяем чаще раза в 6 часов (обход идёт каждые 5 минут)
const FAIL_MEMO_MS = 6 * 3600e3;
/** Учебный план потока: { version, url, name, at, program, calendar, subjects }. Ошибка — с понятным текстом. */
export async function planFor(group) {
  const prefix = prefixOf(group);
  if (!prefix) throw new Error(`«${group}» не похоже на название группы`);
  if (loading.has(prefix)) return loading.get(prefix);
  const memo = failed.get(prefix);
  if (memo && Date.now() - memo.at < FAIL_MEMO_MS) throw new Error(memo.error);
  const p = (async () => {
    const idx = await getIndex();
    if (!idx) throw new Error("список учебных планов на misis.ru сейчас недоступен");
    const key = planKey(group, idx.plans) || prefix, entry = idx.plans[key];
    const jsonPath = join(CACHE, `${key}.json`), pdfPath = join(CACHE, `${key}.pdf`);
    let plan = plans.get(key) || (await readFile(jsonPath, "utf8").then(JSON.parse).catch(() => null));
    if (plan && plan.version === PARSER_VERSION && (!entry || plan.url === entry.url)) { plans.set(key, plan); return plan; }
    if (!entry) { if (plan) { plans.set(key, plan); return plan; } throw new Error(`на misis.ru нет учебного плана для потока ${prefix}`); }
    if (!existsSync(pdfPath) || plan?.url !== entry.url) {
      const r = await fetch(entry.url, { headers: UA, signal: AbortSignal.timeout(60000) });
      if (!r.ok) throw new Error(`план ${entry.name}: HTTP ${r.status}`);
      await writeFile(`${pdfPath}.part`, Buffer.from(await r.arrayBuffer()));
      await rename(`${pdfPath}.part`, pdfPath);
      console.log(`curriculum: скачан план ${entry.name}`);
    }
    const parsed = await parse(pdfPath);
    if (!parsed.calendar || !Object.keys(parsed.calendar).length) throw new Error(`план ${entry.name}: не нашёл календарный график`);
    plan = { version: PARSER_VERSION, url: entry.url, name: entry.name, at: Date.now(), ...parsed };
    await writeFile(jsonPath, JSON.stringify(plan));
    plans.set(key, plan);
    return plan;
  })().then((plan) => { failed.delete(prefix); return plan; }, (e) => { if (!/недоступен$/.test(e.message)) failed.set(prefix, { at: Date.now(), error: e.message }); throw e; })
    .finally(() => loading.delete(prefix));
  loading.set(prefix, p);
  return p;
}

// ---------- даты ----------
const DAY = 864e5;
const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);
const parseD = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
export const todayMsk = (now = Date.now()) => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(new Date(now));
/** Начало учебного года, в который попадает дата: 1 сентября (август — ещё прошлый год: каникулы по графику). */
export const yearStartOf = (day) => `${+day.slice(0, 4) - (+day.slice(5, 7) < 9 ? 1 : 0)}-09-01`;
/** Неделя учебного года по графику: 1 — 1–7 сентября, …, 52 — до 31 августа. */
const weekOf = (day, yearStart) => Math.min(52, Math.max(1, Math.floor((parseD(day) - parseD(yearStart)) / (7 * DAY)) + 1));
const weekFrom = (n, yearStart) => fmt(parseD(yearStart) + (n - 1) * 7 * DAY);
const weekTo = (n, yearStart) => (n >= 52 ? `${+yearStart.slice(0, 4) + 1}-08-31` : fmt(parseD(yearStart) + (n * 7 - 1) * DAY));

/** Строка графика → отрезки: [{ kind, label, from, to, weeks: [a, b] }]. */
export function periodsOf(row, yearStart) {
  const out = [];
  let start = 1;
  for (let i = 1; i <= row.length; i++) {
    if (i < row.length && row[i] === row[start - 1]) continue;
    const ch = row[start - 1], [kind, label] = PERIOD[ch] || ["other", ch];
    out.push({ kind, label, from: weekFrom(start, yearStart), to: weekTo(i, yearStart), weeks: [start, i] });
    start = i + 1;
  }
  return out;
}

/** Сессии курса (и следующих курсов) с датами: [{ semester, label, from, to }] — первая Э-полоса курса зимняя, вторая летняя. */
function sessionsFrom(plan, course, yearStart) {
  const out = [];
  for (let c = course; ROMAN[c] && plan.calendar[ROMAN[c]]; c++) {
    const ys = `${+yearStart.slice(0, 4) + (c - course)}-09-01`;
    periodsOf(plan.calendar[ROMAN[c]], ys).filter((p) => p.kind === "exam").forEach((p, i) => {
      out.push({ semester: 2 * c - (i === 0 ? 1 : 0), course: c, label: i === 0 ? "зимняя" : "летняя", from: p.from, to: p.to, weeks: p.weeks });
    });
  }
  return out;
}
const withState = (s, today) => (!s ? null : { ...s, state: today < s.from ? "ahead" : today > s.to ? "past" : "now", days: Math.round((parseD(today < s.from ? s.from : s.to) - parseD(today)) / DAY) });

/**
 * Положение группы в учебном году и её сессия: курс (по году набора в названии группы), семестр (по графику: до конца
 * первых каникул — нечётный), сессия этого семестра и ближайшая не прошедшая, дисциплины семестра с формами контроля.
 * null — у группы нет плана (ошибка в поле error). now — для стенда.
 */
export async function status(group, now = Date.now()) {
  const prefix = prefixOf(group);
  let plan;
  try { plan = await planFor(group); } catch (e) { return { group, prefix, error: e.message }; }
  const today = todayMsk(now), yearStart = yearStartOf(today);
  const admission = plan.program?.admission || 2000 + Number(prefix.slice(-2));
  const course = +yearStart.slice(0, 4) - admission + 1;
  const row = plan.calendar[ROMAN[course]];
  if (!row) return { group, prefix, program: { ...plan.program, url: plan.url }, course, error: course < 1 ? "обучение по плану ещё не началось" : "по плану обучение уже закончено" };
  const periods = periodsOf(row, yearStart), week = weekOf(today, yearStart);
  // Нечётный семестр — до конца каникул после зимней сессии (по графику), дальше чётный.
  const firstExam = periods.findIndex((p) => p.kind === "exam");
  const holidays = periods.find((p, i) => i > firstExam && p.kind === "holiday");
  const odd = !holidays || week <= holidays.weeks[1];
  const semester = 2 * course - (odd ? 1 : 0);
  const all = sessionsFrom(plan, course, yearStart);
  const session = withState(all.find((s) => s.semester === semester) || null, today);
  const upcoming = withState(all.find((s) => s.to >= today) || null, today);
  const subjects = plan.subjects.filter((s) => s.course === course && ((s.controls[String(semester)] || []).length || s.semesters.includes(semester)))
    .map((s) => {
      const controls = s.controls[String(semester)] || [];
      const elective = /^(Б\d\.[А-Я]+\.ДВ\.\d+)\.\d+/.exec(s.index)?.[1] || null;
      return { index: s.index, name: s.name, kind: s.kind, controls, labels: controls.map((c) => LABEL[c] || c), elective,
        exam: controls.includes("Эк"), graded: controls.includes("ЗаО"), pass: controls.includes("За"), coursework: controls.some((c) => c === "КР" || c === "КП") };
    });
  const rank = (s) => (s.exam ? 0 : s.graded ? 1 : s.pass ? 2 : s.coursework ? 3 : 4);
  subjects.sort((a, b) => rank(a) - rank(b) || a.index.localeCompare(b.index));
  // Дисциплины прошлых семестров (с аттестацией): по ним «Сессия» узнаёт академическую разницу после перевода — курс
  // Moodle «История России» у студента 3 курса, когда по плану она на 1-м (Волков, БИВТ-24, 15 окт 2026).
  const earlier = [];
  for (const s of plan.subjects) {
    const sems = Object.entries(s.controls).filter(([k, c]) => +k < semester && c.length).map(([k]) => +k);
    if (sems.length && !earlier.some((x) => x.index === s.index && x.name === s.name)) earlier.push({ index: s.index, name: s.name, kind: s.kind, semesters: sems });
    else if (sems.length) earlier.find((x) => x.index === s.index && x.name === s.name).semesters.push(...sems);
  }
  // Счётчики — по сырому плану (все варианты дисциплин по выбору); настоящие считает admission.arrange.
  const counts = { exam: 0, graded: 0, pass: 0, coursework: 0, none: 0 };
  for (const s of subjects) { if (s.exam) counts.exam++; if (s.graded) counts.graded++; if (s.pass) counts.pass++; if (s.coursework) counts.coursework++; if (!s.controls.length) counts.none++; }
  return { group, prefix, program: { ...plan.program, url: plan.url, name: plan.name }, course, semester, yearStart, week, periods, session, upcoming, subjects, earlier, counts, planAt: plan.at };
}

/** Короткая сводка для сообщений бота: «3 экзамена, 5 зачётов с оценкой, 2 курсовые». */
export function countsText(counts) {
  const n = (k, one, few, many) => (counts[k] ? `${counts[k]} ${counts[k] % 10 === 1 && counts[k] % 100 !== 11 ? one : counts[k] % 10 >= 2 && counts[k] % 10 <= 4 && (counts[k] % 100 < 10 || counts[k] % 100 >= 20) ? few : many}` : "");
  return [n("exam", "экзамен", "экзамена", "экзаменов"), n("graded", "зачёт с оценкой", "зачёта с оценкой", "зачётов с оценкой"), n("pass", "зачёт", "зачёта", "зачётов"), n("coursework", "курсовая", "курсовые", "курсовых")].filter(Boolean).join(", ");
}
