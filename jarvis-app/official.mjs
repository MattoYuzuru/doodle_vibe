// Официальное расписание МИСИС: misis.ru/students/schedule/ выкладывает файлы Excel по институтам на весь семестр
// (верхняя и нижняя неделя, подгруппы, аудитории). «Дневач» показывает только текущую неделю — следующие недели
// приложение строит отсюда (просьба владельца, 3 окт 2026). Группа пользователя ищется сама во всех файлах.
//
// Файлы проверяются раз в 6 часов: новый файл института (в имени дата: itkn-011026.xls) скачивается и разбирается
// schedule_xls.py (xlrd/openpyxl), результат лежит рядом (schedule-cache/official/<файл>.json) и переживает перезапуск
// и недоступность сайта. Какая неделя верхняя, сверяется с «Дневачом» (calibrate); пока сверки нет — по правилу
// «неделя с 1 сентября — первая, нечётные — верхние».
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const CACHE = join(DIR, "schedule-cache", "official");
const INDEX = process.env.MISIS_SCHEDULE_INDEX || "https://misis.ru/students/schedule/";
const SITE = new URL(INDEX).origin;
const PARSER = join(DIR, "schedule_xls.py");
const PARSER_VERSION = 1; // меняется — все файлы разбираются заново
const REFRESH_MS = 6 * 3600e3, RETRY_MS = 15 * 60e3;
const UA = { "user-agent": "Mozilla/5.0 (Doodle mini app)" };

// Группы в разных источниках пишут то кириллицей, то латиницей («RPA», «БИСТ»): сравниваем по кириллическому виду.
const LAT = { A: "А", B: "В", C: "С", E: "Е", H: "Н", K: "К", M: "М", O: "О", P: "Р", T: "Т", X: "Х", Y: "У" };
export const normGroup = (g) => String(g || "").toUpperCase().replace(/\s+/g, "").replace(/[ABCEHKMOPTXY]/g, (ch) => LAT[ch]);

let state = { at: 0, files: [], groups: new Map(), institutes: {} }; // groups: норм. имя → { group, file, stamp, lessons }; institutes: институт (из имени файла) → название
let loading = null, lastTry = 0;

function python() {
  for (const p of [process.env.PYTHON, "C:\\Program Files\\Python312\\python.exe"]) if (p && existsSync(p)) return p;
  return "python";
}
function parse(file) {
  return new Promise((resolve, reject) => {
    // xlrd и openpyxl стоят в пользовательской папке Python (pip install --user): находим её по настоящему профилю, даже
    // если у процесса подменён APPDATA (так на стенде).
    const env = { ...process.env, PYTHONUSERBASE: process.env.PYTHONUSERBASE || join(userInfo().homedir, "AppData", "Roaming", "Python"), PYTHONIOENCODING: "utf-8" };
    const p = spawn(python(), [PARSER, file], { windowsHide: true, env });
    const out = [], err = [];
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => err.push(d));
    p.on("error", reject);
    p.on("close", (code) => {
      if (code) return reject(new Error(`schedule_xls.py: ${Buffer.concat(err).toString("utf8").trim().split("\n").pop() || `код ${code}`}`));
      try { resolve(JSON.parse(Buffer.concat(out).toString("utf8"))); } catch (e) { reject(e); }
    });
  });
}

/** «itkn-011026.xls» → { inst: "itkn", stamp: "2026-10-01" } — институт и дата выкладки из имени файла. */
function stampOf(name) {
  const m = /^(.*?)-(\d{2})(\d{2})(\d{2})\.xlsx?$/i.exec(name);
  return m ? { inst: m[1], stamp: `20${m[4]}-${m[3]}-${m[2]}` } : { inst: name.replace(/\.xlsx?$/i, ""), stamp: "" };
}

async function load() {
  await mkdir(CACHE, { recursive: true });
  let links = null;
  // Названия институтов — из текста ссылок на файлы («Институт компьютерных наук»): нужны для титульного листа отчётов.
  const INSTITUTES = join(CACHE, "institutes.json");
  const institutes = await readFile(INSTITUTES, "utf8").then(JSON.parse).catch(() => ({}));
  try {
    const html = await fetch(INDEX, { headers: UA, signal: AbortSignal.timeout(25000) }).then((r) => { if (!r.ok) throw new Error(`misis.ru ${r.status}`); return r.text(); });
    links = [...new Set([...html.matchAll(/href="([^"]+\.xlsx?)"/gi)].map((m) => m[1]))].map((href) => new URL(href, SITE).href);
    for (const m of html.matchAll(/<a[^>]+href="([^"]+\.xlsx?)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const title = m[2].replace(/<[^>]+>/g, " ").replace(/­/g, "").replace(/\s+/g, " ").trim();
      if (title) institutes[stampOf(decodeURIComponent(m[1].split("/").pop())).inst] = title;
    }
    await writeFile(INSTITUTES, JSON.stringify(institutes)).catch(() => {});
  } catch (e) { console.log(`official: список файлов не получен (${e.message}), беру сохранённые`); }
  // Файлы, которые надо иметь: со страницы (по одному, самому новому, на институт) или, если страница недоступна, — что уже есть.
  const want = new Map(); // институт → { name, url }
  const names = links ? links.map((u) => ({ name: decodeURIComponent(u.split("/").pop()), url: u }))
    : (await readdir(CACHE).catch(() => [])).filter((n) => /\.xlsx?$/i.test(n)).map((name) => ({ name, url: null }));
  for (const f of names) {
    const { inst, stamp } = stampOf(f.name);
    const cur = want.get(inst);
    if (!cur || stampOf(cur.name).stamp < stamp) want.set(inst, f);
  }
  const groups = new Map(), files = [];
  for (const [inst, f] of want) {
    const path = join(CACHE, f.name), jsonPath = `${path}.json`;
    try {
      if (!existsSync(path)) {
        if (!f.url) continue;
        const r = await fetch(f.url, { headers: UA, signal: AbortSignal.timeout(60000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const tmp = `${path}.part`;
        await writeFile(tmp, Buffer.from(await r.arrayBuffer()));
        await rename(tmp, path);
        console.log(`official: скачан ${f.name}`);
      }
      let parsed = await readFile(jsonPath, "utf8").then(JSON.parse).catch(() => null);
      if (!parsed || parsed.version !== PARSER_VERSION) {
        parsed = { version: PARSER_VERSION, ...(await parse(path)) };
        await writeFile(jsonPath, JSON.stringify(parsed));
      }
      // Прежние выкладки этого института больше не нужны.
      for (const old of await readdir(CACHE).catch(() => [])) {
        if (old !== f.name && old !== `${f.name}.json` && stampOf(old.replace(/\.json$/, "")).inst === inst) await rm(join(CACHE, old), { force: true });
      }
      files.push({ name: f.name, inst, stamp: stampOf(f.name).stamp, groups: Object.keys(parsed.groups).length, skipped: parsed.skipped });
      for (const [g, lessons] of Object.entries(parsed.groups)) groups.set(normGroup(g), { group: g, file: f.name, stamp: stampOf(f.name).stamp, lessons });
    } catch (e) { console.log(`official: ${f.name}: ${e.message}`); }
  }
  if (groups.size) state = { at: Date.now(), files, groups, institutes };
  return state;
}

/**
 * Актуальные данные (раз в 6 часов перечитываются; сбой — следующая попытка через 15 минут). wait=false — не ждать
 * первой загрузки (скачать и разобрать девять файлов — до полминуты): вернуть, что есть, загрузка идёт в фоне.
 */
async function current(wait = true) {
  const empty = !state.groups.size, stale = Date.now() - state.at > REFRESH_MS;
  // После неудачной попытки — пауза: без данных минута, с данными 15 минут.
  if ((empty || stale) && !loading && Date.now() - lastTry > (empty ? 60e3 : RETRY_MS)) {
    lastTry = Date.now();
    loading = load().catch((e) => { console.log(`official: ${e.message}`); return state; }).finally(() => { loading = null; });
  }
  if (empty && wait && loading) await loading;
  return state;
}
// Сразу после запуска сервера — подготовить файлы, чтобы первый запрос расписания их уже застал.
setTimeout(() => void current().catch(() => {}), 5000).unref();

/**
 * Группа в официальном расписании — для титульного листа отчётов: институт (название со страницы misis.ru), файл, дата
 * выкладки и шаблон пар (у каждой пары — предмет, тип, преподаватель, подгруппа: «» — вся группа). null — группы нет.
 */
export async function groupInfo(group) {
  const s = await current();
  const g = s.groups.get(normGroup(group));
  if (!g) return null;
  return { group: g.group, institute: s.institutes?.[stampOf(g.file).inst] || null, file: g.file, stamp: g.stamp, lessons: g.lessons };
}

export async function groups() {
  return [...(await current()).groups.values()].map((g) => g.group);
}

// ---------- даты ----------
const DAY = 864e5;
const parseD = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10));
const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);
export const mondayOf = (s) => { const t = parseD(s), wd = (new Date(t).getUTCDay() + 6) % 7; return fmt(t - wd * DAY); };
const addDays = (s, n) => fmt(parseD(s) + n * DAY);
export const todayMsk = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Moscow" }).format(new Date());
// Государственные праздники (без переносов): в эти дни занятий нет.
const HOLIDAYS = new Set(["01-01", "01-02", "01-03", "01-04", "01-05", "01-06", "01-07", "01-08", "02-23", "03-08", "05-01", "05-09", "06-12", "11-04", "12-31"]);
/** Учебный семестр, в который попадает дата: осень — сентябрь…декабрь, весна — февраль…июнь. Вне семестра пар нет. */
function inSemester(s) {
  const mo = +s.slice(5, 7), md = s.slice(5);
  return (mo >= 9 && md <= "12-30") || (mo >= 2 && mo <= 6);
}

// ---------- верхняя/нижняя неделя ----------
const PARITY = join(CACHE, "parity.json");
let parity = null; // { monday, row } — неделя monday идёт по строке row (0 — верхняя)
async function parityRef() {
  if (!parity) parity = await readFile(PARITY, "utf8").then(JSON.parse).catch(() => null);
  return parity;
}
/** Правило по умолчанию: неделя, в которую попадает 1 сентября (весной — 1 февраля), — первая; нечётные — верхние. */
function defaultRow(date) {
  const y = +date.slice(0, 4), mo = +date.slice(5, 7);
  const start = mondayOf(mo >= 8 ? `${y}-09-01` : `${y}-02-01`);
  const n = Math.floor((parseD(mondayOf(date)) - parseD(start)) / (7 * DAY));
  return ((n % 2) + 2) % 2; // неделя 1 (n = 0) — верхняя
}
async function rowOf(date) {
  const ref = await parityRef();
  if (!ref) return defaultRow(date);
  const n = Math.round((parseD(mondayOf(date)) - parseD(ref.monday)) / (7 * DAY));
  return (((ref.row + n) % 2) + 2) % 2;
}

const key = (name) => String(name || "").toLowerCase().replace(/ё/g, "е").replace(/[^\p{L}\p{N}]/gu, "").slice(0, 14);
/**
 * Сверка с «Дневачом»: пары группы за неделю, где они есть на «Дневаче», сравниваются с верхними и нижними строками
 * файла (день, время начала, предмет). Какие совпали лучше — та и эта неделя. Результат общий для всего университета.
 */
export async function calibrate(group, dnevLessons) {
  const g = (await current()).groups.get(normGroup(group));
  if (!g || !dnevLessons?.length) return;
  const byWeek = new Map();
  for (const l of dnevLessons) (byWeek.get(mondayOf(l.date)) || byWeek.set(mondayOf(l.date), []).get(mondayOf(l.date))).push(l);
  for (const [monday, lessons] of byWeek) {
    if (lessons.length < 3) continue;
    const score = [0, 1].map((row) => lessons.filter((l) => {
      const wd = (new Date(parseD(l.date)).getUTCDay() + 6) % 7;
      return g.lessons.some((t) => t.week === row && t.wd === wd && t.start === l.start && key(t.name) === key(l.name));
    }).length);
    const row = score[0] > score[1] ? 0 : score[1] > score[0] ? 1 : null;
    if (row === null || Math.max(...score) < Math.ceil(lessons.length / 2)) continue;
    const ref = await parityRef();
    const expected = ref ? (((ref.row + Math.round((parseD(monday) - parseD(ref.monday)) / (7 * DAY))) % 2) + 2) % 2 : null;
    if (expected !== row) {
      parity = { monday, row, group, at: Date.now() };
      await mkdir(CACHE, { recursive: true });
      await writeFile(PARITY, JSON.stringify(parity));
      console.log(`official: неделя ${monday} — ${row ? "нижняя" : "верхняя"} (сверка по группе ${group}: ${score.join("/")})`);
    }
    return;
  }
}

/**
 * Пары группы по официальному расписанию на weeks недель, начиная с понедельника from: { group, file, stamp, lessons }
 * или null, если группы нет в файлах. Праздники и даты вне семестра пропускаются, пары «с … по …» — только в свои даты.
 */
export async function lessonsFor(group, from, weeks, { wait = true } = {}) {
  const g = (await current(wait)).groups.get(normGroup(group));
  if (!g) return null;
  const out = [];
  for (let d = 0; d < weeks * 7; d++) {
    const date = addDays(from, d);
    if (HOLIDAYS.has(date.slice(5)) || !inSemester(date)) continue;
    const wd = d % 7, row = await rowOf(date);
    for (const t of g.lessons) {
      if (t.wd !== wd || t.week !== row) continue;
      if ((t.from && date < t.from) || (t.to && date > t.to) || (t.dates && !t.dates.includes(date))) continue;
      out.push({ date, start: t.start, end: t.end, name: t.name, type: t.type, typeLabel: t.typeLabel, teacher: t.teacher, place: t.place, subgroup: t.subgroup, source: "official" });
    }
  }
  return { group: g.group, file: g.file, stamp: g.stamp, lessons: out };
}
